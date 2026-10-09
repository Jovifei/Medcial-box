import assert from "node:assert/strict";
import test from "node:test";
import { loadApi } from "./runtime.mjs";

// SDK request methods are a documented finite set. PATCH is not among them,
// so native clients must use POST even if Fastify accepts PATCH for compatibility.
test("stock-only operations use WeChat wx.request supported POST method", async () => {
  const { api, requests } = loadApi();
  await api.updateLowStockThreshold("med-1", {lowStockThreshold: {quantity: 2, unit: "box"}, version: 7});
  await api.updateBatchQuantity("med-1", "batch-1", {quantity: 2.345, version: 11});
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(request => request.method), ["POST", "POST"]);
  assert.equal(requests[0].url.endsWith("/medicines/med-1/low-stock-threshold"), true);
  assert.equal(requests[1].url.endsWith("/medicines/med-1/batches/batch-1/quantity"), true);
  assert.equal(requests[0].data.version, 7);
  assert.equal(requests[1].data.quantity, 2.345);
  const allowed = new Set(["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "TRACE", "CONNECT"]);
  assert.ok(requests.every(request => allowed.has(request.method)));
});
