import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { buildServer } from "../dist/app.js";
import { applyMigrations } from "../dist/db/migrations.js";
import { RecognitionUnavailableError } from "../dist/services/medicine-recognition.js";
import { MedicineCatalogUnavailableError } from "../dist/services/medicine-catalog.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres } from "./helpers/isolated-pg.mjs";

// Real API routes, migration receipts and PostgreSQL persistence; synthetic
// identities/image envelope and stub providers only. No HTTP listener, model,
// private-photo storage, device acceptance, DATABASE_URL fallback or revocation.
const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
test("real PG: recognition and barcode candidates require explicit inventory confirmation across restart", {
  skip: !url && process.env.REQUIRE_POSTGRES_TESTS !== "1",
  timeout: 60_000,
}, async () => {
  assert.ok(url, "TEST_DATABASE_URL is required when REQUIRE_POSTGRES_TESTS=1");
  const fixture = await isolatedPostgres(url);
  const gateway = createTestGateway();
  const barcode = "6900000000012";
  let failRecognition = false;
  let failCatalog = false;
  const calls = { recognition: 0, catalog: 0 };
  const providers = {
    medicineRecognitionProvider: { async recognize() {
      calls.recognition++;
      if (failRecognition) throw new RecognitionUnavailableError("synthetic unavailable", "provider_unavailable");
      return { draft: { name: "Synthetic recognized medicine", brand: "Synthetic brand",
        specification: "20 tablets", manufacturer: "Synthetic manufacturer", approvalNumber: null,
        purposeCategory: null, lotNumber: "synthetic-reviewed-lot", expiryValue: "2099-12",
        expiryPrecision: "month", populationTags: [], purposeTags: [],
        leaflet: { text: null, purposeSummary: null, packageUsageSummary: null,
          contraindicationsSummary: null, precautionsSummary: null } },
      warnings: ["Synthetic candidate; review required"], requiresConfirmation: true };
    } },
    medicineCatalogProvider: { kind: "local", async search(query) {
      calls.catalog++;
      if (failCatalog) throw new MedicineCatalogUnavailableError("synthetic unavailable");
      return { candidates: query.barcode === barcode ? [{ name: "Synthetic catalog medicine",
        specification: "20 tablets", barcodeValue: barcode, activeIngredients: [],
        leaflet: { purposeSummary: "Synthetic package statement", reviewStatus: "unverified" },
        source: "synthetic stub", sourceUpdatedAt: null, matchReasons: ["Synthetic exact barcode"] }] : [],
      warnings: ["Synthetic catalog; manual review required"] };
    } },
  };
  let app;
  async function open() {
    return buildServer({ database: fixture.database, wechatGateway: gateway, ...providers, logger: false });
  }
  async function request(identity, method, path, payload, status = 200) {
    const result = await app.inject({ method, url: `/api/v1${path}`,
      headers: identity ? { authorization: `Bearer ${identity.token}`,
        ...(identity.familyId ? { "x-family-id": identity.familyId } : {}) } : {},
      ...(payload === undefined ? {} : { payload }) });
    // Do not emit tokens, family identifiers, request bodies or raw logs.
    assert.equal(result.statusCode, status, `${method} synthetic operation: expected ${status}`);
    return result.json();
  }
  async function inventorySnapshot() {
    return (await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM medicines) AS medicines,
      (SELECT count(*)::int FROM medicine_batches) AS batches,
      (SELECT count(*)::int FROM medicine_leaflet_photos) AS photos,
      (SELECT count(*)::int FROM medicine_create_receipts) AS receipts`)).rows[0];
  }
  async function inventoryFingerprint() {
    // Compare all stored medicine/batch fields without printing identifiers.
    return (await fixture.pool.query(`SELECT
      md5(COALESCE((SELECT string_agg(row_to_json(m)::text, '' ORDER BY id) FROM medicines m), '')) AS medicines,
      md5(COALESCE((SELECT string_agg(row_to_json(b)::text, '' ORDER BY id) FROM medicine_batches b), '')) AS batches`)).rows[0];
  }
  try {
    await applyMigrations(fixture.pool);
    app = await open();
    const identities = [];
    for (let index = 0; index < 2; index++) {
      const code = randomUUID(); gateway.registerCode(code, `synthetic-recognition-${code}`);
      const login = await request(null, "POST", "/auth/wechat", { code });
      assert.ok(login.token);
      const identity = { token: login.token };
      identity.familyId = (await request(identity, "POST", "/families", { name: `Synthetic recognition household ${index}` }, 201)).family.id;
      identities.push(identity);
    }
    const image = Buffer.alloc(128);
    image.set([0xff, 0xd8, 0xff]); image.set([0xff, 0xd9], 126);
    const recognitionInput = { imageBase64: image.toString("base64"), mimeType: "image/jpeg", purpose: "box_front" };
    const empty = { medicines: 0, batches: 0, photos: 0, receipts: 0 };
    await request(null, "POST", "/recognitions/medicine", recognitionInput, 401);
    await request(null, "POST", "/medicine-catalog/candidates", { barcode, consentToShare: false }, 401);
    assert.deepEqual(calls, { recognition: 0, catalog: 0 });
    const confirmations = [];
    for (const identity of identities) {
      const recognized = await request(identity, "POST", "/recognitions/medicine", recognitionInput);
      assert.equal(recognized.requiresConfirmation, true);
      assert.equal(recognized.draft.name, "Synthetic recognized medicine");
      assert.equal(recognized.draft.specification, "20 tablets");
      assert.equal(recognized.draft.expiryValue, "2099-12");
      assert.equal(recognized.draft.expiryPrecision, "month");
      const catalog = await request(identity, "POST", "/medicine-catalog/candidates", { barcode, consentToShare: false });
      assert.equal(catalog.candidates[0].barcodeValue, barcode);
      assert.equal(catalog.candidates[0].leaflet.reviewStatus, "unverified");
      const miss = await request(identity, "POST", "/medicine-catalog/candidates", { barcode: "6900000000099", consentToShare: false });
      assert.deepEqual(miss.candidates, []);
      assert.deepEqual(await inventorySnapshot(), empty, "candidate routes must not create inventory or photos");
      // This API caller explicitly simulates the human review decision. Candidate
      // output is not automatically posted, nor is this proof of the native UI.
      confirmations.push({ identity, payload: { idempotencyKey: randomUUID(),
        name: `${recognized.draft.name} reviewed ${confirmations.length}`,
        specification: catalog.candidates[0].specification, barcodeValue: barcode,
        brand: recognized.draft.brand, manufacturer: recognized.draft.manufacturer,
        batches: [{ quantity: 2, unit: "box", lotNumber: recognized.draft.lotNumber,
          expiry: { value: recognized.draft.expiryValue, precision: recognized.draft.expiryPrecision },
          storageLocation: "synthetic-reviewed-shelf" }] } });
    }
    failRecognition = true; failCatalog = true;
    for (const identity of identities) {
      const failedPhoto = await request(identity, "POST", "/recognitions/medicine", recognitionInput, 503);
      assert.equal(failedPhoto.error.code, "RECOGNITION_UNAVAILABLE");
      const failedCode = await request(identity, "POST", "/medicine-catalog/candidates", { barcode, consentToShare: false }, 503);
      assert.equal(failedCode.error.code, "MEDICINE_CATALOG_UNAVAILABLE");
    }
    assert.deepEqual(await inventorySnapshot(), empty, "provider failures must not create inventory");
    for (const confirmation of confirmations) {
      const saved = await request(confirmation.identity, "POST", "/medicines", confirmation.payload, 201);
      confirmation.saved = saved;
      assert.equal(saved.batches.length, 1);
    }
    assert.deepEqual(await inventorySnapshot(), { medicines: 2, batches: 2, photos: 0, receipts: 2 });
    await app.close(); app = null;
    app = await open(); // Same isolated database, new server instance and caches.
    for (let index = 0; index < confirmations.length; index++) {
      const { identity, payload, saved } = confirmations[index];
      const replay = await request(identity, "POST", "/medicines", payload, 201);
      assert.equal(replay.id, saved.id);
      assert.equal(replay.batches[0].id, saved.batches[0].id);
      const detail = await request(identity, "GET", `/medicines/${saved.id}`);
      assert.equal(detail.name, payload.name);
      assert.equal(detail.specification, payload.specification);
      assert.equal(detail.brand, payload.brand);
      assert.equal(detail.manufacturer, payload.manufacturer);
      assert.equal(detail.barcodeValue, barcode);
      assert.equal(detail.batches[0].quantity, 2);
      assert.equal(detail.batches[0].unit, "box");
      assert.equal(detail.batches[0].lotNumber, "synthetic-reviewed-lot");
      assert.deepEqual(detail.batches[0].expiry, payload.batches[0].expiry);
      assert.equal(detail.batches[0].storageLocation, "synthetic-reviewed-shelf");
      const list = await request(identity, "GET", "/medicines");
      assert.deepEqual(list.medicines.map(medicine => medicine.id), [saved.id]);
      await request(identities[1 - index], "GET", `/medicines/${saved.id}`, undefined, 404);
      const before = await inventorySnapshot();
      const contentBefore = await inventoryFingerprint();
      await request(identity, "POST", "/recognitions/medicine", recognitionInput, 503);
      // Use a different code so the household's saved catalog cannot satisfy it.
      await request(identity, "POST", "/medicine-catalog/candidates", { barcode: "6900000000099", consentToShare: false }, 503);
      assert.deepEqual(await inventorySnapshot(), before);
      assert.deepEqual(await inventoryFingerprint(), contentBefore, "failed providers must not mutate saved inventory fields");
    }
    assert.deepEqual(await inventorySnapshot(), { medicines: 2, batches: 2, photos: 0, receipts: 2 });
    assert.deepEqual(calls, { recognition: 6, catalog: 8 });
  } finally {
    if (app) await app.close();
    await fixture.close();
  }
});
