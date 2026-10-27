import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres } from "./helpers/isolated-pg.mjs";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";
const key = () => randomUUID().replaceAll("-", "");

test("evidence receipt metadata is bounded without forgetting promised keys", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL");
  const fixture = await isolatedPostgres(url);
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(fixture.pool);
    app = await buildServer({ database: fixture.database, wechatGateway: gateway, logger: false });
    const loginCode = randomUUID();
    gateway.registerCode(loginCode, `receipts-${loginCode}`);
    const auth = await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code: loginCode } });
    assert.equal(auth.statusCode, 200);
    const identity = auth.json();
    const call = (method, path, payload) => app.inject({ method, url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${identity.token}` }, ...(payload === undefined ? {} : { payload }) });
    const json = (response, expected) => { assert.equal(response.statusCode, expected, response.body); return response.json(); };
    const family = json(await call("POST", "/families", { name: "合成回执家庭" }), 201).family;
    const first = json(await call("POST", "/medicines", { name: "回执样本药", batches: [] }), 201);
    const other = json(await call("POST", "/medicines", { name: "另一样本药", batches: [] }), 201);
    const path = `/medicines/${first.id}/recognition-evidence`;
    const original = { schemaVersion: 1, revision: 0, medicineVersion: first.version, idempotencyKey: key(), photos: [], fieldSources: {} };
    const firstReceipt = json(await call("POST", path, original), 200).evidence;
    const second = { ...original, revision: 1, idempotencyKey: key() };
    json(await call("POST", path, second), 200);

    await t.test("replays reconstruct original content and never expose an old ACK as current", async () => {
      const replay = json(await call("POST", path, original), 200).evidence;
      assert.equal(replay.revision, firstReceipt.revision);
      assert.equal(replay.stale, true);
      assert.deepEqual(replay.photos, firstReceipt.photos);
      assert.deepEqual(replay.fieldSources, firstReceipt.fieldSources);
      assert.equal((await call("POST", `/medicines/${other.id}/recognition-evidence`, original)).statusCode, 409);
    });

    await t.test("restore creates a distinct medicine and cannot reuse an earlier key", async () => {
      const backup = json(await call("POST", "/backups/json", {}), 200);
      const preview = json(await call("POST", "/backups/preview", { backup }), 200);
      assert.equal(preview.valid, true);
      json(await call("POST", "/backups/restore", { backup, confirmed: true, confirmationToken: preview.confirmationToken }), 201);
      const medicines = json(await call("GET", "/medicines?includeArchived=true"), 200).medicines;
      const restored = medicines.find((item) => item.name === first.name && item.id !== first.id);
      assert.ok(restored);
      assert.equal((await call("POST", `/medicines/${restored.id}/recognition-evidence`, original)).statusCode, 409);
    });

    await t.test("receipt metadata never stores a duplicate evidence document", async () => {
      const columns = await fixture.pool.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'medicine_recognition_evidence_receipts'`, [fixture.schema]);
      assert.equal(columns.rows.some((row) => row.column_name === "document"), false);
    });

    await t.test("8192 receipts reject new writes, while same-key replay and cross-medicine conflict remain safe", async () => {
      await fixture.pool.query(`INSERT INTO medicine_recognition_evidence_receipts
        SELECT (jsonb_populate_record(NULL::medicine_recognition_evidence_receipts, jsonb_build_object(
          'family_id', $1::uuid, 'user_id', $2::uuid, 'medicine_id', $3::uuid,
          'request_key', 'synthetic_' || lpad(i::text, 16, '0'), 'payload_hash', repeat('a', 64),
          'revision', 1, 'medicine_version', 1, 'document', '{}'::jsonb, 'created_at', now()))).*
        FROM generate_series(1,8190) AS i`, [family.id, identity.user.id, first.id]);
      const count = await fixture.pool.query("SELECT count(*)::int AS total FROM medicine_recognition_evidence_receipts WHERE family_id=$1", [family.id]);
      assert.equal(count.rows[0].total, 8192);
      assert.equal((await call("POST", path, original)).statusCode, 200);
      assert.equal((await call("POST", `/medicines/${other.id}/recognition-evidence`, original)).statusCode, 409);
      const fresh = { ...original, revision: 2, idempotencyKey: key() };
      const blocked = await call("POST", path, fresh);
      assert.equal(blocked.statusCode, 429, blocked.body);
      assert.equal(blocked.json().error.code, "RATE_LIMITED");
      assert.equal(json(await call("GET", path), 200).evidence.revision, 2);
      const after = await fixture.pool.query("SELECT count(*)::int AS total FROM medicine_recognition_evidence_receipts WHERE family_id=$1", [family.id]);
      assert.equal(after.rows[0].total, 8192);
    });
  } finally {
    if (app) await app.close();
    await fixture.close();
  }
});
