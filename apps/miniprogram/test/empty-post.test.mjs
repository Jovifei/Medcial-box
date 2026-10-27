import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { loadApi, loadPage, makePageContext } from "./runtime.mjs";

test("invitation and other bodyless POSTs reach a real Fastify JSON parser", async () => {
  const server = Fastify();
  server.post("/api/v1/families/invitations", (request) => ({ received: request.body }));
  try {
    const client = loadApi();
    await client.api.createInvitation();
    const request = client.requests[0];
    const response = await server.inject({ method: request.method, url: new URL(request.url).pathname,
      headers: request.header, payload: JSON.stringify(request.data) });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { received: {} });
    const rejected = await server.inject({ method: "POST", url: "/api/v1/families/invitations", headers: request.header });
    assert.equal(rejected.statusCode, 400);
  } finally { await server.close(); }
});

test("GET keeps no body and leaflet recognition sends its explicit purpose", async () => {
  const client = loadApi();
  await client.api.getCurrentFamily();
  assert.equal(client.requests[0].data, undefined);
  await client.api.recognizeMedicine("synthetic-image", "image/jpeg", "leaflet");
  assert.equal(client.requests[1].data.purpose, "leaflet");
});

test("bodyless member and photo DELETE requests reach a real Fastify parser", async () => {
  const server = Fastify();
  server.delete("/api/v1/families/members/:id", (_request, reply) => reply.code(204).send());
  server.delete("/api/v1/medicines/:id/leaflet-photos/:photoId", (_request, reply) => reply.code(204).send());
  try {
    const client = loadApi();
    await client.api.removeMember("synthetic-member");
    await client.api.deleteLeafletPhoto("synthetic-medicine", "synthetic-photo");
    for (const request of client.requests) {
      assert.equal(request.data, "{}", "微信默认JSON类型；DELETE显式发送可解析的空对象字符串");
      assert.equal(request.header["content-type"], "application/json");
      const response = await server.inject({ method: request.method, url: new URL(request.url).pathname, headers: request.header, payload: request.data });
      assert.equal(response.statusCode, 204);
    }
  } finally { await server.close(); }
});

test("deferring stocktake preserves known and unknown quantities without sending zero", async () => {
  const sent = [];
  const { definition } = loadPage("pages/stocktake/stocktake.ts", { modules: {
    "../../services/auth": { ensureLoggedIn: async () => {} },
    "../../services/api": { ApiError: class extends Error {}, api: {
      submitStocktakeItems: async (_id, items) => { sent.push(...items); return { results: [] }; },
      completeStocktake: async () => ({}), getCurrentStocktake: async () => ({ stocktake: null }),
    } },
  } });
  const page = makePageContext(definition);
  page.applySession({ id: "synthetic", items: [5, null].map((quantity, i) => ({ batchId: `b${i}`, medicineId: "m", medicineName: "test", quantity, unit: "tablet", version: 1, result: "pending" })) });
  assert.equal(page.data.items[0].quantity, 5);
  assert.equal(page.data.items[1].quantity, null);
  await page.onSubmit();
  assert.equal(sent.length, 2);
  for (const item of sent) { assert.equal(item.outcome, "deferred"); assert.equal(item.quantity, undefined); }
});
