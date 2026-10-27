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

test("recognized sources bind to current values and unavailable photos cannot gain new confirmation", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL");
  const fixture = await isolatedPostgres(url);
  const photoRoot = await mkdtemp(join(tmpdir(), "medbox-evidence-semantics-"));
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(fixture.pool);
    app = await buildServer({ database: fixture.database, wechatGateway: gateway,
      privatePhotoStore: new PrivatePhotoStore(photoRoot), logger: false });
    const loginCode = randomUUID();
    gateway.registerCode(loginCode, `semantic-${loginCode}`);
    const auth = await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code: loginCode } });
    assert.equal(auth.statusCode, 200);
    const token = auth.json().token;
    const call = (method, path, payload) => app.inject({ method, url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) });
    function json(response, expected) {
      assert.equal(response.statusCode, expected, response.body);
      return expected === 204 ? null : response.json();
    }
    json(await call("POST", "/families", { name: "合成语义家庭" }), 201);
    async function medicine(fields = {}) {
      return json(await call("POST", "/medicines", { name: "语义样本药", batches: [], ...fields }), 201);
    }
    async function photo(medicineId) {
      return json(await call("POST", `/medicines/${medicineId}/leaflet-photos`, {
        imageBase64: PNG, mimeType: "image/png", purpose: "box_front", uploadIntentKey: key(),
      }), 201).photo;
    }
    const source = (photoIds, reviewed = true) => ({ source: "recognized", photoIds, reviewed });
    const doc = (medicineId, medicineVersion, photos, fieldSources, revision = 0) => ({
      path: `/medicines/${medicineId}/recognition-evidence`,
      body: { schemaVersion: 1, revision, medicineVersion, idempotencyKey: key(), photos, fieldSources },
    });

    await t.test("a different recognized value must not become the current medicine's source", async () => {
      const med = await medicine({ brand: "测试牌", specification: "10片", manufacturer: "合成药厂",
        approvalNumber: "国药准字H12345678", barcodeValue: "6901234567890", activeIngredients: ["甲成分", "乙成分"],
        purposeCategory: "家庭用途", populationTags: ["adult", "child"], purposeTags: ["fever", "pain"],
        leaflet: { purposeSummary: "用途摘要", packageUsageSummary: "用法摘要", contraindicationsSummary: "禁忌摘要", precautionsSummary: "注意摘要" } });
      const p = await photo(med.id);
      const fields = ["name", "brand", "specification", "manufacturer", "approvalNumber", "barcodeValue",
        "activeIngredients", "purposeCategory", "populationTags", "purposeTags", "purposeSummary",
        "packageUsageSummary", "contraindicationsSummary", "precautionsSummary"];
      for (const field of fields) {
        const wrong = ["activeIngredients", "populationTags", "purposeTags"].includes(field) ? ["另一项"] : "另一内容";
        const attempt = doc(med.id, med.version, [{ photoId: p.id, sequence: 1, status: "recognized", fields: { [field]: wrong } }],
          { [field]: source([p.id]) });
        assert.equal((await call("POST", attempt.path, attempt.body)).statusCode, 400, `mismatched field ${field} must be rejected`);
      }
      assert.equal(json(await call("GET", `/medicines/${med.id}/recognition-evidence`), 200).evidence, null);
    });

    await t.test("all selected photos and the saved value must match after trimming only", async () => {
      const med = await medicine({ brand: "测试牌", specification: "10片", manufacturer: "合成药厂",
        approvalNumber: "国药准字H12345678", activeIngredients: ["甲成分", "乙成分"],
        purposeCategory: "家庭用途", populationTags: ["adult", "child"], purposeTags: ["fever", "pain"],
        leaflet: { purposeSummary: "用途摘要", packageUsageSummary: "用法摘要", contraindicationsSummary: "禁忌摘要", precautionsSummary: "注意摘要" } });
      const p1 = await photo(med.id);
      const p2 = await photo(med.id);
      const values = { name: "语义样本药", brand: "测试牌", specification: "10片", manufacturer: "合成药厂",
        approvalNumber: "国药准字H12345678", activeIngredients: ["甲成分", "乙成分"], purposeCategory: "家庭用途",
        populationTags: ["adult", "child"], purposeTags: ["fever", "pain"], purposeSummary: "用途摘要",
        packageUsageSummary: "用法摘要", contraindicationsSummary: "禁忌摘要", precautionsSummary: "注意摘要" };
      const sources = Object.fromEntries(Object.keys(values).map((field) => [field, source([p1.id, p2.id])]));
      const photos = [{ photoId: p1.id, sequence: 1, status: "recognized", fields: values },
        { photoId: p2.id, sequence: 2, status: "recognized", fields: { ...values, name: "另一药名" } }];
      const conflict = doc(med.id, med.version, photos, sources);
      assert.equal((await call("POST", conflict.path, conflict.body)).statusCode, 400);
      photos[1].fields.name = " 语义样本药 ";
      photos[1].fields.populationTags = ["child", " adult ", "adult"];
      photos[1].fields.purposeTags = ["pain", "fever", "fever"];
      const matched = doc(med.id, med.version, photos, sources);
      const saved = json(await call("POST", matched.path, matched.body), 200).evidence;
      assert.equal(saved.revision, 1);
      assert.equal(saved.stale, false);
      assert.deepEqual(saved.fieldSources.name.photoIds, [p1.id, p2.id]);
    });

    await t.test("a deleted photo cannot gain a source or reviewed status, but an existing claim can be explicitly changed", async () => {
      const med = await medicine({ brand: "测试牌" });
      const p = await photo(med.id);
      const photos = [{ photoId: p.id, sequence: 1, status: "recognized", fields: { name: med.name, brand: "测试牌" } }];
      const initial = doc(med.id, med.version, photos, { name: source([p.id], false) });
      json(await call("POST", initial.path, initial.body), 200);
      json(await call("DELETE", `/medicines/${med.id}/leaflet-photos/${p.id}`), 204);
      const promoted = doc(med.id, med.version, photos, { name: source([p.id], true) }, 1);
      assert.equal((await call("POST", promoted.path, promoted.body)).statusCode, 409);
      const added = doc(med.id, med.version, photos, { name: source([p.id], false), brand: source([p.id], false) }, 1);
      assert.equal((await call("POST", added.path, added.body)).statusCode, 409);
      const unchanged = doc(med.id, med.version, photos, { name: source([p.id], false) }, 1);
      assert.equal(json(await call("POST", unchanged.path, unchanged.body), 200).evidence.revision, 2);
      const removed = doc(med.id, med.version, photos, { name: { source: "removed", photoIds: [], reviewed: false } }, 2);
      assert.equal(json(await call("POST", removed.path, removed.body), 200).evidence.revision, 3);
      const reintroduced = doc(med.id, med.version, photos, { name: source([p.id], false) }, 3);
      assert.equal((await call("POST", reintroduced.path, reintroduced.body)).statusCode, 409);
      assert.equal(json(await call("GET", removed.path), 200).evidence.revision, 3);
    });

    await t.test("previously persisted contradictory sources are read as stale and cannot be revalidated unchanged", async () => {
      const med = await medicine();
      const p = await photo(med.id);
      const conflicting = { schemaVersion: 1,
        photos: [{ photoId: p.id, sequence: 1, status: "recognized", fields: { name: "另一药名" } }],
        fieldSources: { name: source([p.id]) } };
      const membership = await fixture.pool.query("SELECT family_id FROM family_members WHERE user_id = $1", [auth.json().user.id]);
      await fixture.pool.query(`INSERT INTO medicine_recognition_evidence
        (family_id, medicine_id, revision, medicine_version, document) VALUES ($1,$2,1,$3,$4::jsonb)`,
      [membership.rows[0].family_id, med.id, med.version, JSON.stringify(conflicting)]);
      const path = `/medicines/${med.id}/recognition-evidence`;
      assert.equal(json(await call("GET", path), 200).evidence.stale, true);
      const resubmit = { ...conflicting, revision: 1, medicineVersion: med.version, idempotencyKey: key() };
      assert.equal((await call("POST", path, resubmit)).statusCode, 400);
    });
  } finally {
    if (app) await app.close();
    await fixture.close();
    await rm(photoRoot, { recursive: true, force: true });
  }
});
