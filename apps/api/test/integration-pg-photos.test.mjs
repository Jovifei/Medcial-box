// R1 照片用途与药盒封面的真实 PostgreSQL 验证（独立进程，避免登录限流共享配额）。
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { PrivatePhotoStore } from "../dist/services/private-photo-store.js";
import { createReminderTemplateConfig } from "../dist/services/subscribe-messages.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { bounded, contend, isolatedPostgres, signal } from "./helpers/isolated-pg.mjs";

// 1×1 PNG：满足服务端的签名与 IEND 结尾校验。
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
  return expected === 204 ? null : response.json();
}

test("real PostgreSQL: photo purposes and box-front cover (R1)", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
  concurrency: 1,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL; real PostgreSQL cannot be skipped");
  const fixture = await isolatedPostgres(url);
  const { pool, database } = fixture;
  const photoRoot = await mkdtemp(join(tmpdir(), "medbox-photo-test-"));
  const photoStore = new PrivatePhotoStore(photoRoot);
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(pool);
    app = await buildServer({
      database,
      wechatGateway: gateway,
      privatePhotoStore: photoStore,
      reminderTemplateConfig: createReminderTemplateConfig({
        appId: "synthetic-app-id",
        appSecret: "synthetic-secret",
        templateId: "synthetic-reminder-template",
      }),
      logger: { level: "error" },
    });
    const request = (user, method, path, payload, extraHeaders = {}) => app.inject({ method, url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${user.token}`, ...extraHeaders }, ...(payload === undefined ? {} : { payload }) });
    async function family() {
      const code = randomUUID();
      gateway.registerCode(code, `photo-${code}`);
      const auth = status(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      const owner = { token: auth.token, id: auth.user.id };
      const created = status(await request(owner, "POST", "/families", { name: `家庭-${randomUUID()}` }), 201);
      owner.membershipId = created.membership.id;
      return { owner, id: created.family.id };
    }
    async function upload(user, medicineId, payload) {
      const response = await request(user, "POST", `/medicines/${medicineId}/leaflet-photos`, {
        imageBase64: PNG_BASE64,
        mimeType: "image/png",
        ...payload,
      });
      assert.ok(response.statusCode === 200 || response.statusCode === 201, response.body);
      return response.json().photo;
    }

    await t.test("migration 015 adds purposes, batch binding and a cover reference", async () => {
      const columns = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'medicine_leaflet_photos' AND column_name = ANY($2::text[])
         ORDER BY column_name`,
        [fixture.schema, ["batch_id", "purpose"]],
      );
      assert.deepEqual(columns.rows.map((row) => row.column_name), ["batch_id", "purpose"]);
      const cover = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'medicines' AND column_name = 'cover_photo_id'`,
        [fixture.schema],
      );
      assert.equal(cover.rowCount, 1);
    });

    await t.test("box-front photo becomes the cover; leaflet and expiry photos cannot", async () => {
      const { owner } = await family();
      const medicine = status(await request(owner, "POST", "/medicines", {
        name: "拍照封面药",
        batches: [{ lotNumber: "B1", quantity: 2, unit: "box" }],
      }), 201);
      const batchId = medicine.batches[0].id;

      const front = await upload(owner, medicine.id, { purpose: "box_front", source: "box_photo" });
      const leaflet = await upload(owner, medicine.id, { purpose: "leaflet" });
      const expiry = await upload(owner, medicine.id, { purpose: "expiry", batchId });
      assert.equal(front.purpose, "box_front");
      assert.equal(leaflet.purpose, "leaflet");
      assert.equal(expiry.purpose, "expiry");
      assert.equal(expiry.batchId, batchId, "有效期照片绑定到具体库存批次");

      // 设为封面
      const cover = status(await request(owner, "POST", `/medicines/${medicine.id}/cover-photo`, { photoId: front.id }), 200);
      assert.equal(cover.coverPhotoId, front.id);
      const reopened = status(await request(owner, "GET", `/medicines/${medicine.id}`), 200);
      assert.equal(reopened.coverPhotoId, front.id, "封面出现在药品详情上");

      // 说明书与有效期照片不能当封面
      for (const ineligible of [leaflet.id, expiry.id]) {
        const rejected = await request(owner, "POST", `/medicines/${medicine.id}/cover-photo`, { photoId: ineligible });
        assert.equal(rejected.statusCode, 400, rejected.body);
      }

      // 取消封面
      const cleared = status(await request(owner, "POST", `/medicines/${medicine.id}/cover-photo`, { photoId: null }), 200);
      assert.equal(cleared.coverPhotoId, null);
      assert.equal(status(await request(owner, "GET", `/medicines/${medicine.id}`), 200).coverPhotoId, null);
    });

    await t.test("cover version serializes concurrent choices, preserves legacy writes, and lets lost responses be reconciled", async () => {
      const { owner } = await family();
      const medicine = status(await request(owner, "POST", "/medicines", { name: "封面并发测试药", batches: [] }), 201);
      const first = await upload(owner, medicine.id, { purpose: "box_front" });
      const second = await upload(owner, medicine.id, { purpose: "box_front" });
      const path = `/medicines/${medicine.id}/cover-photo`;
      const writes = await contend(fixture,
        /SELECT id FROM families WHERE id = \$1 FOR (?:NO KEY )?UPDATE/,
        () => request(owner, "POST", path, { photoId: first.id, version: medicine.version }),
        () => request(owner, "POST", path, { photoId: second.id, version: medicine.version }));
      const applied = status(writes[0], 200);
      assert.equal(writes[1].statusCode, 409, "a later stale cover selection must not replace the first choice");
      assert.deepEqual(applied, { coverPhotoId: first.id, version: medicine.version + 1 });
      assert.equal(status(writes[1], 409).error.code, "VERSION_CONFLICT");
      let current = status(await request(owner, "GET", `/medicines/${medicine.id}`), 200);
      assert.equal(current.coverPhotoId, first.id);
      assert.equal(current.version, medicine.version + 1, "conflict must not write or advance version");

      for (const version of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal((await request(owner, "POST", path, { photoId: second.id, version })).statusCode, 400);
      }
      current = status(await request(owner, "GET", `/medicines/${medicine.id}`), 200);
      assert.equal(current.coverPhotoId, first.id);
      assert.equal(current.version, applied.version);

      const legacy = status(await request(owner, "POST", path, { photoId: second.id }), 200);
      assert.deepEqual(legacy, { coverPhotoId: second.id, version: applied.version + 1 });
      const legacyRepeat = status(await request(owner, "POST", path, { photoId: second.id }), 200);
      assert.equal(legacyRepeat.version, legacy.version + 1, "legacy calls retain their existing increment behavior");

      // Discard the success body like a lost HTTP response; read current state before a retry.
      assert.equal((await request(owner, "POST", path, { photoId: first.id, version: legacyRepeat.version })).statusCode, 200);
      current = status(await request(owner, "GET", `/medicines/${medicine.id}`), 200);
      assert.equal(current.coverPhotoId, first.id);
      assert.equal(current.version, legacyRepeat.version + 1);
      assert.equal(status(await request(owner, "POST", path, { photoId: first.id, version: legacyRepeat.version }), 409).error.code, "VERSION_CONFLICT");
      const afterRetry = status(await request(owner, "GET", `/medicines/${medicine.id}`), 200);
      assert.equal(afterRetry.coverPhotoId, current.coverPhotoId);
      assert.equal(afterRetry.version, current.version);
    });

    for (const operation of ["cover", "delete"]) {
      for (const change of ["switch", "revocation"]) {
        await t.test(`${operation} denies a ${change} that happens while waiting for the family lock`, async () => {
          const household = await family();
          const medicine = status(await request(household.owner, "POST", "/medicines", { name: "身份锁合成药", batches: [] }), 201);
          const front = await upload(household.owner, medicine.id, { purpose: "box_front" });
          const code = randomUUID();
          gateway.registerCode(code, `photo-member-${code}`);
          const auth = status(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
          const member = { token: auth.token, id: auth.user.id };
          await pool.query("INSERT INTO family_members (family_id,user_id,role) VALUES ($1,$2,'member')", [household.id, member.id]);
          await pool.query("UPDATE sessions SET active_family_id = $1 WHERE user_id = $2", [household.id, member.id]);
          const lock = /SELECT id FROM families WHERE id = \$1 FOR (?:NO KEY )?UPDATE/;
          const [, attempted] = await contend(fixture, lock,
            () => database.withTransaction(async (tx) => {
              await tx.query("SELECT id FROM families WHERE id = $1 FOR UPDATE", [household.id]);
              if (change === "switch") await tx.query("UPDATE sessions SET active_family_id = NULL WHERE user_id = $1", [member.id]);
              else await tx.query("DELETE FROM family_members WHERE family_id = $1 AND user_id = $2", [household.id, member.id]);
            }),
            () => operation === "cover"
              ? request(member, "POST", `/medicines/${medicine.id}/cover-photo`, { photoId: front.id, version: medicine.version })
              : request(member, "DELETE", `/medicines/${medicine.id}/leaflet-photos/${front.id}`));
          assert.equal(attempted.statusCode, 404);
          const current = status(await request(household.owner, "GET", `/medicines/${medicine.id}`), 200);
          assert.equal(current.coverPhotoId, null);
          assert.equal(current.version, medicine.version);
          assert.equal((await request(household.owner, "GET", `/medicines/${medicine.id}/leaflet-photos/${front.id}`)).statusCode, 200);
        });
      }
    }

    await t.test("deleting a photo before a waiting cover update prevents it becoming the cover", async () => {
      const { owner } = await family();
      const medicine = status(await request(owner, "POST", "/medicines", { name: "删除封面竞争药", batches: [] }), 201);
      const front = await upload(owner, medicine.id, { purpose: "box_front" });
      const [deleted, cover] = await contend(fixture, /SELECT id FROM families WHERE id = \$1 FOR (?:NO KEY )?UPDATE/,
        () => request(owner, "DELETE", `/medicines/${medicine.id}/leaflet-photos/${front.id}`),
        () => request(owner, "POST", `/medicines/${medicine.id}/cover-photo`, { photoId: front.id, version: medicine.version }));
      assert.equal(deleted.statusCode, 204);
      assert.equal(cover.statusCode, 400);
      const current = status(await request(owner, "GET", `/medicines/${medicine.id}`), 200);
      assert.equal(current.coverPhotoId, null);
      assert.equal(current.version, medicine.version);
    });

    await t.test("upload rejects a revoked member after waiting for the family lock", async () => {
      const household = await family();
      const medicine = status(await request(household.owner, "POST", "/medicines", { name: "撤权上传药", batches: [] }), 201);
      const code = randomUUID();
      gateway.registerCode(code, `upload-member-${code}`);
      const auth = status(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      const member = { token: auth.token, id: auth.user.id };
      await pool.query("INSERT INTO family_members (family_id,user_id,role) VALUES ($1,$2,'member')", [household.id, member.id]);
      await pool.query("UPDATE sessions SET active_family_id=$1 WHERE user_id=$2", [household.id, member.id]);
      const [, denied] = await contend(fixture, /SELECT id FROM families WHERE id = \$1 FOR (?:NO KEY )?UPDATE/,
        () => database.withTransaction(async (tx) => {
          await tx.query("SELECT id FROM families WHERE id = $1 FOR UPDATE", [household.id]);
          await tx.query("DELETE FROM family_members WHERE family_id = $1 AND user_id = $2", [household.id, member.id]);
        }), () => request(member, "POST", `/medicines/${medicine.id}/leaflet-photos`, {
          imageBase64: PNG_BASE64, mimeType: "image/png", purpose: "box_front", uploadIntentKey: randomUUID().replaceAll("-", ""),
        }));
      assert.equal(denied.statusCode, 404);
      assert.equal(status(await request(household.owner, "GET", `/medicines/${medicine.id}/leaflet-photos`), 200).photos.length, 0);
    });

    await t.test("logout while photo bytes are being written prevents activation and removes the reserved file", async () => {
      const household = await family();
      const medicine = status(await request(household.owner, "POST", "/medicines", { name: "注销上传药", batches: [] }), 201);
      const code = randomUUID();
      gateway.registerCode(code, `upload-logout-${code}`);
      const auth = status(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      const member = { token: auth.token, id: auth.user.id };
      await pool.query("INSERT INTO family_members (family_id,user_id,role) VALUES ($1,$2,'member')", [household.id, member.id]);
      await pool.query("UPDATE sessions SET active_family_id=$1 WHERE user_id=$2", [household.id, member.id]);
      const started = signal();
      const release = signal();
      const originalSave = photoStore.save.bind(photoStore);
      let pending;
      photoStore.save = async (input) => {
        const storedKey = await originalSave(input);
        started.resolve(storedKey);
        await bounded(release.promise, "release synthetic photo write");
        return storedKey;
      };
      try {
        pending = request(member, "POST", `/medicines/${medicine.id}/leaflet-photos`, {
          imageBase64: PNG_BASE64, mimeType: "image/png", purpose: "box_front", uploadIntentKey: randomUUID().replaceAll("-", ""),
        });
        const storedKey = await bounded(started.promise, "synthetic photo bytes saved");
        await pool.query("DELETE FROM sessions WHERE user_id=$1", [member.id]);
        release.resolve();
        assert.equal((await pending).statusCode, 404);
        const rows = await pool.query(`SELECT upload_completed_at, storage_removed_at FROM medicine_leaflet_photos
          WHERE family_id=$1 AND medicine_id=$2`, [household.id, medicine.id]);
        assert.equal(rows.rows.length, 1);
        assert.equal(rows.rows[0].upload_completed_at, null);
        assert.ok(rows.rows[0].storage_removed_at);
        await assert.rejects(() => photoStore.read(storedKey));
      } finally {
        release.resolve();
        if (pending) await pending.catch(() => undefined);
        photoStore.save = originalSave;
      }
    });

    await t.test("a medicine already sent to trash cannot lose its photo to a waiting delete", async () => {
      const household = await family();
      const medicine = status(await request(household.owner, "POST", "/medicines", { name: "回收站照片保全药", batches: [] }), 201);
      const front = await upload(household.owner, medicine.id, { purpose: "box_front" });
      const [ignored, deletion] = await contend(fixture, /FROM medicines WHERE id = \$1 AND family_id = \$2 AND deleted_at IS NULL FOR UPDATE/,
        () => database.withTransaction(async (tx) => {
          await tx.query("SELECT id FROM medicines WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL FOR UPDATE", [medicine.id, household.id]);
          await tx.query("UPDATE medicines SET deleted_at=now() WHERE id=$1 AND family_id=$2", [medicine.id, household.id]);
        }), () => request(household.owner, "DELETE", `/medicines/${medicine.id}/leaflet-photos/${front.id}`));
      assert.equal(ignored, undefined);
      assert.equal(deletion.statusCode, 404);
      const row = await pool.query("SELECT deleted_at,storage_removed_at,storage_key FROM medicine_leaflet_photos WHERE id=$1", [front.id]);
      assert.equal(row.rows[0].deleted_at, null);
      assert.equal(row.rows[0].storage_removed_at, null);
      assert.ok((await photoStore.read(row.rows[0].storage_key)).length > 0);
    });

    await t.test("explicit family scope stays in the original family on switch, but not after revocation or logout", async (group) => {
      const original = await family();
      const next = await family();
      const sentinel = status(await request(next.owner, "POST", "/medicines", { name: "另一家庭哨兵", batches: [] }), 201);
      for (const operation of ["cover", "delete", "upload"]) {
        for (const change of ["switch", "revocation", "logout"]) {
          await group.test(`${operation} with explicit family after ${change}`, async () => {
            const med = status(await request(original.owner, "POST", "/medicines", { name: "固定家庭样本药", batches: [] }), 201);
            const front = operation === "upload" ? null : await upload(original.owner, med.id, { purpose: "box_front" });
            const token = randomBytes(32).toString("hex");
            const user = (await pool.query("INSERT INTO users (openid) VALUES ($1) RETURNING id", [`scope-${randomUUID()}`])).rows[0];
            await pool.query("INSERT INTO family_members (family_id,user_id,role) VALUES ($1,$3,'member'),($2,$3,'member')", [original.id, next.id, user.id]);
            await pool.query(`INSERT INTO sessions (user_id,token_hash,expires_at,active_family_id)
              VALUES ($1,$2,now() + interval '1 day',$3)`, [user.id, createHash("sha256").update(token).digest("hex"), original.id]);
            const member = { token, id: user.id };
            const scoped = { "x-family-id": original.id };
            const [, response] = await contend(fixture, /SELECT id FROM families WHERE id = \$1 FOR (?:NO KEY )?UPDATE/,
              () => database.withTransaction(async (tx) => {
                await tx.query("SELECT id FROM families WHERE id = $1 FOR UPDATE", [original.id]);
                if (change === "switch") await tx.query("UPDATE sessions SET active_family_id=$1 WHERE user_id=$2", [next.id, user.id]);
                else if (change === "revocation") await tx.query("DELETE FROM family_members WHERE family_id=$1 AND user_id=$2", [original.id, user.id]);
                else await tx.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
              }), () => operation === "cover"
                ? request(member, "POST", `/medicines/${med.id}/cover-photo`, { photoId: front.id, version: med.version }, scoped)
                : operation === "delete"
                  ? request(member, "DELETE", `/medicines/${med.id}/leaflet-photos/${front.id}`, undefined, scoped)
                  : request(member, "POST", `/medicines/${med.id}/leaflet-photos`, {
                    imageBase64: PNG_BASE64, mimeType: "image/png", purpose: "box_front", uploadIntentKey: randomUUID().replaceAll("-", ""),
                  }, scoped));
            assert.equal(response.statusCode, change === "switch" ? ({ cover: 200, delete: 204, upload: 201 })[operation] : 404);
            const current = status(await request(original.owner, "GET", `/medicines/${med.id}`), 200);
            if (operation === "cover") {
              assert.equal(current.coverPhotoId, change === "switch" ? front.id : null);
              assert.equal(current.version, med.version + (change === "switch" ? 1 : 0));
            } else if (operation === "delete") {
              assert.equal((await request(original.owner, "GET", `/medicines/${med.id}/leaflet-photos/${front.id}`)).statusCode,
                change === "switch" ? 404 : 200);
            } else {
              const list = status(await request(original.owner, "GET", `/medicines/${med.id}/leaflet-photos`), 200);
              assert.equal(list.photos.length, change === "switch" ? 1 : 0);
            }
            const nextCurrent = status(await request(next.owner, "GET", `/medicines/${sentinel.id}`), 200);
            assert.equal(nextCurrent.version, sentinel.version);
            assert.equal(nextCurrent.coverPhotoId, null);
          });
        }
      }
    });

    await t.test("expiry photos require a batch that belongs to the same medicine", async () => {
      const { owner } = await family();
      const first = status(await request(owner, "POST", "/medicines", {
        name: "第一批次药", batches: [{ lotNumber: "A", quantity: 1, unit: "box" }],
      }), 201);
      const second = status(await request(owner, "POST", "/medicines", {
        name: "第二批次药", batches: [{ lotNumber: "B", quantity: 1, unit: "box" }],
      }), 201);

      const missingBatch = await request(owner, "POST", `/medicines/${first.id}/leaflet-photos`, {
        imageBase64: PNG_BASE64, mimeType: "image/png", purpose: "expiry",
      });
      assert.equal(missingBatch.statusCode, 400, missingBatch.body);

      const foreignBatch = await request(owner, "POST", `/medicines/${first.id}/leaflet-photos`, {
        imageBase64: PNG_BASE64, mimeType: "image/png", purpose: "expiry", batchId: second.batches[0].id,
      });
      assert.equal(foreignBatch.statusCode, 404, foreignBatch.body);
    });

    await t.test("photos list filters by purpose and reports the cover", async () => {
      const { owner } = await family();
      const medicine = status(await request(owner, "POST", "/medicines", {
        name: "列表过滤药", batches: [{ quantity: 1, unit: "box" }],
      }), 201);
      const front = await upload(owner, medicine.id, { purpose: "box_front" });
      await upload(owner, medicine.id, { purpose: "leaflet" });
      status(await request(owner, "POST", `/medicines/${medicine.id}/cover-photo`, { photoId: front.id }), 200);

      const all = status(await request(owner, "GET", `/medicines/${medicine.id}/leaflet-photos`), 200);
      assert.equal(all.photos.length, 2);
      assert.equal(all.coverPhotoId, front.id);

      const fronts = status(await request(owner, "GET", `/medicines/${medicine.id}/leaflet-photos?purpose=box_front`), 200);
      assert.equal(fronts.photos.length, 1);
      assert.equal(fronts.photos[0].id, front.id);

      const leaflets = status(await request(owner, "GET", `/medicines/${medicine.id}/leaflet-photos?purpose=leaflet`), 200);
      assert.equal(leaflets.photos.length, 1);
      assert.equal(leaflets.photos[0].purpose, "leaflet");
    });

    await t.test("another family's photo cannot be used as a cover", async () => {
      const first = await family();
      const second = await family();
      const mine = status(await request(first.owner, "POST", "/medicines", {
        name: "我的药", batches: [{ quantity: 1, unit: "box" }],
      }), 201);
      const theirs = status(await request(second.owner, "POST", "/medicines", {
        name: "别人的药", batches: [{ quantity: 1, unit: "box" }],
      }), 201);
      const theirFront = await upload(second.owner, theirs.id, { purpose: "box_front" });

      const rejected = await request(first.owner, "POST", `/medicines/${mine.id}/cover-photo`, { photoId: theirFront.id });
      assert.equal(rejected.statusCode, 400, rejected.body);
      // 也不允许跨药品：另一个药品自己的照片同样不能挂到这个药品上。
      const ownSecond = status(await request(first.owner, "POST", "/medicines", {
        name: "我的第二个药", batches: [{ quantity: 1, unit: "box" }],
      }), 201);
      const otherFront = await upload(first.owner, ownSecond.id, { purpose: "box_front" });
      const crossMedicine = await request(first.owner, "POST", `/medicines/${mine.id}/cover-photo`, { photoId: otherFront.id });
      assert.equal(crossMedicine.statusCode, 400, crossMedicine.body);
    });
  } finally {
    if (app !== undefined) await app.close();
    await fixture.close();
    await rm(photoRoot, { recursive: true, force: true });
  }
});
