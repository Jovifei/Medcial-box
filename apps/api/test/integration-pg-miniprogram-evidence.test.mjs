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
import { loadService, makeSessionScopeModule } from "../../miniprogram/test/runtime.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";
const key = () => randomUUID().replaceAll("-", "");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("miniprogram evidence merge and sync interoperate with the real API and PostgreSQL", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL");
  const fixture = await isolatedPostgres(url);
  const photoRoot = await mkdtemp(join(tmpdir(), "medbox-mini-evidence-"));
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(fixture.pool);
    app = await buildServer({ database: fixture.database, wechatGateway: gateway,
      privatePhotoStore: new PrivatePhotoStore(photoRoot), logger: false });
    const code = randomUUID();
    gateway.registerCode(code, `mini-evidence-${code}`);
    const auth = await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } });
    assert.equal(auth.statusCode, 200);
    const user = { token: auth.json().token, id: auth.json().user.id };
    const call = (method, path, payload) => app.inject({ method, url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${user.token}` }, ...(payload === undefined ? {} : { payload }) });
    const json = (response, expected) => {
      assert.equal(response.statusCode, expected, response.body);
      return expected === 204 ? null : response.json();
    };
    const family = json(await call("POST", "/families", { name: "小程序联调合成家庭" }), 201).family;
    const medicine = json(await call("POST", "/medicines", {
      name: "合成联调药", specification: "10片", manufacturer: "人工录入厂",
      batches: [{ lotNumber: "合成批号", expiry: { value: "2028-09", precision: "month" }, quantity: 3, unit: "box" }],
    }), 201);
    const batchId = medicine.batches[0].id;
    async function upload(medicineId, extra = {}) {
      return json(await call("POST", `/medicines/${medicineId}/leaflet-photos`, {
        imageBase64: PNG, mimeType: "image/png", purpose: "box_front", uploadIntentKey: key(), ...extra,
      }), 201).photo;
    }
    const first = await upload(medicine.id);
    const second = await upload(medicine.id, { purpose: "expiry", batchId });
    const merge = loadService("services/recognition-evidence-merge.ts").mergeRecognitionEvidence;
    const rawOcrText = "  合成本机 OCR 原文\n第二行\t保留空白  ";
    const input = {
      existing: null, revision: 0, medicineVersion: medicine.version, idempotencyKey: key(),
      uploadedPhotos: [
        { clientPhotoId: "local-box", photoId: first.id, sequence: 1,
          review: { status: "recognized", fields: { name: "  合成联调药  ", specification: "10片", rawOcrText }, warnings: ["请核对规格"] } },
        { clientPhotoId: "local-expiry", photoId: second.id, sequence: 2,
          review: { status: "recognized", fields: { expiryValue: "2028-09", expiryPrecision: "month", lotNumber: "合成批号" }, warnings: ["有效期需核对"] } },
      ],
      photoIdMap: { "local-box": first.id, "local-expiry": second.id },
      fieldSources: { name: { source: "recognized", photoIds: ["local-box"], reviewed: true },
        manufacturer: { source: "manual", photoIds: [], reviewed: true } },
      batchSources: [{ batchId, field: "expiry", source: "recognized", photoIds: ["local-expiry"], reviewed: true },
        { batchId, field: "lotNumber", source: "manual", photoIds: [], reviewed: true }],
    };
    const merged = merge(input);
    assert.equal(merged.ok, true, merged.reason);
    const payload = plain(merged.payload);

    function syncHarness(backend) {
      const storage = new Map();
      const scope = makeSessionScopeModule({ userId: user.id, familyId: family.id });
      const wx = { getStorageSync: (item) => storage.get(item), setStorageSync: (item, value) => storage.set(item, structuredClone(value)),
        removeStorageSync: (item) => storage.delete(item) };
      const service = loadService("services/recognition-evidence-sync.ts", { wx, modules: {
        "./session-scope": scope,
        "./api": { api: backend, captureSessionIdentity: () => ({ token: user.token, generation: 1 }),
          isCurrentSession: (identity) => identity.token === user.token && identity.generation === 1 },
      } });
      return { service, storage };
    }

    await t.test("current merge output saves and reloads photo warnings, batch IDs and manual sources", async () => {
      const requests = [];
      const backend = {
        getRecognitionEvidence: async (id) => {
          requests.push("GET");
          return json(await call("GET", `/medicines/${id}/recognition-evidence`), 200);
        },
        saveRecognitionEvidence: async (id, document) => {
          requests.push("POST");
          return json(await call("POST", `/medicines/${id}/recognition-evidence`, document), 200);
        },
      };
      const sync = syncHarness(backend);
      const result = await sync.service.queueRecognitionEvidence(medicine.id, payload);
      assert.equal(result.status, "synced", JSON.stringify(result));
      assert.deepEqual(requests, ["GET", "POST"]);
      assert.equal(sync.storage.size, 0);
      const read = json(await call("GET", `/medicines/${medicine.id}/recognition-evidence`), 200);
      assert.equal(read.capabilities.coverPhotoVersionGuard, true);
      assert.equal(read.evidence.stale, false);
      assert.equal(read.evidence.photos[0].fields.rawOcrText, rawOcrText);
      assert.deepEqual(read.evidence.photos.map((photo) => [photo.photoId, photo.sequence, photo.warnings]), [
        [first.id, 1, ["请核对规格"]], [second.id, 2, ["有效期需核对"]],
      ]);
      assert.deepEqual(read.evidence.fieldSources.manufacturer, { source: "manual", photoIds: [], reviewed: true });
      assert.deepEqual(read.evidence.fieldSources.name.photoIds, [first.id]);
      const expiry = read.evidence.batchSources.find((source) => source.field === "expiry");
      const lot = read.evidence.batchSources.find((source) => source.field === "lotNumber");
      assert.equal(expiry.batchId, batchId);
      assert.equal(expiry.batchAvailable, true);
      assert.deepEqual(expiry.photoIds, [second.id]);
      assert.equal(lot.batchId, batchId);
      assert.equal(lot.source, "manual");
      assert.deepEqual(lot.photoIds, []);
    });

    await t.test("an old or capability-unconfirmed service never receives an evidence POST", async () => {
      for (const scenario of ["old", "unconfirmed"]) {
        let posts = 0;
        const sync = syncHarness({
          getRecognitionEvidence: async () => {
            if (scenario === "old") throw { statusCode: 404 };
            return { evidence: null };
          },
          saveRecognitionEvidence: async () => { posts += 1; throw new Error("must not post"); },
        });
        const result = await sync.service.queueRecognitionEvidence(medicine.id, payload);
        assert.equal(result.status, "pending");
        assert.equal(result.reason, scenario === "old" ? "unsupported" : "capability_unconfirmed");
        assert.equal(posts, 0);
        assert.deepEqual(plain(sync.service.getPendingRecognitionEvidence(medicine.id).payload), payload);
      }
    });

    await t.test("a removed middle photo does not renumber a later photo on save and reopen", async () => {
      const another = json(await call("POST", "/medicines", { name: "图号联调药", batches: [] }), 201);
      const photo1 = await upload(another.id);
      const photo3 = await upload(another.id);
      const draft = merge({ existing: null, revision: 0, medicineVersion: another.version, idempotencyKey: key(),
        uploadedPhotos: [
          { clientPhotoId: "local-one", photoId: photo1.id, sequence: 1, review: { status: "recognized", fields: { name: "图号联调药" }, warnings: [] } },
          { clientPhotoId: "local-three", photoId: photo3.id, sequence: 3, review: { status: "recognized", fields: { name: "图号联调药" }, warnings: [] } },
        ], photoIdMap: { "local-one": photo1.id, "local-three": photo3.id },
        fieldSources: { name: { source: "recognized", photoIds: ["local-one", "local-three"], reviewed: true } }, batchSources: [] });
      assert.equal(draft.ok, true, draft.reason);
      const saved = json(await call("POST", `/medicines/${another.id}/recognition-evidence`, plain(draft.payload)), 200);
      assert.deepEqual(saved.evidence.photos.map((photo) => photo.sequence), [1, 3]);
      const reopened = json(await call("GET", `/medicines/${another.id}/recognition-evidence`), 200);
      assert.deepEqual(reopened.evidence.photos.map((photo) => photo.sequence), [1, 3]);
    });

    await t.test("offline intent keeps its original key until the user reviews and confirms a newer medicine version", async () => {
      const med = json(await call("POST", "/medicines", { name: "离线恢复药",
        batches: [{ lotNumber: "恢复批号", expiry: { value: "2028-08", precision: "month" }, quantity: 3, unit: "box" }] }), 201);
      const batch = med.batches[0];
      const photo = await upload(med.id, { purpose: "expiry", batchId: batch.id });
      const originalText = "  恢复前 OCR 原文\n保持每个字符  ";
      const drafted = merge({ existing: null, revision: 0, medicineVersion: med.version, idempotencyKey: key(),
        uploadedPhotos: [{ clientPhotoId: "offline-photo", photoId: photo.id, sequence: 1,
          review: { status: "recognized", fields: { name: med.name, expiryValue: "2028-08", expiryPrecision: "month", rawOcrText: originalText }, warnings: ["待复核"] } }],
        photoIdMap: { "offline-photo": photo.id },
        fieldSources: { name: { source: "recognized", photoIds: ["offline-photo"], reviewed: true } },
        batchSources: [{ batchId: batch.id, field: "expiry", source: "recognized", photoIds: ["offline-photo"], reviewed: true }] });
      assert.equal(drafted.ok, true, drafted.reason);
      const intent = plain(drafted.payload);
      const posted = [];
      let offline = true;
      const parse = (response) => {
        if (response.statusCode >= 400) throw { statusCode: response.statusCode };
        return response.json();
      };
      const backend = {
        getRecognitionEvidence: async (id) => {
          if (offline) throw new Error("synthetic offline");
          return parse(await call("GET", `/medicines/${id}/recognition-evidence`));
        },
        getMedicine: async (id) => parse(await call("GET", `/medicines/${id}`)),
        listLeafletPhotos: async (id) => parse(await call("GET", `/medicines/${id}/leaflet-photos`)),
        saveRecognitionEvidence: async (id, document) => {
          const response = await call("POST", `/medicines/${id}/recognition-evidence`, document);
          posted.push({ payload: plain(document), status: response.statusCode });
          return parse(response);
        },
      };
      const sync = syncHarness(backend);
      const queued = await sync.service.queueRecognitionEvidence(med.id, intent);
      assert.equal(queued.status, "pending");
      assert.equal(queued.reason, "network");
      assert.equal(posted.length, 0);
      assert.deepEqual(plain(sync.service.getPendingRecognitionEvidence(med.id).payload), intent);

      json(await call("POST", `/medicines/${med.id}/batches`, { quantity: 1, unit: "box" }), 201);
      const changed = json(await call("GET", `/medicines/${med.id}`), 200);
      assert.equal(changed.version, med.version + 1);
      assert.equal(json(await call("GET", `/medicines/${med.id}/recognition-evidence`), 200).evidence, null);
      offline = false;
      const firstRetry = await sync.service.retryRecognitionEvidence(med.id);
      assert.equal(firstRetry.status, "pending");
      assert.equal(firstRetry.reason, "conflict");
      assert.equal(posted[0].status, 409);
      assert.deepEqual(posted[0].payload, intent);
      const prepared = await sync.service.prepareRecognitionEvidenceRecovery(med.id);
      assert.equal(prepared.status, "ready", JSON.stringify(prepared));
      assert.equal(prepared.oldMedicineVersion, med.version);
      assert.equal(prepared.currentMedicineVersion, changed.version);
      assert.equal(posted.length, 2, "preparation only replays the original key before explicit confirmation");
      assert.deepEqual(posted[1], { payload: intent, status: 409 });
      assert.deepEqual(plain(sync.service.getPendingRecognitionEvidence(med.id).payload), intent);

      const confirmed = await sync.service.confirmRecognitionEvidenceRecovery(med.id);
      assert.equal(confirmed.status, "synced", JSON.stringify(confirmed));
      assert.equal(posted.length, 3);
      assert.equal(posted[2].status, 200);
      assert.notEqual(posted[2].payload.idempotencyKey, intent.idempotencyKey);
      assert.deepEqual(posted[2].payload, { ...intent, medicineVersion: changed.version,
        idempotencyKey: posted[2].payload.idempotencyKey });
      assert.equal(sync.service.getPendingRecognitionEvidence(med.id), null);
      const saved = json(await call("GET", `/medicines/${med.id}/recognition-evidence`), 200).evidence;
      assert.equal(saved.revision, 1);
      assert.equal(saved.medicineVersion, changed.version);
      assert.equal(saved.stale, false);
      assert.equal(saved.photos[0].fields.rawOcrText, originalText);
      assert.equal(saved.batchSources[0].batchId, batch.id);
    });

    await t.test("an acknowledged stale document with an unavailable old photo does not block later saves", async () => {
      const med = json(await call("POST", "/medicines", { name: "历史图片恢复药", batches: [] }), 201);
      const oldPhoto = await upload(med.id);
      const initial = merge({ existing: null, revision: 0, medicineVersion: med.version, idempotencyKey: key(),
        uploadedPhotos: [{ clientPhotoId: "old", photoId: oldPhoto.id, sequence: 1,
          review: { status: "recognized", fields: { name: med.name }, warnings: [] } }],
        photoIdMap: { old: oldPhoto.id }, fieldSources: { name: { source: "recognized", photoIds: ["old"], reviewed: true } }, batchSources: [] });
      assert.equal(initial.ok, true, initial.reason);
      const path = `/medicines/${med.id}/recognition-evidence`;
      json(await call("POST", path, plain(initial.payload)), 200);
      json(await call("DELETE", `/medicines/${med.id}/leaflet-photos/${oldPhoto.id}`), 204);
      const previous = json(await call("GET", path), 200).evidence;
      assert.equal(previous.stale, true);
      assert.equal(previous.photos[0].available, false);
      const freshPhoto = await upload(med.id);
      const draft = merge({ existing: previous, revision: previous.revision, medicineVersion: med.version, idempotencyKey: key(),
        uploadedPhotos: [{ clientPhotoId: "new", photoId: freshPhoto.id, sequence: 1,
          review: { status: "recognized", fields: { name: med.name }, warnings: [] } }],
        photoIdMap: { new: freshPhoto.id }, fieldSources: { manufacturer: { source: "manual", photoIds: [], reviewed: true } }, batchSources: [] });
      assert.equal(draft.ok, true, draft.reason);
      const posts = [];
      const backend = {
        getRecognitionEvidence: async (id) => json(await call("GET", `/medicines/${id}/recognition-evidence`), 200),
        saveRecognitionEvidence: async (id, document) => {
          const response = json(await call("POST", `/medicines/${id}/recognition-evidence`, document), 200);
          posts.push(response.evidence);
          return response;
        },
      };
      const sync = syncHarness(backend);
      const firstResult = await sync.service.queueRecognitionEvidence(med.id, plain(draft.payload));
      assert.equal(firstResult.status, "synced", JSON.stringify(firstResult));
      assert.equal(firstResult.reason, "stale");
      assert.equal(posts[0].stale, true);
      assert.equal(posts[0].revision, 2);
      assert.equal(sync.service.getPendingRecognitionEvidence(med.id), null);
      const next = json(await call("GET", path), 200).evidence;
      assert.equal(next.photos.find((photo) => photo.photoId === oldPhoto.id).available, false);
      const following = merge({ existing: next, revision: next.revision, medicineVersion: med.version, idempotencyKey: key(),
        uploadedPhotos: [], photoIdMap: {}, fieldSources: { specification: { source: "manual", photoIds: [], reviewed: true } }, batchSources: [] });
      assert.equal(following.ok, true, following.reason);
      const secondResult = await sync.service.queueRecognitionEvidence(med.id, plain(following.payload));
      assert.equal(secondResult.status, "synced", JSON.stringify(secondResult));
      assert.equal(secondResult.reason, "stale");
      assert.equal(sync.service.getPendingRecognitionEvidence(med.id), null);
      assert.equal(json(await call("GET", path), 200).evidence.revision, 3);
    });

    await t.test("a lost acknowledgement superseded by another member preserves the first device's unique OCR intent", async () => {
      const med = json(await call("POST", "/medicines", { name: "旧回执合成药", batches: [] }), 201);
      const firstPhoto = await upload(med.id);
      const secondCode = randomUUID();
      gateway.registerCode(secondCode, `mini-second-${secondCode}`);
      const secondAuth = json(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code: secondCode } }), 200);
      const callSecond = (method, path, document) => app.inject({ method, url: `/api/v1${path}`,
        headers: { authorization: `Bearer ${secondAuth.token}` }, ...(document === undefined ? {} : { payload: document }) });
      const invitation = json(await call("POST", "/families/invitations"), 201);
      json(await callSecond("POST", "/families/invitations/accept", { code: invitation.invitationCode }), 200);
      const secondPhoto = json(await callSecond("POST", `/medicines/${med.id}/leaflet-photos`, {
        imageBase64: PNG, mimeType: "image/png", purpose: "box_front", uploadIntentKey: key(),
      }), 201).photo;
      const uniqueText = "  设备 A 的唯一 OCR 原文\n必须保留  ";
      const initial = merge({ existing: null, revision: 0, medicineVersion: med.version, idempotencyKey: key(),
        uploadedPhotos: [{ clientPhotoId: "device-a", photoId: firstPhoto.id, sequence: 1,
          review: { status: "recognized", fields: { name: med.name, rawOcrText: uniqueText }, warnings: [] } }],
        photoIdMap: { "device-a": firstPhoto.id },
        fieldSources: { name: { source: "recognized", photoIds: ["device-a"], reviewed: true } }, batchSources: [] });
      assert.equal(initial.ok, true, initial.reason);
      const original = plain(initial.payload);
      const path = `/medicines/${med.id}/recognition-evidence`;
      const acknowledgements = [];
      let loseFirstResponse = true;
      const backend = {
        getRecognitionEvidence: async (id) => json(await call("GET", `/medicines/${id}/recognition-evidence`), 200),
        getMedicine: async (id) => json(await call("GET", `/medicines/${id}`), 200),
        listLeafletPhotos: async (id) => json(await call("GET", `/medicines/${id}/leaflet-photos`), 200),
        saveRecognitionEvidence: async (id, document) => {
          const response = json(await call("POST", `/medicines/${id}/recognition-evidence`, document), 200);
          acknowledgements.push({ payload: plain(document), evidence: response.evidence });
          if (loseFirstResponse) { loseFirstResponse = false; throw new Error("synthetic lost response"); }
          return response;
        },
      };
      const sync = syncHarness(backend);
      const firstAttempt = await sync.service.queueRecognitionEvidence(med.id, original);
      assert.equal(firstAttempt.status, "pending");
      assert.equal(firstAttempt.reason, "network");
      assert.equal(acknowledgements[0].evidence.revision, 1);
      assert.deepEqual(plain(sync.service.getPendingRecognitionEvidence(med.id).payload), original);

      const newer = { schemaVersion: 1, revision: 1, medicineVersion: med.version, idempotencyKey: key(),
        photos: [original.photos[0], { photoId: secondPhoto.id, sequence: 2, status: "recognized",
          fields: { name: med.name, rawOcrText: "设备 B 的不同原文" }, warnings: [] }],
        fieldSources: { name: { source: "recognized", photoIds: [secondPhoto.id], reviewed: true } } };
      const savedByB = json(await callSecond("POST", path, newer), 200).evidence;
      assert.equal(savedByB.revision, 2);
      assert.equal(savedByB.medicineVersion, med.version);
      assert.equal(savedByB.photos.find((photo) => photo.photoId === firstPhoto.id).fields.rawOcrText, uniqueText);
      assert.equal(json(await call("GET", `/medicines/${med.id}`), 200).version, med.version);

      const replay = await sync.service.retryRecognitionEvidence(med.id);
      assert.equal(replay.status, "pending", JSON.stringify(replay));
      assert.equal(replay.reason, "stale");
      assert.equal(replay.acknowledged, true);
      assert.deepEqual(acknowledgements[1].payload, original);
      assert.equal(acknowledgements[1].evidence.revision, 1);
      assert.equal(acknowledgements[1].evidence.currentMedicineVersion, med.version);
      assert.equal(acknowledgements[1].evidence.stale, true);
      assert.equal(acknowledgements[1].evidence.photos[0].fields.rawOcrText, uniqueText);
      const held = plain(sync.service.getPendingRecognitionEvidence(med.id));
      assert.deepEqual(held.payload, original);
      assert.deepEqual(held.acknowledgement, { revision: 1, medicineVersion: med.version });
      assert.equal(held.payload.photos[0].fields.rawOcrText, uniqueText);

      const reviewed = await sync.service.prepareRecognitionEvidenceRecovery(med.id);
      assert.equal(reviewed.status, "acknowledged", JSON.stringify(reviewed));
      assert.equal(sync.service.getPendingRecognitionEvidence(med.id).payload.photos[0].fields.rawOcrText, uniqueText);
      assert.equal((await sync.service.queueRecognitionEvidence(med.id, original)).status, "existing");
      const latest = json(await call("GET", path), 200).evidence;
      assert.equal(latest.revision, 2);
      assert.equal(latest.photos[0].fields.rawOcrText, uniqueText);
      assert.equal(latest.photos[1].photoId, secondPhoto.id);
      assert.equal(latest.photos[1].fields.rawOcrText, "设备 B 的不同原文");
      assert.equal(acknowledgements.every((item) => item.payload.idempotencyKey === original.idempotencyKey), true);
    });

    await t.test("legacy unbound medicine-level lot source survives a miniprogram append without becoming current", async () => {
      const med = json(await call("POST", "/medicines", { name: "旧批号来源合成药", batches: [] }), 201);
      const oldPhoto = await upload(med.id);
      const newPhoto = await upload(med.id);
      const historicalText = "旧版照片原文：合成批号";
      const legacy = { schemaVersion: 1,
        photos: [{ photoId: oldPhoto.id, sequence: 1, status: "recognized",
          fields: { lotNumber: "合成批号", rawOcrText: historicalText }, warnings: ["旧来源待核对"] }],
        fieldSources: { lotNumber: { source: "recognized", photoIds: [oldPhoto.id], reviewed: true } } };
      // Synthetic pre-existing legacy state; new requests cannot create this old unbound source.
      await fixture.pool.query(`INSERT INTO medicine_recognition_evidence (family_id,medicine_id,revision,medicine_version,document)
        VALUES ($1,$2,1,$3,$4::jsonb)`, [family.id, med.id, med.version, JSON.stringify(legacy)]);
      const path = `/medicines/${med.id}/recognition-evidence`;
      const before = json(await call("GET", path), 200).evidence;
      assert.equal(before.stale, true);
      const input = { existing: before, revision: before.revision, medicineVersion: med.version, idempotencyKey: key(),
        uploadedPhotos: [{ clientPhotoId: "legacy-new", photoId: newPhoto.id, sequence: 1,
          review: { status: "recognized", fields: { name: med.name }, warnings: ["新增照片"] } }],
        photoIdMap: { "legacy-new": newPhoto.id },
        fieldSources: { name: { source: "recognized", photoIds: ["legacy-new"], reviewed: true } }, batchSources: [] };
      const next = merge(input);
      assert.equal(next.ok, true, next.reason);
      const intent = plain(next.payload);
      assert.deepEqual(intent.fieldSources.lotNumber, legacy.fieldSources.lotNumber);
      assert.equal(intent.photos[0].fields.rawOcrText, historicalText);
      assert.deepEqual(intent.photos.map((photo) => photo.sequence), [1, 2]);
      const posts = [];
      const sync = syncHarness({
        getRecognitionEvidence: async (id) => json(await call("GET", `/medicines/${id}/recognition-evidence`), 200),
        saveRecognitionEvidence: async (id, document) => {
          const response = json(await call("POST", `/medicines/${id}/recognition-evidence`, document), 200);
          posts.push(response.evidence);
          return response;
        },
      });
      const result = await sync.service.queueRecognitionEvidence(med.id, intent);
      assert.equal(result.status, "synced", JSON.stringify(result));
      assert.equal(result.reason, "stale");
      assert.equal(sync.service.getPendingRecognitionEvidence(med.id), null);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].revision, 2);
      assert.equal(posts[0].stale, true);
      assert.deepEqual(posts[0].fieldSources.lotNumber, legacy.fieldSources.lotNumber);
      const current = json(await call("GET", path), 200).evidence;
      assert.equal(current.photos[0].fields.rawOcrText, historicalText);
      assert.equal(current.photos[1].photoId, newPhoto.id);

      const clientMutation = merge({ ...input, existing: current, revision: current.revision,
        uploadedPhotos: [], photoIdMap: {}, fieldSources: { lotNumber: { source: "manual", photoIds: [], reviewed: false } } });
      assert.equal(clientMutation.ok, false);
      assert.equal(clientMutation.reason, "INVALID_FIELD");
      const clientAddition = merge({ ...input, existing: current, revision: current.revision,
        uploadedPhotos: [], photoIdMap: {}, fieldSources: { expiryValue: { source: "manual", photoIds: [], reviewed: false } } });
      assert.equal(clientAddition.ok, false);
      assert.equal(clientAddition.reason, "INVALID_FIELD");

      const changed = { ...intent, revision: 2, idempotencyKey: key(),
        fieldSources: { ...intent.fieldSources, lotNumber: { ...intent.fieldSources.lotNumber, reviewed: false } } };
      assert.equal((await call("POST", path, changed)).statusCode, 400);
      const added = { ...intent, revision: 2, idempotencyKey: key(),
        fieldSources: { ...intent.fieldSources, expiryValue: { source: "manual", photoIds: [], reviewed: false } } };
      assert.equal((await call("POST", path, added)).statusCode, 400);
      const after = json(await call("GET", path), 200).evidence;
      assert.equal(after.revision, 2);
      assert.deepEqual(after.fieldSources.lotNumber, legacy.fieldSources.lotNumber);
      assert.equal(after.photos[0].fields.rawOcrText, historicalText);
    });
  } finally {
    if (app) await app.close();
    await fixture.close();
    await rm(photoRoot, { recursive: true, force: true });
  }
});
