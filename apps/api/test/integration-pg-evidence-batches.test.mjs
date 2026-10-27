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
import { isolatedPostgres } from "./helpers/isolated-pg.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";
const key = () => randomUUID().replaceAll("-", "");

test("batch sources bind exact inventory IDs and survive backup as bound or removed history", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL");
  const fixture = await isolatedPostgres(url);
  const photoRoot = await mkdtemp(join(tmpdir(), "medbox-evidence-batches-"));
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
      gateway.registerCode(code, `batch-evidence-${code}`);
      const auth = json(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      const user = { token: auth.token, id: auth.user.id };
      const household = json(await call(user, "POST", "/families", { name: "批次来源合成家庭" }), 201);
      return { user, id: household.family.id };
    }
    async function upload(user, medId, extra = {}) {
      return json(await call(user, "POST", `/medicines/${medId}/leaflet-photos`, {
        imageBase64: PNG, mimeType: "image/png", purpose: "box_front", uploadIntentKey: key(), ...extra,
      }), 201).photo;
    }
    const a = await family();
    const b = await family();
    const same = (quantity) => ({ lotNumber: "相同批号", expiry: { value: "2028-05", precision: "month" }, quantity, unit: "box" });
    const med = json(await call(a.user, "POST", "/medicines", { name: "重复批次药", batches: [same(1), same(2), same(3)] }), 201);
    const batches = new Map(med.batches.map((batch) => [batch.quantity, batch]));
    const foreign = json(await call(b.user, "POST", "/medicines", { name: "外部药", batches: [same(4)] }), 201);
    const p1 = await upload(a.user, med.id);
    const p2 = await upload(a.user, med.id);
    const boundPhoto = await upload(a.user, med.id, { purpose: "expiry", batchId: batches.get(1).id });
    const photos = [
      { photoId: p1.id, sequence: 1, status: "recognized", fields: { expiryValue: "2028-05", expiryPrecision: "month", lotNumber: "相同批号" } },
      { photoId: p2.id, sequence: 2, status: "recognized", fields: { expiryValue: "2028-05", expiryPrecision: "month", lotNumber: "相同批号" } },
      { photoId: boundPhoto.id, sequence: 3, status: "recognized", fields: { expiryValue: "2028-05", expiryPrecision: "month" } },
    ];
    const source = (batchId, field, photoIds, reviewed = true) => ({ batchId, field, source: "recognized", photoIds, reviewed });
    const batchSources = [source(batches.get(1).id, "expiry", [p1.id, boundPhoto.id], false),
      source(batches.get(2).id, "lotNumber", [p2.id]), source(batches.get(3).id, "expiry", [p1.id, p2.id])];
    const path = `/medicines/${med.id}/recognition-evidence`;
    const body = (revision = 0, medicineVersion = med.version, overrides = {}) => ({ schemaVersion: 1,
      revision, medicineVersion, idempotencyKey: key(), photos, fieldSources: {}, batchSources, ...overrides });

    await t.test("rejects batch fields at medicine level and rejects wrong batches or candidate values", async () => {
      for (const field of ["lotNumber", "expiryValue", "expiryPrecision", "leafletText"]) {
        const invalid = body(0, med.version, { batchSources: [], fieldSources: { [field]: { source: "manual", photoIds: [], reviewed: false } } });
        assert.equal((await call(a.user, "POST", path, invalid)).statusCode, 400);
      }
      const wrongBatch = body(0, med.version, { batchSources: [source(foreign.batches[0].id, "expiry", [p1.id])] });
      assert.equal((await call(a.user, "POST", path, wrongBatch)).statusCode, 400);
      const wrongPhoto = [{ ...photos[0], fields: { ...photos[0].fields, expiryPrecision: "day" } }, photos[1]];
      assert.equal((await call(a.user, "POST", path, body(0, med.version, { photos: wrongPhoto }))).statusCode, 400);
      const wrongLot = [{ ...photos[0], fields: { ...photos[0].fields, lotNumber: "另一批号" } }, photos[1]];
      assert.equal((await call(a.user, "POST", path, body(0, med.version, {
        photos: wrongLot, batchSources: [source(batches.get(2).id, "lotNumber", [p1.id])],
      }))).statusCode, 400);
      const wrongBinding = body(0, med.version, { batchSources: [source(batches.get(2).id, "expiry", [boundPhoto.id])] });
      assert.equal((await call(a.user, "POST", path, wrongBinding)).statusCode, 400,
        "an expiry photo explicitly bound to batch 1 must not be claimed for equal-valued batch 2");
    });

    await t.test("preserves the explicit IDs even when batches have equal expiry and lot", async () => {
      const saved = json(await call(a.user, "POST", path, body()), 200).evidence;
      assert.equal(saved.revision, 1);
      assert.deepEqual(saved.batchSources.map((item) => [item.batchId, item.batchAvailable]),
        batchSources.map((item) => [item.batchId, true]));
      assert.equal(saved.stale, false);
    });

    await t.test("removed inventory stays unbound history and cannot be promoted", async () => {
      json(await call(a.user, "DELETE", `/medicines/${med.id}/batches/${batches.get(1).id}`), 204);
      const current = json(await call(a.user, "GET", `/medicines/${med.id}`), 200);
      const evidence = json(await call(a.user, "GET", path), 200).evidence;
      assert.equal(evidence.batchSources[0].batchAvailable, false);
      assert.equal(evidence.stale, true);
      const promoted = batchSources.map((item, index) => index === 0 ? { ...item, reviewed: true } : item);
      assert.equal((await call(a.user, "POST", path, body(1, current.version, { batchSources: promoted }))).statusCode, 409);
      const retained = json(await call(a.user, "POST", path, body(1, current.version)), 200).evidence;
      assert.equal(retained.revision, 2);
      assert.equal(retained.stale, true);
      assert.equal(retained.batchSources[0].batchAvailable, false);
    });

    await t.test("backup maps duplicate values by ref and restores removed history without guessing", async () => {
      const backup = json(await call(a.user, "POST", "/backups/json", {}), 200);
      const item = backup.medicines.find((entry) => entry.name === med.name);
      const refByQuantity = new Map(item.batches.map((batch) => [batch.quantity, batch.backupBatchRef]));
      assert.equal(new Set(refByQuantity.values()).size, item.batches.length);
      const sources = item.recognitionEvidence.batchSources;
      assert.equal(sources[0].batchState, "removed");
      assert.ok(sources[0].backupBatchRef);
      assert.equal([...refByQuantity.values()].includes(sources[0].backupBatchRef), false);
      assert.equal(sources[1].batchState, "bound");
      assert.equal(sources[1].backupBatchRef, refByQuantity.get(2));
      assert.equal(sources[2].backupBatchRef, refByQuantity.get(3));
      assert.equal("batchId" in sources[0], false);
      const duplicate = structuredClone(backup);
      const duplicateItem = duplicate.medicines.find((entry) => entry.name === med.name);
      duplicateItem.batches[1].backupBatchRef = duplicateItem.batches[0].backupBatchRef;
      assert.equal(json(await call(b.user, "POST", "/backups/preview", { backup: duplicate }), 200).valid, false);
      const unknown = structuredClone(backup);
      unknown.medicines.find((entry) => entry.name === med.name).recognitionEvidence.batchSources[1].backupBatchRef = randomUUID();
      assert.equal(json(await call(b.user, "POST", "/backups/preview", { backup: unknown }), 200).valid, false);
      const collision = structuredClone(backup);
      collision.medicines.find((entry) => entry.name === med.name).recognitionEvidence.batchSources[0].backupBatchRef = refByQuantity.get(2);
      assert.equal(json(await call(b.user, "POST", "/backups/preview", { backup: collision }), 200).valid, false);
      const preview = json(await call(b.user, "POST", "/backups/preview", { backup }), 200);
      assert.equal(preview.valid, true, JSON.stringify(preview.errors));
      json(await call(b.user, "POST", "/backups/restore", { backup, confirmed: true, confirmationToken: preview.confirmationToken }), 201);
      const restored = json(await call(b.user, "GET", "/medicines?includeArchived=true"), 200).medicines.find((entry) => entry.name === med.name);
      const evidence = json(await call(b.user, "GET", `/medicines/${restored.id}/recognition-evidence`), 200).evidence;
      const restoredByQuantity = new Map(restored.batches.map((batch) => [batch.quantity, batch.id]));
      assert.equal(evidence.stale, true);
      assert.equal(evidence.batchSources[0].batchId, null);
      assert.equal(evidence.batchSources[0].historicalBatchRef, sources[0].backupBatchRef);
      assert.equal(evidence.batchSources[0].batchAvailable, false);
      assert.equal(evidence.batchSources[1].batchId, restoredByQuantity.get(2));
      assert.equal(evidence.batchSources[2].batchId, restoredByQuantity.get(3));
      assert.equal(evidence.batchSources[1].batchAvailable, true);
      assert.equal(evidence.photos.every((photo) => photo.available === false), true);
      const replay = { schemaVersion: 1, revision: evidence.revision, medicineVersion: restored.version, idempotencyKey: key(),
        photos: evidence.photos.map(({ photoId, sequence, status, fields }) => ({ photoId, sequence, status, fields })),
        fieldSources: evidence.fieldSources,
        batchSources: evidence.batchSources.map((item) => ({ batchId: item.batchId,
          ...(item.historicalBatchRef === undefined ? {} : { historicalBatchRef: item.historicalBatchRef }),
          field: item.field, source: item.source, photoIds: item.photoIds, reviewed: item.reviewed })) };
      const reconciled = json(await call(b.user, "POST", `/medicines/${restored.id}/recognition-evidence`, replay), 200).evidence;
      assert.equal(reconciled.stale, true);
    });
  } finally {
    if (app) await app.close();
    await fixture.close();
    await rm(photoRoot, { recursive: true, force: true });
  }
});
