import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres } from "./helpers/isolated-pg.mjs";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";

test("backup keeps complete data by default and offers explicit inventory-only export", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL");
  const fixture = await isolatedPostgres(url);
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(fixture.pool);
    app = await buildServer({ database: fixture.database, wechatGateway: gateway, logger: false });
    async function family() {
      const code = randomUUID();
      gateway.registerCode(code, `inventory-backup-${code}`);
      const auth = await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } });
      assert.equal(auth.statusCode, 200);
      const user = { token: auth.json().token, id: auth.json().user.id };
      const created = await call(user, "POST", "/families", { name: "合成备份家庭" });
      assert.equal(created.statusCode, 201);
      return { user, id: created.json().family.id };
    }
    const call = (user, method, path, payload) => app.inject({ method, url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${user.token}` }, ...(payload === undefined ? {} : { payload }) });
    const json = (response, expected) => { assert.equal(response.statusCode, expected, response.body); return response.json(); };
    const a = await family();
    const med = json(await call(a.user, "POST", "/medicines", { name: "来源样本药", batches: [] }), 201);
    json(await call(a.user, "POST", `/medicines/${med.id}/recognition-evidence`, { schemaVersion: 1, revision: 0,
      medicineVersion: med.version, idempotencyKey: randomUUID().replaceAll("-", ""), photos: [], fieldSources: {} }), 200);

    await t.test("default exports complete sources; explicit false exports labeled v2 inventory only", async () => {
      const full = json(await call(a.user, "POST", "/backups/json", {}), 200);
      assert.equal(full.contentScope, "inventory_and_recognition_evidence");
      assert.ok(full.medicines[0].recognitionEvidence);
      const inventory = json(await call(a.user, "POST", "/backups/json", { includeRecognitionEvidence: false }), 200);
      assert.equal(inventory.schemaVersion, 2);
      assert.equal(inventory.contentScope, "inventory_only");
      assert.equal("recognitionEvidence" in inventory.medicines[0], false);
      const preview = json(await call(a.user, "POST", "/backups/preview", { backup: inventory }), 200);
      assert.equal(preview.valid, true);
      const mislabeled = structuredClone(full);
      mislabeled.contentScope = "inventory_only";
      assert.equal(json(await call(a.user, "POST", "/backups/preview", { backup: mislabeled }), 200).valid, false);
      const tampered = { ...inventory, contentScope: "inventory_and_recognition_evidence" };
      assert.equal((await call(a.user, "POST", "/backups/restore", {
        backup: tampered, confirmed: true, confirmationToken: preview.confirmationToken,
      })).statusCode, 409);
      assert.equal(json(await call(a.user, "GET", "/medicines"), 200).medicines.length, 1);
      assert.ok(json(await call(a.user, "GET", `/medicines/${med.id}/recognition-evidence`), 200).evidence);
    });

    await t.test("scope option is explicit and never bypasses family authentication", async () => {
      for (const value of [null, "false", 0]) {
        assert.equal((await call(a.user, "POST", "/backups/json", { includeRecognitionEvidence: value })).statusCode, 400);
      }
      const anonymous = await app.inject({ method: "POST", url: "/api/v1/backups/json", payload: { includeRecognitionEvidence: false } });
      assert.equal(anonymous.statusCode, 401);
      const b = await family();
      const other = json(await call(b.user, "POST", "/backups/json", { includeRecognitionEvidence: false }), 200);
      assert.equal(other.medicines.length, 0);
    });

    await t.test("large complete backup fails explicitly without deleting sources; inventory-only remains restorable", async () => {
      const big = await family();
      const inserted = await fixture.pool.query(`INSERT INTO medicines (family_id,name,created_by,updated_by)
        SELECT $1, '大备份样本-' || i::text, $2, $2 FROM generate_series(1,54) AS i RETURNING id`, [big.id, big.user.id]);
      for (const row of inserted.rows) {
        const ids = Array.from({ length: 8 }, () => randomUUID());
        await fixture.pool.query(`INSERT INTO medicine_leaflet_photos
          (id,family_id,medicine_id,storage_key,content_type,size_bytes,source,created_by,upload_completed_at,deleted_at,storage_removed_at)
          SELECT x.id,$1,$2,'synthetic/' || x.id::text || '.png','image/png',1,'synthetic',$3,now(),now(),now()
          FROM unnest($4::uuid[]) AS x(id)`, [big.id, row.id, big.user.id, ids]);
        const document = { schemaVersion: 1, photos: ids.map((photoId, index) => ({ photoId, sequence: index + 1,
          status: "recognized", fields: { leafletText: "x".repeat(30_000) } })), fieldSources: {} };
        await fixture.pool.query(`INSERT INTO medicine_recognition_evidence (family_id,medicine_id,revision,medicine_version,document)
          VALUES ($1,$2,1,1,$3::jsonb)`, [big.id, row.id, JSON.stringify(document)]);
      }
      assert.equal((await call(big.user, "POST", "/backups/json", {})).statusCode, 413);
      const count = await fixture.pool.query("SELECT count(*)::int AS total FROM medicine_recognition_evidence WHERE family_id=$1", [big.id]);
      assert.equal(count.rows[0].total, 54);
      const inventory = json(await call(big.user, "POST", "/backups/json", { includeRecognitionEvidence: false }), 200);
      assert.equal(inventory.contentScope, "inventory_only");
      assert.equal(inventory.medicines.length, 54);
      assert.ok(inventory.medicines.every((item) => !("recognitionEvidence" in item)));
      assert.equal(json(await call(big.user, "POST", "/backups/preview", { backup: inventory }), 200).valid, true);
    });
  } finally {
    if (app) await app.close();
    await fixture.close();
  }
});
