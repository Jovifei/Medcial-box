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
