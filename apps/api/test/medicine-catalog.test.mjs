import assert from "node:assert/strict";
import test from "node:test";
const catalogModule = await import("../dist/services/medicine-catalog.js").catch(() => null);

function jsonResponse(body, status = 200) {
  return new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("catalog lookup requires an explicit user consent signal and never calls provider without a key", async () => {
  assert.ok(catalogModule, "medicine catalog adapter has not been implemented");
  const { JisuMedicineCatalogProvider, MedicineCatalogUnavailableError } = catalogModule;
  let calls = 0;
  const provider = new JisuMedicineCatalogProvider("", async () => {
    calls += 1;
    return jsonResponse({ status: 0, result: { list: [] } });
  });
  await assert.rejects(
    provider.search({ name: "测试药", consentToShare: false }),
    /请先确认允许发送药品标识到资料查询服务/,
  );
  await assert.rejects(
    provider.search({ name: "测试药", consentToShare: true }),
    (error) => error instanceof MedicineCatalogUnavailableError && error.reason === "not_configured",
  );
  assert.equal(calls, 0);
});

test("catalog candidates are sourced, identity-ranked and never auto-confirmed", async () => {
  assert.ok(catalogModule, "medicine catalog adapter has not been implemented");
  const { JisuMedicineCatalogProvider } = catalogModule;
  const calls = [];
  const provider = new JisuMedicineCatalogProvider("test-key", async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith("/query")) {
      return jsonResponse({
        status: 0,
        result: {
          list: [
            { medicine_id: 12, name: "布洛芬缓释胶囊", manufacturer: "甲厂", prescription: 2 },
            { medicine_id: 13, name: "布洛芬片", manufacturer: "乙厂", prescription: 2 },
          ],
        },
      });
    }
    return jsonResponse({
      status: 0,
      result: {
        medicine_id: Number(url.searchParams.get("medicine_id")),
        name: "布洛芬缓释胶囊",
        spec: "0.3g×20粒",
        approval_num: "国药准字H00000001",
        manufacturer: "甲厂",
        barcode: "6900000000012",
        disease: "发热及疼痛",
        prescription: 2,
        desc: "〖主要成份〗布洛芬。〖功能主治/适应症〗用于缓解疼痛。",
      },
    });
  });

  const result = await provider.search({
    name: "布洛芬缓释胶囊",
    manufacturer: "甲厂",
    specification: "0.3g×20粒",
    consentToShare: true,
  });

  assert.equal(calls.length, 3);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].name, "布洛芬缓释胶囊");
  assert.equal(result.candidates[0].matchReasons.length >= 2, true);
  assert.equal(result.candidates[0].leaflet.reviewStatus, "unverified");
  assert.equal(result.candidates[0].source, "极速数据药品信息");
  assert.match(result.warnings.join(" "), /请按批准文号、厂家和规格核对包装/);
});

test("catalog provider errors become a safe unavailable result", async () => {
  assert.ok(catalogModule, "medicine catalog adapter has not been implemented");
  const { JisuMedicineCatalogProvider, MedicineCatalogUnavailableError } = catalogModule;
  const provider = new JisuMedicineCatalogProvider("test-key", async () => jsonResponse({ status: 104, msg: "quota" }));
  await assert.rejects(
    provider.search({ barcode: "6900000000012", consentToShare: true }),
    (error) => error instanceof MedicineCatalogUnavailableError && error.reason === "unavailable",
  );
});

const emptyCatalog = { candidates: [], warnings: [] };
const query = { barcode: "6900000000012", consentToShare: true };
const localStub = (search) => ({ kind: "local", search });

test("default catalog does not silently load an unconfigured local data file", async () => {
  const keys = ["MEDICINE_CATALOG_PROVIDER", "MEDICINE_CATALOG_LOCAL_FILE", "JISU_MEDICINE_API_KEY"];
  const saved = keys.map(key => process.env[key]);
  try {
    keys.forEach(key => { delete process.env[key]; });
    await assert.rejects(catalogModule.createDefaultMedicineCatalogProvider().search(query),
      error => error.reason === "not_configured");
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
});

test("composite keeps local priority and never sends identifiers externally without consent", async () => {
  const { CompositeMedicineCatalogProvider } = catalogModule;
  let externalCalls = 0;
  const external = { async search() { externalCalls++; return emptyCatalog; } };
  const match = { candidates: [{ name: "合成药品" }], warnings: [] };
  const first = new CompositeMedicineCatalogProvider(localStub(async () => match), external);
  assert.deepEqual(await first.search(query), match);
  assert.equal(externalCalls, 0);
  const fallback = new CompositeMedicineCatalogProvider(localStub(async () => emptyCatalog), external);
  const result = await fallback.search({ ...query, consentToShare: false });
  assert.equal(externalCalls, 0);
  assert.equal(result.candidates.length, 0);
  assert.match(result.warnings.join(" "), /未进行外部资料查询/);
  assert.doesNotMatch(result.warnings.join(" "), /显卡|GPU|成功读取|保留在表单/);
  await fallback.search(query);
  assert.equal(externalCalls, 1);
});

test("composite distinguishes healthy no-match, missing configuration and unavailable providers", async () => {
  const { CompositeMedicineCatalogProvider, MedicineCatalogUnavailableError } = catalogModule;
  const healthy = localStub(async () => emptyCatalog);
  const errorProvider = (reason) => ({ async search() { throw new MedicineCatalogUnavailableError("synthetic failure", reason); } });
  const missing = new CompositeMedicineCatalogProvider();
  await assert.rejects(missing.search(query), error => error.reason === "not_configured");
  const normal = await new CompositeMedicineCatalogProvider(healthy).search(query);
  assert.equal(normal.candidates.length, 0);
  assert.match(normal.warnings.join(" "), /未检索到匹配/);
  for (const reason of ["not_configured", "unavailable"]) {
    await assert.rejects(new CompositeMedicineCatalogProvider(healthy, errorProvider(reason)).search(query),
      error => error instanceof MedicineCatalogUnavailableError && error.reason === reason);
    await assert.rejects(new CompositeMedicineCatalogProvider(localStub(errorProvider(reason).search)).search(query),
      error => error instanceof MedicineCatalogUnavailableError && error.reason === reason);
  }
  await assert.rejects(new CompositeMedicineCatalogProvider(healthy, { async search() { throw new Error("synthetic unexpected failure"); } }).search(query),
    error => error instanceof MedicineCatalogUnavailableError && error.reason === "unavailable");
});

test("composite can recover local failure with a consented external match but never hides partial failure as no-match", async () => {
  const { CompositeMedicineCatalogProvider, MedicineCatalogUnavailableError } = catalogModule;
  const brokenLocal = localStub(async () => { throw new MedicineCatalogUnavailableError("synthetic local failure"); });
  const match = { candidates: [{ name: "合成外部候选" }], warnings: ["待核验"] };
  let calls = 0;
  const external = { async search() { calls++; return match; } };
  const provider = new CompositeMedicineCatalogProvider(brokenLocal, external);
  await assert.rejects(provider.search({ ...query, consentToShare: false }), error => error.reason === "unavailable");
  assert.equal(calls, 0);
  assert.deepEqual(await provider.search(query), match);
  assert.equal(calls, 1);
  await assert.rejects(new CompositeMedicineCatalogProvider(brokenLocal, { async search() { return emptyCatalog; } }).search(query),
    error => error.reason === "unavailable");
  await assert.rejects(new CompositeMedicineCatalogProvider(brokenLocal, { async search() { throw new MedicineCatalogUnavailableError("synthetic missing external", "not_configured"); } }).search(query),
    error => error.reason === "unavailable");
});
