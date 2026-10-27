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
const key = () => randomUUID().replaceAll("-", "");

test("recognition evidence retains saved photo history across updates", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL");
  const fixture = await isolatedPostgres(url);
  const photoRoot = await mkdtemp(join(tmpdir(), "medbox-evidence-history-"));
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(fixture.pool);
    app = await buildServer({ database: fixture.database, wechatGateway: gateway,
      privatePhotoStore: new PrivatePhotoStore(photoRoot), logger: false });
    const code = randomUUID();
    gateway.registerCode(code, `history-${code}`);
    const auth = await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } });
    assert.equal(auth.statusCode, 200);
    const call = (method, path, payload) => app.inject({ method, url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${auth.json().token}` }, ...(payload === undefined ? {} : { payload }) });
    const json = (response, expected) => {
      assert.equal(response.statusCode, expected, response.body);
      return expected === 204 ? null : response.json();
    };
    const family = json(await call("POST", "/families", { name: "历史保全合成家庭" }), 201).family;
    const medicine = json(await call("POST", "/medicines", { name: "历史保全药", batches: [] }), 201);
    async function upload(medicineId = medicine.id) {
      return json(await call("POST", `/medicines/${medicineId}/leaflet-photos`, {
        imageBase64: PNG, mimeType: "image/png", purpose: "box_front", uploadIntentKey: key(),
      }), 201).photo;
    }
    const first = await upload();
    const failed = await upload();
    const pending = await upload();
    const original = { schemaVersion: 1, revision: 0, medicineVersion: medicine.version, idempotencyKey: key(),
      photos: [
        { photoId: first.id, sequence: 1, status: "recognized", fields: { name: medicine.name,
          rawOcrText: "  唯一合成 OCR 原文\n保留空白  ", populationTags: ["adult", "child"] }, warnings: ["提醒一", "提醒二"] },
        { photoId: failed.id, sequence: 3, status: "failed", fields: { manufacturer: "旧候选" }, warnings: ["第一次失败"] },
        { photoId: pending.id, sequence: 4, status: "pending", fields: {}, warnings: [] },
      ], fieldSources: { name: { source: "recognized", photoIds: [first.id], reviewed: true } } };
    const path = `/medicines/${medicine.id}/recognition-evidence`;
    const next = (revision, photos, fieldSources = original.fieldSources) => ({ ...original, revision, idempotencyKey: key(), photos, fieldSources });
    const saved = json(await call("POST", path, original), 200).evidence;
    assert.equal(saved.revision, 1);

    await t.test("omitting a photo or altering saved fields, OCR, warnings or recognized status is rejected", async () => {
      const firstPhoto = original.photos[0];
      const variants = [
        next(1, original.photos.slice(1), {}),
        next(1, [firstPhoto, original.photos[2]]),
        next(1, [{ ...firstPhoto, sequence: 9 }, ...original.photos.slice(1)]),
        next(1, [{ ...firstPhoto, fields: { name: medicine.name, populationTags: ["adult", "child"] } }, ...original.photos.slice(1)]),
        next(1, [{ ...firstPhoto, fields: { ...firstPhoto.fields, rawOcrText: "改写原文" } }, ...original.photos.slice(1)]),
        next(1, [{ ...firstPhoto, fields: { ...firstPhoto.fields, name: "改写候选" } }, ...original.photos.slice(1)], {}),
        next(1, [{ ...firstPhoto, fields: { ...firstPhoto.fields, populationTags: ["child", "adult"] } }, ...original.photos.slice(1)]),
        next(1, [{ ...firstPhoto, warnings: ["提醒一"] }, ...original.photos.slice(1)]),
        next(1, [{ ...firstPhoto, warnings: ["提醒二", "提醒一"] }, ...original.photos.slice(1)]),
        next(1, [{ ...firstPhoto, status: "failed" }, ...original.photos.slice(1)], {}),
        next(1, [{ ...firstPhoto, status: "pending" }, ...original.photos.slice(1)], {}),
      ];
      for (const attempt of variants) assert.equal((await call("POST", path, attempt)).statusCode, 409);
      const latest = json(await call("GET", path), 200).evidence;
      assert.equal(latest.revision, 1);
      assert.equal(latest.photos[0].fields.rawOcrText, firstPhoto.fields.rawOcrText);
      assert.deepEqual(latest.photos[0].warnings, firstPhoto.warnings);
    });

    let appended;
    await t.test("new fields and warnings may be appended while failed/pending photos become recognized", async () => {
      appended = [
        { ...original.photos[0], fields: { ...original.photos[0].fields, specification: "附加候选" }, warnings: ["提醒一", "提醒二", "新增提醒"] },
        { ...original.photos[1], status: "recognized", fields: { ...original.photos[1].fields, rawOcrText: "重试原文" }, warnings: ["第一次失败", "已重识别"] },
        { ...original.photos[2], status: "recognized", fields: { rawOcrText: "后续识别原文" }, warnings: ["后续提醒"] },
      ];
      const result = json(await call("POST", path, next(1, appended)), 200).evidence;
      assert.equal(result.revision, 2);
      assert.equal(result.photos[0].fields.rawOcrText, original.photos[0].fields.rawOcrText);
      assert.equal(result.photos[1].status, "recognized");
      assert.equal(result.photos[2].status, "recognized");
      assert.deepEqual(result.photos[0].warnings, ["提醒一", "提醒二", "新增提醒"]);
    });

    await t.test("deleting an original leaves history unavailable and cannot delete or rewrite it", async () => {
      json(await call("DELETE", `/medicines/${medicine.id}/leaflet-photos/${first.id}`), 204);
      const read = json(await call("GET", path), 200).evidence;
      assert.equal(read.photos[0].available, false);
      assert.equal(read.stale, true);
      assert.equal((await call("POST", path, next(2, appended.slice(1), {}))).statusCode, 409);
      const changed = [{ ...appended[0], fields: { ...appended[0].fields, rawOcrText: "改写" } }, ...appended.slice(1)];
      assert.equal((await call("POST", path, next(2, changed))).statusCode, 409);
      assert.equal(json(await call("POST", path, next(2, appended)), 200).evidence.revision, 3);
      const replay = json(await call("POST", path, original), 200).evidence;
      assert.equal(replay.revision, 1);
      assert.equal(replay.stale, true);
      assert.equal(replay.photos[0].fields.rawOcrText, original.photos[0].fields.rawOcrText);
    });

    await t.test("oversize and concurrent writes fail without losing prior history", async () => {
      const oversized = [...appended, { photoId: randomUUID(), sequence: 5, status: "recognized", fields: { rawOcrText: "x".repeat(32 * 1024) } }];
      assert.equal((await call("POST", path, next(3, oversized))).statusCode, 400);
      const tooLargeDocument = [...appended, ...Array.from({ length: 9 }, (_, i) => ({
        photoId: randomUUID(), sequence: 5 + i, status: "recognized", fields: { rawOcrText: "x".repeat(29_200) },
      }))];
      const sizeRejected = await call("POST", path, next(3, tooLargeDocument));
      assert.ok([400, 413].includes(sizeRejected.statusCode));
      assert.equal(sizeRejected.json().error.code, "VALIDATION_ERROR");
      const many = [...appended, ...Array.from({ length: 98 }, (_, i) => ({
        photoId: randomUUID(), sequence: 5 + i, status: "pending", fields: {},
      }))];
      assert.equal((await call("POST", path, next(3, many))).statusCode, 400);
      const [one, two] = await contend(fixture, /SELECT id FROM families WHERE id = \$1 FOR (?:NO KEY )?UPDATE/,
        () => call("POST", path, next(3, appended)), () => call("POST", path, next(3, appended)));
      assert.deepEqual([one.statusCode, two.statusCode].sort(), [200, 409]);
      const latest = json(await call("GET", path), 200).evidence;
      assert.equal(latest.revision, 4);
      assert.equal(latest.photos[0].fields.rawOcrText, original.photos[0].fields.rawOcrText);
    });

    await t.test("a new uploaded photo appends without replacing older photos or selected sources", async () => {
      const added = await upload();
      const photos = [...appended, { photoId: added.id, sequence: 5, status: "recognized",
        fields: { rawOcrText: "新上传照片原文" }, warnings: ["新照片提醒"] }];
      const response = json(await call("POST", path, next(4, photos)), 200).evidence;
      assert.equal(response.revision, 5);
      assert.deepEqual(response.photos.map((item) => item.photoId), [first.id, failed.id, pending.id, added.id]);
      assert.equal(response.photos[0].fields.rawOcrText, original.photos[0].fields.rawOcrText);
      assert.deepEqual(response.fieldSources.name.photoIds, [first.id]);
      assert.equal(response.photos[0].available, false);
      assert.equal(response.photos[3].available, true);
    });

    await t.test("an available pending photo can fill an existing null field", async () => {
      const med = json(await call("POST", "/medicines", { name: "空候选独立药", batches: [] }), 201);
      const photo = await upload(med.id);
      const medPath = `/medicines/${med.id}/recognition-evidence`;
      const intent = { schemaVersion: 1, revision: 0, medicineVersion: med.version, idempotencyKey: key(),
        photos: [{ photoId: photo.id, sequence: 1, status: "pending", fields: { manufacturer: null } }], fieldSources: {} };
      json(await call("POST", medPath, intent), 200);
      const filled = { ...intent, revision: 1, idempotencyKey: key(),
        photos: [{ ...intent.photos[0], status: "recognized", fields: { manufacturer: "补充的候选" } }] };
      assert.equal(json(await call("POST", medPath, filled), 200).evidence.photos[0].fields.manufacturer, "补充的候选");
    });

    await t.test("null fields can be filled only for available pending/failed photos, and prior source keys remain explicit", async () => {
      const med = json(await call("POST", "/medicines", { name: "空候选合成药", batches: [
        { lotNumber: "批次甲", quantity: 1, unit: "box" }, { lotNumber: "批次乙", quantity: 2, unit: "box" },
      ] }), 201);
      const pendingPhoto = await upload(med.id);
      const failedPhoto = await upload(med.id);
      const recognizedPhoto = await upload(med.id);
      const laterRemoved = await upload(med.id);
      const photos = [
        { photoId: pendingPhoto.id, sequence: 1, status: "pending", fields: { name: null, manufacturer: null } },
        { photoId: failedPhoto.id, sequence: 2, status: "failed", fields: { specification: null } },
        { photoId: recognizedPhoto.id, sequence: 3, status: "recognized", fields: { name: med.name, brand: null } },
        { photoId: laterRemoved.id, sequence: 4, status: "pending", fields: { name: null } },
      ];
      const fieldSources = { name: { source: "recognized", photoIds: [recognizedPhoto.id], reviewed: true },
        manufacturer: { source: "manual", photoIds: [], reviewed: false } };
      const batchSources = [
        { batchId: med.batches[0].id, field: "lotNumber", source: "manual", photoIds: [], reviewed: false },
        { batchId: med.batches[1].id, field: "expiry", source: "manual", photoIds: [], reviewed: true },
      ];
      const medPath = `/medicines/${med.id}/recognition-evidence`;
      const make = (revision, version, overrides = {}) => ({ schemaVersion: 1, revision, medicineVersion: version,
        idempotencyKey: key(), photos, fieldSources, batchSources, ...overrides });
      json(await call("POST", medPath, make(0, med.version)), 200);
      assert.equal((await call("POST", medPath, make(1, med.version, { fieldSources: { name: fieldSources.name } }))).statusCode, 409);
      assert.equal((await call("POST", medPath, make(1, med.version, { batchSources: [batchSources[0]] }))).statusCode, 409);
      assert.equal((await call("POST", medPath, make(1, med.version, { batchSources: [] }))).statusCode, 409);
      const missingField = [{ ...photos[0], fields: { manufacturer: null } }, ...photos.slice(1)];
      assert.equal((await call("POST", medPath, make(1, med.version, { photos: missingField }))).statusCode, 409);
      const alterRecognizedNull = photos.map((photo) => photo.photoId === recognizedPhoto.id
        ? { ...photo, fields: { ...photo.fields, brand: "不得改写已识别的空值" } } : photo);
      assert.equal((await call("POST", medPath, make(1, med.version, { photos: alterRecognizedNull }))).statusCode, 409);

      const filled = photos.map((photo) => photo.photoId === pendingPhoto.id
        ? { ...photo, status: "recognized", fields: { name: med.name, manufacturer: "新增候选" }, warnings: ["已识别"] }
        : photo.photoId === failedPhoto.id
          ? { ...photo, status: "recognized", fields: { specification: "新规格" }, warnings: ["重试成功"] } : photo);
      const chosenFields = { name: { source: "manual", photoIds: [], reviewed: true },
        manufacturer: { source: "removed", photoIds: [], reviewed: false } };
      const chosenBatches = [{ ...batchSources[0], source: "removed" }, { ...batchSources[1], source: "catalog" }];
      const updated = json(await call("POST", medPath, make(1, med.version, {
        photos: filled, fieldSources: chosenFields, batchSources: chosenBatches,
      })), 200).evidence;
      assert.equal(updated.revision, 2);
      assert.equal(updated.photos[0].fields.name, med.name);
      assert.equal(updated.photos[1].fields.specification, "新规格");
      assert.equal(updated.fieldSources.name.source, "manual");
      assert.equal(updated.batchSources[0].source, "removed");

      json(await call("DELETE", `/medicines/${med.id}/batches/${med.batches[0].id}`), 204);
      json(await call("DELETE", `/medicines/${med.id}/leaflet-photos/${laterRemoved.id}`), 204);
      const latestMed = json(await call("GET", `/medicines/${med.id}`), 200);
      const omitHistory = make(2, latestMed.version, { photos: filled, fieldSources: chosenFields, batchSources: [chosenBatches[1]] });
      assert.equal((await call("POST", medPath, omitHistory)).statusCode, 409);
      const mutateUnavailable = filled.map((photo) => photo.photoId === laterRemoved.id
        ? { ...photo, status: "recognized", fields: { name: "不可查看时补写" } } : photo);
      assert.equal((await call("POST", medPath, make(2, latestMed.version, {
        photos: mutateUnavailable, fieldSources: chosenFields, batchSources: chosenBatches,
      }))).statusCode, 409);
      const explicitHistoricalChoice = [{ ...chosenBatches[0], source: "manual" }, chosenBatches[1]];
      const retained = json(await call("POST", medPath, make(2, latestMed.version, {
        photos: filled, fieldSources: chosenFields, batchSources: explicitHistoricalChoice,
      })), 200).evidence;
      assert.equal(retained.stale, true);
      assert.equal(retained.batchSources[0].batchAvailable, false);
      assert.equal(retained.batchSources[0].source, "manual");
      assert.equal(retained.photos.find((photo) => photo.photoId === laterRemoved.id).available, false);
    });

    await t.test("legacy unbound batch claims remain stale and can only be retained unchanged", async () => {
      const med = json(await call("POST", "/medicines", { name: "旧来源合成药", batches: [] }), 201);
      const old = { schemaVersion: 1, photos: [], fieldSources: { lotNumber: { source: "manual", photoIds: [], reviewed: false } } };
      await fixture.pool.query(`INSERT INTO medicine_recognition_evidence (family_id,medicine_id,revision,medicine_version,document)
        VALUES ($1,$2,1,$3,$4::jsonb)`, [family.id, med.id, med.version, JSON.stringify(old)]);
      const medPath = `/medicines/${med.id}/recognition-evidence`;
      assert.equal(json(await call("GET", medPath), 200).evidence.stale, true);
      const preserved = { ...old, revision: 1, medicineVersion: med.version, idempotencyKey: key() };
      const saved = json(await call("POST", medPath, preserved), 200).evidence;
      assert.equal(saved.revision, 2);
      assert.equal(saved.stale, true);
      assert.equal((await call("POST", medPath, { ...preserved, revision: 2, idempotencyKey: key(), fieldSources: {} })).statusCode, 409);
      assert.equal((await call("POST", medPath, { ...preserved, revision: 2, idempotencyKey: key(),
        fieldSources: { lotNumber: { source: "manual", photoIds: [], reviewed: true } } })).statusCode, 400);
    });
  } finally {
    if (app) await app.close();
    await fixture.close();
    await rm(photoRoot, { recursive: true, force: true });
  }
});
