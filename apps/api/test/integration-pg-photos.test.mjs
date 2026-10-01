// R1 照片用途与药盒封面的真实 PostgreSQL 验证（独立进程，避免登录限流共享配额）。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { PrivatePhotoStore } from "../dist/services/private-photo-store.js";
import { createReminderTemplateConfig } from "../dist/services/subscribe-messages.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres } from "./helpers/isolated-pg.mjs";

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
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(pool);
    app = await buildServer({
      database,
      wechatGateway: gateway,
      privatePhotoStore: new PrivatePhotoStore(photoRoot),
      reminderTemplateConfig: createReminderTemplateConfig({
        appId: "synthetic-app-id",
        appSecret: "synthetic-secret",
        templateId: "synthetic-reminder-template",
      }),
      logger: { level: "error" },
    });
    const request = (user, method, path, payload) => app.inject({ method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${user.token}` }, ...(payload === undefined ? {} : { payload }) });
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
