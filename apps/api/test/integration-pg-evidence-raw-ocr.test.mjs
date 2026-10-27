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

test("raw OCR text round-trips as private per-photo evidence", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL");
  const fixture = await isolatedPostgres(url);
  const photoRoot = await mkdtemp(join(tmpdir(), "medbox-raw-ocr-"));
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(fixture.pool);
    app = await buildServer({ database: fixture.database, wechatGateway: gateway,
      privatePhotoStore: new PrivatePhotoStore(photoRoot), logger: false });
    const call = (user, method, path, payload) => app.inject({ method, url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${user.token}` }, ...(payload === undefined ? {} : { payload }) });
    const json = (response, expected) => { assert.equal(response.statusCode, expected, response.body); return response.json(); };
    async function family() {
      const code = randomUUID();
      gateway.registerCode(code, `raw-ocr-${code}`);
      const auth = json(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      const user = { token: auth.token, id: auth.user.id };
      const created = json(await call(user, "POST", "/families", { name: "原文合成家庭" }), 201);
      return { user, id: created.family.id };
    }
    const a = await family();
    const b = await family();
    const medicine = json(await call(a.user, "POST", "/medicines", { name: "合成原文药", batches: [] }), 201);
    const photo = json(await call(a.user, "POST", `/medicines/${medicine.id}/leaflet-photos`, {
      imageBase64: PNG, mimeType: "image/png", purpose: "box_front", uploadIntentKey: key(),
    }), 201).photo;
    const path = `/medicines/${medicine.id}/recognition-evidence`;
    const raw = "  合成OCR原文\n第二行\t不截断  ";
    const payload = { schemaVersion: 1, revision: 0, medicineVersion: medicine.version, idempotencyKey: key(),
      photos: [{ photoId: photo.id, sequence: 1, status: "recognized", fields: { rawOcrText: raw }, warnings: ["人工核对"] }],
      fieldSources: {} };

    await t.test("save, retry and GET preserve whitespace and line breaks exactly", async () => {
      const saved = json(await call(a.user, "POST", path, payload), 200).evidence;
      assert.equal(saved.photos[0].fields.rawOcrText, raw);
      assert.deepEqual(saved.photos[0].warnings, ["人工核对"]);
      assert.equal(json(await call(a.user, "POST", path, payload), 200).evidence.photos[0].fields.rawOcrText, raw);
      assert.equal(json(await call(a.user, "GET", path), 200).evidence.photos[0].fields.rawOcrText, raw);
      assert.equal((await call(a.user, "POST", path, { ...payload,
        photos: [{ ...payload.photos[0], fields: { rawOcrText: `${raw}!` } }] })).statusCode, 409);
    });

    await t.test("empty, non-string, oversized or medicine-level raw OCR claims are rejected", async () => {
      for (const invalid of ["", null, ["not a string"], "x".repeat(32 * 1024)]) {
        const attempt = { ...payload, revision: 1, idempotencyKey: key(),
          photos: [{ ...payload.photos[0], fields: { rawOcrText: invalid } }] };
        assert.equal((await call(a.user, "POST", path, attempt)).statusCode, 400);
      }
      for (const source of [
        { source: "manual", photoIds: [], reviewed: true },
        { source: "recognized", photoIds: [photo.id], reviewed: true },
      ]) {
        const attempt = { ...payload, revision: 1, idempotencyKey: key(), fieldSources: { rawOcrText: source } };
        assert.equal((await call(a.user, "POST", path, attempt)).statusCode, 400);
      }
      assert.equal(json(await call(a.user, "GET", path), 200).evidence.revision, 1);
    });

    await t.test("complete backup and restore preserve raw OCR without including the photo file", async () => {
      const backup = json(await call(a.user, "POST", "/backups/json", {}), 200);
      assert.equal(backup.medicines[0].recognitionEvidence.photos[0].fields.rawOcrText, raw);
      assert.equal(JSON.stringify(backup).includes(PNG), false);
      const invalid = structuredClone(backup);
      invalid.medicines[0].recognitionEvidence.fieldSources.rawOcrText = { source: "manual", photoIds: [], reviewed: true };
      assert.equal(json(await call(b.user, "POST", "/backups/preview", { backup: invalid }), 200).valid, false);
      const preview = json(await call(b.user, "POST", "/backups/preview", { backup }), 200);
      assert.equal(preview.valid, true, JSON.stringify(preview.errors));
      json(await call(b.user, "POST", "/backups/restore", { backup, confirmed: true, confirmationToken: preview.confirmationToken }), 201);
      const restored = json(await call(b.user, "GET", "/medicines?includeArchived=true"), 200).medicines.find((item) => item.name === medicine.name);
      const evidence = json(await call(b.user, "GET", `/medicines/${restored.id}/recognition-evidence`), 200).evidence;
      assert.equal(evidence.stale, true);
      assert.equal(evidence.photos[0].available, false);
      assert.equal(evidence.photos[0].fields.rawOcrText, raw);
    });
  } finally {
    if (app) await app.close();
    await fixture.close();
    await rm(photoRoot, { recursive: true, force: true });
  }
});
