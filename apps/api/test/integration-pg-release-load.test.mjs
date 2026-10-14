import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildServer } from "../dist/app.js";
import { applyMigrations } from "../dist/db/migrations.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres, bounded } from "./helpers/isolated-pg.mjs";

// Ordinary CI synthetic integration only. No DATABASE_URL fallback, real
// providers, lifecycle/revocation experiments, sockets or production capacity claim.
const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const levels = [1, 4, 8];
const repetitions = 2;

test("release mixed load: stable identities at concurrency 1/4/8 preserve content and recover retries", {
  skip: !url && process.env.REQUIRE_POSTGRES_TESTS !== "1",
  timeout: 180_000,
}, async t => {
  assert.ok(url, "TEST_DATABASE_URL is required when REQUIRE_POSTGRES_TESTS=1");
  const fixture = await isolatedPostgres(url);
  const gateway = createTestGateway();
  const providerCalls = { catalog: 0, recognition: 0 };
  let app;
  const inFlight = new Set();
  let samples = [];
  let failedRequests = 0;
  try {
    await applyMigrations(fixture.pool);
    app = await buildServer({
      database: fixture.database, wechatGateway: gateway, logger: false,
      medicineCatalogProvider: { kind: "local", async search() {
        providerCalls.catalog++;
        return { candidates: [{ name: "Synthetic catalog", specification: null, manufacturer: null,
          approvalNumber: null, activeIngredients: [], leaflet: null,
          source: "synthetic stub", sourceUpdatedAt: null, matchReasons: [] }], warnings: [] };
      } },
      medicineRecognitionProvider: { async recognize() {
        providerCalls.recognition++;
        return { draft: { name: "Synthetic recognition", specification: null, manufacturer: null,
          approvalNumber: null, purposeCategory: null, lotNumber: null, expiryValue: null,
          expiryPrecision: null }, warnings: [], requiresConfirmation: true };
      } },
    });
    async function request(identity, method, path, payload, status = 200) {
      const started = performance.now();
      const injection = app.inject({ method, url: `/api/v1${path}`,
        headers: identity ? { authorization: `Bearer ${identity.token}`,
          ...(identity.familyId ? { "x-family-id": identity.familyId } : {}) } : {},
        ...(payload === undefined ? {} : { payload }),
      });
      inFlight.add(injection);
      injection.then(() => inFlight.delete(injection), () => inFlight.delete(injection));
      const result = await bounded(injection, `synthetic ${method} request`, 15_000);
      samples.push(performance.now() - started);
      if (result.statusCode !== status) {
        failedRequests++;
        t.diagnostic(JSON.stringify({ layer: "SYNTHETIC", failedRequests, expectedStatus: status,
          actualStatus: result.statusCode, operation: `${method} ${path}` }));
      }
      // Do not print tokens or response bodies on failure.
      assert.equal(result.statusCode, status, `${method} ${path}: expected ${status}`);
      return status === 204 ? null : result.json();
    }
    const identities = [];
    for (let index = 0; index < 8; index++) {
      const code = randomUUID();
      gateway.registerCode(code, `release-load-${code}`);
      const login = await request(null, "POST", "/auth/wechat", { code });
      const created = await request({ token: login.token }, "POST", "/families", { name: `Synthetic load ${index}` }, 201);
      const identity = { token: login.token, familyId: created.family.id, index, created: [] };
      identity.profile = await request(identity, "POST", "/care-profiles/self", {}, 201);
      identities.push(identity);
    }
    // Valid JPEG envelope is synthetic: no decoder or model accuracy claim.
    const bytes = Buffer.alloc(128, 0);
    bytes.set([0xff, 0xd8, 0xff]); bytes.set([0xff, 0xd9], 126);
    let cycles = 0;
    async function cycle(identity, level, round) {
      const name = `Synthetic load ${identity.index}-${level}-${round}`;
      const current = await request(identity, "GET", "/families/current");
      assert.equal(current.family.id, identity.familyId);
      const medicine = await request(identity, "POST", "/medicines", { name,
        barcodeValue: `load-${identity.index}-${level}-${round}`,
        batches: [{ quantity: 2, unit: "box", lotNumber: "synthetic-lot",
          expiry: { value: "2099-12", precision: "month" }, storageLocation: "synthetic-shelf" }],
      }, 201);
      identity.created.push(medicine.id);
      const batch = medicine.batches[0];
      await request(identity, "POST", `/medicines/${medicine.id}/batches/${batch.id}/quantity`,
        { quantity: 3, version: batch.version });
      await request(identity, "POST", `/medicines/${medicine.id}/batches/${batch.id}/quantity`,
        { quantity: 99, version: batch.version }, 409);
      let detail = await request(identity, "GET", `/medicines/${medicine.id}`);
      await request(identity, "POST", `/medicines/${medicine.id}/low-stock-threshold`,
        { lowStockThreshold: { quantity: 1, unit: "box" }, version: detail.version });
      detail = await request(identity, "GET", `/medicines/${medicine.id}`);
      assert.equal(detail.batches.length, 1);
      assert.equal(detail.batches[0].quantity, 3);
      assert.equal(detail.batches[0].lotNumber, "synthetic-lot");
      assert.deepEqual(detail.batches[0].expiry, { value: "2099-12", precision: "month" });
      assert.equal(detail.batches[0].storageLocation, "synthetic-shelf");
      const other = identities[(identity.index + 1) % identities.length];
      await request(other, "GET", `/medicines/${medicine.id}`, undefined, 404);
      // New private plan plus committed retry only; never edit its binding,
      // revoke grants or call pause/resume/end/occurrence-confirm endpoints.
      const planInput = { careProfileId: identity.profile.id, medicineName: name,
        dosageText: "Owner supplied synthetic note", timeSlots: ["09:00"],
        startDate: "2099-01-01", idempotencyKey: randomUUID() };
      const plan = await request(identity, "POST", "/medication-plans", planInput, 201);
      const retry = await request(identity, "POST", "/medication-plans", planInput, 201);
      assert.equal(retry.planId, plan.planId);
      const plans = await request(identity, "GET", "/medication-plans");
      assert.ok(plans.plans.some(item => item.id === plan.planId));
      await request(identity, "GET", `/medication-plans/${plan.planId}`);
      const catalog = await request(identity, "POST", "/medicine-catalog/candidates", { name: "Synthetic absent catalog name", consentToShare: false });
      assert.equal(catalog.candidates[0].source, "synthetic stub");
      const recognition = await request(identity, "POST", "/recognitions/medicine",
        { imageBase64: bytes.toString("base64"), mimeType: "image/jpeg", purpose: "box_front" });
      assert.equal(recognition.requiresConfirmation, true);
      await request(identity, "PUT", "/families/settings", { stocktakeInterval: "weekly" });
      assert.equal((await request(identity, "GET", "/families/settings")).settings.stocktakeInterval, "weekly");
      const snapshot = await request(identity, "POST", "/exports/snapshot", {});
      const markdown = await request(identity, "POST", "/exports/markdown", { snapshotId: snapshot.snapshotId });
      const csv = await request(identity, "POST", "/exports/csv", { snapshotId: snapshot.snapshotId });
      assert.ok(markdown.markdown.includes(name)); assert.ok(csv.content.includes(name));
      await request(other, "POST", "/exports/markdown", { snapshotId: snapshot.snapshotId }, 404);
      const backup = await request(identity, "POST", "/backups/json", {});
      const preview = await request(identity, "POST", "/backups/preview", { backup });
      assert.equal(preview.valid, true); assert.ok(preview.medicineCount >= 1);
      await request(identity, "POST", `/medicines/${medicine.id}/trash`, {}, 204);
      await request(identity, "GET", `/medicines/${medicine.id}`, undefined, 404);
      await request(identity, "POST", `/trash/medicine/${medicine.id}/restore`, {});
      const restored = await request(identity, "GET", `/medicines/${medicine.id}`);
      assert.equal(restored.name, name); assert.equal(restored.batches[0].quantity, 3);
      cycles++;
    }
    for (const level of levels) {
      samples = [];
      failedRequests = 0;
      const started = performance.now();
      for (let round = 0; round < repetitions; round++) {
        // Await every started worker before cleanup, including on assertion failure.
        const results = await Promise.allSettled(identities.slice(0, level).map(identity => cycle(identity, level, round)));
        for (const result of results) if (result.status === "rejected") throw result.reason;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
      t.diagnostic(JSON.stringify({ layer: "SYNTHETIC", concurrency: level, repetitions,
        requests: samples.length, failedRequests, elapsedMs: Math.round(performance.now() - started),
        p95Ms: Math.round(p95), maxMs: Math.round(sorted.at(-1)), transport: "Fastify inject + isolated PG schema" }));
    }
    assert.equal(cycles, 26);
    assert.deepEqual(providerCalls, { catalog: cycles, recognition: cycles });
    for (const identity of identities) {
      const persisted = await fixture.pool.query("SELECT id FROM medicines WHERE family_id=$1 AND deleted_at IS NULL", [identity.familyId]);
      assert.deepEqual(persisted.rows.map(row => row.id).sort(), [...identity.created].sort());
      const plans = await fixture.pool.query("SELECT count(*)::int AS count FROM medication_plans WHERE family_id=$1", [identity.familyId]);
      assert.equal(plans.rows[0].count, identity.created.length, "committed retries must not duplicate plans");
    }
  } finally {
    // A request timeout does not cancel inject. Drain real requests before closing their owned schema.
    await Promise.allSettled([...inFlight]);
    if (app) await app.close();
    await fixture.close();
  }
});
