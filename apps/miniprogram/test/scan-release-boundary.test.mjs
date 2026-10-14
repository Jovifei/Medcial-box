import assert from "node:assert/strict";
import test from "node:test";
import { loadApi, loadPage, makePageContext } from "./runtime.mjs";

class CatalogError extends Error {
  constructor(code, statusCode) { super("Synthetic lookup failure"); this.code = code; this.statusCode = statusCode; }
}

test("catalog transport waits at most thirty seconds and preserves its consent payload", async () => {
  const requests = [];
  const transport = loadApi({ wx: {
    getStorageSync: () => "synthetic-token",
    request(options) { requests.push(options); options.success({ statusCode: 200, data: { candidates: [], warnings: [] } }); },
  } });
  await transport.api.findMedicineCandidates("6900000000012");
  await transport.api.findMedicineCandidates("合成名称", "name");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.timeout, 30000);
    assert.equal(request.data.consentToShare, true);
    assert.equal(request.header.authorization, "Bearer synthetic-token");
  }
  assert.equal(requests[0].data.barcode, "6900000000012");
  assert.equal(requests[1].data.name, "合成名称");
});

for (const method of ["onScanCode", "onRetryBarcodeLookup"]) {
  test(`${method} explicitly describes external sending and cancellation retains the prior code without requests`, async () => {
    let queries = 0;
    let scans = 0;
    const prompts = [];
    const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
      modules: {
        "../../services/api": { ApiError: CatalogError, api: { async findMedicineCandidates() { queries++; } } },
        "../../services/auth": { ensureLoggedIn: async () => {} },
      },
      wx: {
        scanCode() { scans++; },
        showModal(options) { prompts.push(options.content); options.success({ confirm: false }); },
      },
      setTimeoutFn: () => 0,
    });
    const page = makePageContext(definition);
    page.data.scannedBarcode = "6900000000012";
    page.data.barcodeValue = "6900000000012";
    await page[method]();
    assert.equal(queries, 0);
    assert.equal(scans, 0);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /联网资料库.*外部资料供应商/);
    assert.equal(page.data.scannedBarcode, "6900000000012");
    assert.equal(page.data.barcodeValue, "6900000000012");
    assert.equal(page.data.recognizing, false);
  });
}

for (const [state, code, status, expected] of [
  ["normal no-match", null, 200, /已填入表单/],
  ["not configured", "MEDICINE_CATALOG_NOT_CONFIGURED", 503, /尚未配置/],
  ["unavailable", "MEDICINE_CATALOG_UNAVAILABLE", 503, /暂不可用/],
  ["rate limited", "RATE_LIMITED", 429, /查询失败/],
  ["network failure", "NETWORK_ERROR", 0, /查询失败/],
]) {
  test(`scan ${state} retains the barcode without inventing medicine details or starting photo recognition`, async () => {
    let queries = 0;
    let photoCalls = 0;
    const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
      modules: {
        "../../services/api": { ApiError: CatalogError, api: {
          async findMedicineCandidates(value) {
            queries++; assert.equal(value, "6900000000012");
            if (code) throw new CatalogError(code, status);
            return { candidates: [], warnings: ["Synthetic catalog has no matching entry"] };
          },
          async recognizeMedicine() { photoCalls++; assert.fail("Scanning must not initiate a photo request"); },
        } },
        "../../services/auth": { ensureLoggedIn: async () => {} },
      },
      wx: {
        scanCode(options) { options.success({ result: " 6900000000012 " }); },
        showModal(options) { options.success({ confirm: true }); },
      },
      setTimeoutFn: () => 0,
    });
    const page = makePageContext(definition);
    page.data.name = "Owner entered synthetic name";
    await page.onScanCode();
    assert.equal(queries, 1);
    assert.equal(photoCalls, 0);
    assert.equal(page.data.scannedBarcode, "6900000000012");
    assert.equal(page.data.barcodeValue, "6900000000012");
    assert.equal(page.data.name, "Owner entered synthetic name");
    assert.equal(page.data.recognizing, false);
    assert.equal(page.data.canRetryBarcode, Boolean(code));
    assert.match(page.data.barcodeLookupStatus, expected);
  });
}

for (const value of ["12345678901234567890", "https://synthetic.invalid/trace/123", "ABC-CODE"]) {
  test(`unsupported scanned identifier ${value} is retained but never queried or automatically photographed`, async () => {
    let queries = 0;
    let photoCalls = 0;
    const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
      modules: {
        "../../services/api": { ApiError: CatalogError, api: {
          async findMedicineCandidates() { queries++; },
          async recognizeMedicine() { photoCalls++; },
        } },
        "../../services/auth": { ensureLoggedIn: async () => {} },
      },
      wx: {
        scanCode(options) { options.success({ result: value }); },
        showModal(options) { options.success({ confirm: true }); },
      },
      setTimeoutFn: () => 0,
    });
    const page = makePageContext(definition);
    await page.onScanCode();
    await page.onRetryBarcodeLookup();
    assert.equal(queries, 0);
    assert.equal(photoCalls, 0);
    assert.equal(page.data.scannedBarcode, value);
    assert.equal(page.data.barcodeValue, value);
    assert.equal(page.data.canRetryBarcode, false);
    assert.equal(page.data.recognizing, false);
    assert.match(page.data.barcodeLookupStatus, /可能是追溯码或其他标识.*仅支持8–14位数字商品条码.*原码已保留.*手动填写/);
  });
}

for (const value of ["12345678", "12345678901234"]) {
  test(`supported ${value.length}-digit product barcode queries normally`, async () => {
    const queries = [];
    const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
      modules: {
        "../../services/api": { ApiError: CatalogError, api: { async findMedicineCandidates(code) { queries.push(code); return { candidates: [], warnings: [] }; } } },
        "../../services/auth": { ensureLoggedIn: async () => {} },
      },
      wx: { scanCode(options) { options.success({ result: value }); }, showModal(options) { options.success({ confirm: true }); } },
      setTimeoutFn: () => 0,
    });
    const page = makePageContext(definition);
    await page.onScanCode();
    await page.onRetryBarcodeLookup();
    assert.deepEqual(queries, [value, value]);
    assert.equal(page.data.barcodeValue, value);
  });
}
