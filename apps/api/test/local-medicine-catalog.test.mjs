import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { LocalMedicineCatalogProvider, validateLocalCatalog } from "../dist/services/local-medicine-catalog.js";
import { registerMedicineCatalogRoutes } from "../dist/routes/medicine-catalog.js";
import { createFakePool } from "./helpers/fake-pool.mjs";
const entry = { barcodeValue: "6900000000001", name: "合成药", source: "合成审核资料", reviewed: true };

test("local catalog rejects unreviewed, extra household fields and duplicate identifiers", () => {
  for (const patch of [{ reviewed: false }, { quantity: 2 }, { expiry: "2027-12" }, { person: "合成姓名" }]) assert.throws(() => validateLocalCatalog({ version: 1, entries: [{ ...entry, ...patch }] }));
  assert.throws(() => validateLocalCatalog({ version: 1, entries: [entry, entry] }));
  assert.throws(() => validateLocalCatalog({ version: 1, entries: Array(10001).fill(entry) }));
});

test("local lookup is exact, missing or empty catalog is not an online error", async () => {
  const folder = await mkdtemp(join(tmpdir(), "jf-catalog-"));
  try {
    const file = join(folder, "catalog.json");
    await writeFile(file, JSON.stringify({ version: 1, entries: [entry] }));
    const provider = new LocalMedicineCatalogProvider(file);
    assert.equal((await provider.search({ barcode: entry.barcodeValue, consentToShare: false })).candidates[0].name, entry.name);
    assert.equal((await provider.search({ barcode: "6900000000002", consentToShare: false })).candidates.length, 0);
    assert.equal((await new LocalMedicineCatalogProvider(join(folder, "missing.json")).search({ barcode: entry.barcodeValue, consentToShare: false })).candidates.length, 0);
    await writeFile(file, JSON.stringify({ version: 1, entries: [] }));
    assert.equal((await provider.search({ barcode: entry.barcodeValue, consentToShare: false })).candidates.length, 0);
    await writeFile(file, JSON.stringify({ version: 1, entries: [{ ...entry, reviewed: false }] }));
    await assert.rejects(provider.search({ barcode: entry.barcodeValue, consentToShare: false }), /local catalog is invalid/);
    await writeFile(file, " ".repeat(5 * 1024 * 1024 + 1));
    await assert.rejects(provider.search({ barcode: entry.barcodeValue, consentToShare: false }), /local catalog is invalid/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("family barcode lookup is scoped and only emits whitelisted product fields", async () => {
  let familyId = "family-one";
  const app = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  app.addHook("preHandler", async request => { request.auth = { userId: "u1", familyId, role: "owner" }; });
  const pool = createFakePool();
  pool.always(/FROM medicines WHERE family_id/, (_sql, params) => params[0] === "family-one" && params[1] === entry.barcodeValue ? [{ ...entry, quantity: 99, photos: ["private"], note: "private", expiry: "2027-01" }] : []);
  let calls = 0;
  await registerMedicineCatalogRoutes(app, { kind: "local", search: async () => { calls++; return { candidates: [], warnings: [] }; } }, pool);
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/medicine-catalog/candidates", payload: { barcode: entry.barcodeValue } });
    assert.equal(response.statusCode, 200);
    const candidate = response.json().candidates[0];
    assert.equal(candidate.name, entry.name);
    for (const key of ["quantity", "photos", "note", "expiry", "reviewed"]) assert.equal(key in candidate, false);
    assert.equal(candidate.leaflet, null);
    assert.equal(calls, 0);
    familyId = "family-two";
    const other = await app.inject({ method: "POST", url: "/api/v1/medicine-catalog/candidates", payload: { barcode: entry.barcodeValue } });
    assert.equal(other.json().candidates.length, 0);
    assert.equal(calls, 1);
    assert.match(pool.callsMatching(/FROM medicines/)[0].sql, /family_id = \$1 AND barcode_value = \$2 AND deleted_at IS NULL/);
  } finally { await app.close(); }
});


test("local name and identifiers filter candidates, cap at five and never override a barcode miss", async () => {
  const folder = await mkdtemp(join(tmpdir(), "jf-catalog-search-"));
  try {
    const file = join(folder, "catalog.json");
    const entries = Array.from({ length: 7 }, (_, index) => ({ ...entry, barcodeValue: `690000000000${index}`, name: "合成止痒药", manufacturer: index === 6 ? "乙厂" : "甲厂", approvalNumber: `测试准字${index}`, specification: "20粒装" }));
    await writeFile(file, JSON.stringify({ version: 1, entries }));
    const provider = new LocalMedicineCatalogProvider(file);
    const results = await provider.search({ name: "止痒", manufacturer: "甲厂", consentToShare: false });
    assert.equal(results.candidates.length, 5);
    assert.ok(results.candidates.every(value => value.manufacturer === "甲厂"));
    assert.match(results.candidates[0].matchReasons[0], /名称或商品标识/);
    assert.equal((await provider.search({ approvalNumber: "测试准字6", specification: "20粒装", consentToShare: false })).candidates[0].manufacturer, "乙厂");
    assert.equal((await provider.search({ name: "合成", barcode: "6900000000999", consentToShare: false })).candidates.length, 0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("family name lookup combines parameterized identifiers with privacy and archive guards", async () => {
  const app = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  app.addHook("preHandler", async request => { request.auth = { userId: "u1", familyId: "family-one", role: "owner" }; });
  const pool = createFakePool();
  pool.always(/FROM medicines WHERE family_id/, (_sql, params) => {
    assert.deepEqual(params, ["family-one", "止痒", "甲厂", "测试准字", "20粒装"]);
    return [{ ...entry, name: "合成止痒药", quantity: 9, expiry: "2027-01" }];
  });
  await registerMedicineCatalogRoutes(app, new LocalMedicineCatalogProvider(), pool);
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/medicine-catalog/candidates", payload: { name: "止痒", manufacturer: "甲厂", approvalNumber: "测试准字", specification: "20粒装" } });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().candidates[0].matchReasons[0], /名称或商品标识/);
    assert.equal("quantity" in response.json().candidates[0], false);
    const sql = pool.callsMatching(/FROM medicines/)[0].sql;
    assert.match(sql, /strpos\(lower\(name\), lower\(\$2\)\) > 0/);
    assert.match(sql, /manufacturer = \$3 AND approval_number = \$4 AND specification = \$5/);
    assert.match(sql, /deleted_at IS NULL AND is_archived = FALSE/);
  } finally { await app.close(); }
});
