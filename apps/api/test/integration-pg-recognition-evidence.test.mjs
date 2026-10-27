import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { PrivatePhotoStore } from "../dist/services/private-photo-store.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { contend, isolatedPostgres } from "./helpers/isolated-pg.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";

test("recognition evidence persists, isolates, versions, and restores safely", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
  concurrency: 1,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL");
  const fixture = await isolatedPostgres(url);
  const photoRoot = await mkdtemp(join(tmpdir(), "medbox-evidence-test-"));
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(fixture.pool);
    app = await buildServer({ database: fixture.database, wechatGateway: gateway,
      privatePhotoStore: new PrivatePhotoStore(photoRoot), logger: false });
    const call = (user, method, path, payload) => app.inject({ method, url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${user.token}` }, ...(payload === undefined ? {} : { payload }) });
    const json = (response, expected) => {
      assert.equal(response.statusCode, expected, response.body);
      return expected === 204 ? null : response.json();
    };
    async function family() {
      const code = randomUUID();
      gateway.registerCode(code, `evidence-${code}`);
      const auth = json(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      const user = { token: auth.token, id: auth.user.id };
      const created = json(await call(user, "POST", "/families", { name: `合成家庭-${randomUUID()}` }), 201);
      return { user, id: created.family.id };
    }
    async function medicine(user, name) {
      return json(await call(user, "POST", "/medicines", { name, batches: [] }), 201);
    }
    async function photo(user, medicineId) {
      return json(await call(user, "POST", `/medicines/${medicineId}/leaflet-photos`, {
        imageBase64: PNG, mimeType: "image/png", purpose: "box_front", uploadIntentKey: randomUUID().replaceAll("-", ""),
      }), 201).photo;
    }
    const a = await family();
    const b = await family();
    const first = await medicine(a.user, "合成来源药");
    const other = await medicine(a.user, "同家庭其他药");
    const foreign = await medicine(b.user, "其他家庭药");
    const p1 = await photo(a.user, first.id);
    const p3 = await photo(a.user, first.id);
    const pOther = await photo(a.user, other.id);
    const pForeign = await photo(b.user, foreign.id);
    const path = `/medicines/${first.id}/recognition-evidence`;
    const payload = {
      schemaVersion: 1, revision: 0, medicineVersion: first.version,
      idempotencyKey: randomUUID().replaceAll("-", ""),
      photos: [
        { photoId: p1.id, sequence: 1, status: "recognized", fields: { name: first.name, populationTags: ["adult"] }, warnings: ["包装文字模糊"] },
        { photoId: p3.id, sequence: 3, status: "recognized", fields: { name: first.name, specification: "10片" } },
      ],
      fieldSources: {
        name: { source: "recognized", photoIds: [p1.id, p3.id], reviewed: true },
        manufacturer: { source: "manual", photoIds: [], reviewed: true },
        approvalNumber: { source: "catalog", photoIds: [], reviewed: false },
        barcodeValue: { source: "removed", photoIds: [], reviewed: true },
      },
    };

    await t.test("new resource is optional and scoped to the current family", async () => {
      assert.deepEqual(json(await call(a.user, "GET", path), 200), { evidence: null, capabilities: { coverPhotoVersionGuard: true } });
      assert.equal((await call(b.user, "GET", path)).statusCode, 404);
      assert.equal((await app.inject({ method: "GET", url: `/api/v1${path}` })).statusCode, 401);
    });

    await t.test("validated evidence survives replay and detects version and content conflicts", async () => {
      const saved = json(await call(a.user, "POST", path, payload), 200).evidence;
      assert.equal(saved.revision, 1);
      assert.equal(saved.medicineVersion, first.version);
      assert.equal(saved.currentMedicineVersion, first.version);
      assert.equal(saved.stale, false);
      assert.deepEqual(saved.photos.map(({ sequence, available }) => [sequence, available]), [[1, true], [3, true]]);
      assert.deepEqual(saved.fieldSources.name.photoIds, [p1.id, p3.id]);
      assert.deepEqual(saved.photos[0].warnings, ["包装文字模糊"]);
      assert.deepEqual(saved.fieldSources.barcodeValue, { source: "removed", photoIds: [], reviewed: true });
      assert.deepEqual(json(await call(a.user, "POST", path, payload), 200).evidence, saved);
      assert.equal((await call(a.user, "POST", path, { ...payload,
        photos: [{ ...payload.photos[0], fields: { name: "另一候选" } }, payload.photos[1]] })).statusCode, 409);
      assert.equal((await call(a.user, "POST", path, { ...payload, idempotencyKey: randomUUID().replaceAll("-", "") })).statusCode, 409);
      const read = await call(a.user, "GET", path);
      assert.match(read.headers["cache-control"], /no-store/);
      const loaded = json(read, 200);
      assert.deepEqual(loaded.evidence, saved);
      assert.deepEqual(loaded.capabilities, { coverPhotoVersionGuard: true });
    });

    await t.test("foreign, wrong-medicine, pending, inconsistent and oversized references are rejected", async () => {
      const pendingId = randomUUID();
      await fixture.pool.query(`INSERT INTO medicine_leaflet_photos
        (id, family_id, medicine_id, storage_key, content_type, size_bytes, source, created_by)
        VALUES ($1,$2,$3,$4,'image/png',1,'synthetic',$5)`,
      [pendingId, a.id, first.id, `synthetic-${pendingId}`, a.user.id]);
      const base = { ...payload, revision: 1, idempotencyKey: randomUUID().replaceAll("-", "") };
      for (const badId of [pOther.id, pForeign.id, pendingId]) {
        const bad = { ...base, photos: [...payload.photos, { ...payload.photos[0], photoId: badId, sequence: 2 }] };
        assert.equal((await call(a.user, "POST", path, bad)).statusCode, 400);
      }
      const variants = [
        { ...base, photos: [payload.photos[0], { ...payload.photos[1], sequence: 1 }] },
        { ...base, fieldSources: { name: { source: "recognized", photoIds: [pOther.id], reviewed: true } } },
        { ...base, fieldSources: { name: { source: "catalog", photoIds: [p1.id], reviewed: true } } },
        { ...base, photos: [{ ...payload.photos[0], fields: { name: "x".repeat(32769) } }] },
        { ...base, photos: [{ ...payload.photos[0], fields: { personalNote: "private" } }] },
        { ...base, photos: [{ ...payload.photos[0], warnings: Array(21).fill("警告") }], fieldSources: {} },
        { ...base, photos: [{ ...payload.photos[0], warnings: ["x".repeat(501)] }], fieldSources: {} },
      ];
      for (const bad of variants) assert.equal((await call(a.user, "POST", path, bad)).statusCode, 400);
    });

    await t.test("deleting a photo preserves history without relabeling or viewing it", async () => {
      json(await call(a.user, "DELETE", `/medicines/${first.id}/leaflet-photos/${p1.id}`), 204);
      const read = json(await call(a.user, "GET", path), 200).evidence;
      assert.deepEqual(read.photos.map(({ sequence, available }) => [sequence, available]), [[1, false], [3, true]]);
      assert.deepEqual(read.fieldSources.name.photoIds, [p1.id, p3.id]);
      const replay = json(await call(a.user, "POST", path, payload), 200).evidence;
      assert.equal(replay.photos[0].available, false);
      const changedHistory = { ...payload, revision: 1, idempotencyKey: randomUUID().replaceAll("-", ""),
        photos: [{ ...payload.photos[0], fields: { name: "改写已不可查看的历史" } }, payload.photos[1]] };
      assert.equal((await call(a.user, "POST", path, changedHistory)).statusCode, 409);
      const changedWarning = { ...payload, revision: 1, idempotencyKey: randomUUID().replaceAll("-", ""),
        photos: [{ ...payload.photos[0], warnings: ["改写的警告"] }, payload.photos[1]] };
      assert.equal((await call(a.user, "POST", path, changedWarning)).statusCode, 409);
      const revised = { ...payload, revision: 1, idempotencyKey: randomUUID().replaceAll("-", "") };
      assert.equal(json(await call(a.user, "POST", path, revised), 200).evidence.revision, 2);
      const superseded = json(await call(a.user, "POST", path, payload), 200).evidence;
      assert.equal(superseded.revision, 1);
      assert.equal(superseded.stale, true, "a replayed old receipt must not look like the current evidence");
      assert.equal(json(await call(a.user, "GET", path), 200).evidence.stale, true);
    });

    await t.test("concurrent writes serialize and later medicine changes mark sources stale", async () => {
      const request = (key) => call(a.user, "POST", path, { ...payload, revision: 2, idempotencyKey: key });
      const results = await contend(fixture, /SELECT id FROM families WHERE id = \$1 FOR (?:NO KEY )?UPDATE/,
        () => request(randomUUID().replaceAll("-", "")), () => request(randomUUID().replaceAll("-", "")));
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
      json(await call(a.user, "POST", `/medicines/${first.id}/low-stock-threshold`, {
        version: first.version, lowStockThreshold: { quantity: 2, unit: "box" },
      }), 200);
      const read = json(await call(a.user, "GET", path), 200).evidence;
      assert.equal(read.stale, true);
      assert.ok(read.currentMedicineVersion > read.medicineVersion);
      const oldReceipt = json(await call(a.user, "POST", path, payload), 200).evidence;
      assert.equal(oldReceipt.revision, 1);
      assert.equal(oldReceipt.stale, true);
      assert.equal((await call(a.user, "POST", path, { ...payload, revision: read.revision,
        idempotencyKey: randomUUID().replaceAll("-", "") })).statusCode, 409);
    });

    await t.test("a family switch or revocation while waiting for the lock cannot read or write evidence", async () => {
      const code = randomUUID();
      gateway.registerCode(code, `evidence-member-${code}`);
      const auth = json(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      const member = { token: auth.token, id: auth.user.id };
      await fixture.pool.query("INSERT INTO family_members (family_id,user_id,role) VALUES ($1,$2,'member')", [a.id, member.id]);
      await fixture.pool.query("UPDATE sessions SET active_family_id = $1 WHERE user_id = $2", [a.id, member.id]);
      const targetPath = `/medicines/${other.id}/recognition-evidence`;
      const newRequest = { schemaVersion: 1, revision: 0, medicineVersion: other.version,
        idempotencyKey: randomUUID().replaceAll("-", ""),
        photos: [{ photoId: pOther.id, sequence: 1, status: "recognized", fields: { name: "候选" } }], fieldSources: {} };
      const lock = /SELECT id FROM families WHERE id = \$1 FOR (?:NO KEY )?UPDATE/;
      const [, switched] = await contend(fixture, lock,
        () => fixture.database.withTransaction(async (tx) => {
          await tx.query("SELECT id FROM families WHERE id = $1 FOR UPDATE", [a.id]);
          await tx.query("UPDATE sessions SET active_family_id = NULL WHERE user_id = $1", [member.id]);
        }), () => call(member, "POST", targetPath, newRequest));
      assert.equal(switched.statusCode, 404);
      assert.deepEqual(json(await call(a.user, "GET", targetPath), 200), { evidence: null, capabilities: { coverPhotoVersionGuard: true } });
      await fixture.pool.query("UPDATE sessions SET active_family_id = $1 WHERE user_id = $2", [a.id, member.id]);
      const [, revoked] = await contend(fixture, lock,
        () => fixture.database.withTransaction(async (tx) => {
          await tx.query("SELECT id FROM families WHERE id = $1 FOR UPDATE", [a.id]);
          await tx.query("DELETE FROM family_members WHERE family_id = $1 AND user_id = $2", [a.id, member.id]);
        }), () => call(member, "GET", path));
      assert.equal(revoked.statusCode, 404);
    });

    await t.test("deletion wins over a waiting new reference, while concurrent identical retries write once", async () => {
      const targetPath = `/medicines/${other.id}/recognition-evidence`;
      const deleted = await photo(a.user, other.id);
      const newRequest = { schemaVersion: 1, revision: 0, medicineVersion: other.version,
        idempotencyKey: randomUUID().replaceAll("-", ""),
        photos: [{ photoId: deleted.id, sequence: 1, status: "recognized", fields: { name: "候选" } }], fieldSources: {} };
      const lock = /SELECT id FROM families WHERE id = \$1 FOR (?:NO KEY )?UPDATE/;
      const [, blocked] = await contend(fixture, lock,
        () => fixture.database.withTransaction(async (tx) => {
          await tx.query("SELECT id FROM families WHERE id = $1 FOR UPDATE", [a.id]);
          await tx.query("UPDATE medicine_leaflet_photos SET deleted_at = now() WHERE id = $1", [deleted.id]);
        }), () => call(a.user, "POST", targetPath, newRequest));
      assert.equal(blocked.statusCode, 400);
      assert.deepEqual(json(await call(a.user, "GET", targetPath), 200), { evidence: null, capabilities: { coverPhotoVersionGuard: true } });

      const validRequest = { ...newRequest, idempotencyKey: randomUUID().replaceAll("-", ""),
        photos: [{ ...newRequest.photos[0], photoId: pOther.id }] };
      const responses = await contend(fixture, lock,
        () => call(a.user, "POST", targetPath, validRequest), () => call(a.user, "POST", targetPath, validRequest));
      const firstReceipt = json(responses[0], 200);
      assert.deepEqual(json(responses[1], 200), firstReceipt);
      assert.equal(firstReceipt.evidence.revision, 1);
      const receiptCount = await fixture.pool.query(
        "SELECT count(*)::int AS total FROM medicine_recognition_evidence_receipts WHERE medicine_id = $1", [other.id],
      );
      assert.equal(receiptCount.rows[0].total, 1);
    });

    await t.test("backup keeps structured evidence but restores original photos as unavailable", async () => {
      const backup = json(await call(a.user, "POST", "/backups/json", {}), 200);
      const exported = backup.medicines.find((item) => item.name === first.name);
      assert.ok(exported.recognitionEvidence);
      assert.equal(JSON.stringify(backup).includes(PNG), false);
      const preview = json(await call(b.user, "POST", "/backups/preview", { backup }), 200);
      assert.equal(preview.valid, true, JSON.stringify(preview.errors));
      json(await call(b.user, "POST", "/backups/restore", {
        backup, confirmed: true, confirmationToken: preview.confirmationToken,
      }), 201);
      const restored = json(await call(b.user, "GET", "/medicines?includeArchived=true"), 200).medicines.find((item) => item.name === first.name);
      assert.ok(restored);
      const evidence = json(await call(b.user, "GET", `/medicines/${restored.id}/recognition-evidence`), 200).evidence;
      assert.equal(evidence.stale, true);
      assert.deepEqual(evidence.photos.map(({ sequence, available }) => [sequence, available]), [[1, false], [3, false]]);
      assert.deepEqual(evidence.fieldSources.name.photoIds, [p1.id, p3.id]);
      assert.equal(evidence.fieldSources.barcodeValue.source, "removed");
      assert.deepEqual(evidence.photos[0].warnings, ["包装文字模糊"]);
      const reconciled = json(await call(b.user, "POST", `/medicines/${restored.id}/recognition-evidence`, {
        schemaVersion: 1, revision: evidence.revision, medicineVersion: restored.version,
        idempotencyKey: randomUUID().replaceAll("-", ""),
        photos: evidence.photos.map((item) => ({ photoId: item.photoId, sequence: item.sequence,
          status: item.status, fields: item.fields, ...(item.warnings === undefined ? {} : { warnings: item.warnings }) })), fieldSources: evidence.fieldSources,
      }), 200).evidence;
      assert.equal(reconciled.stale, true);
      assert.deepEqual(reconciled.photos.map((item) => item.available), [false, false]);
    });
  } finally {
    if (app) await app.close();
    await fixture.close();
    await rm(photoRoot, { recursive: true, force: true });
  }
});
