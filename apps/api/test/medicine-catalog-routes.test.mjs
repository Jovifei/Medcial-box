import assert from "node:assert/strict";
import Fastify from "fastify";
import test from "node:test";

const routeModule = await import("../dist/routes/medicine-catalog.js").catch(() => null);

async function createCatalogApp(provider) {
  assert.ok(routeModule, "medicine catalog routes have not been implemented");
  const app = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user-1", familyId: "family-1", role: "owner" };
  });
  await routeModule.registerMedicineCatalogRoutes(app, provider);
  return app;
}

test("catalog endpoint requires explicit consent and an authenticated family", async () => {
  let calls = 0;
  const app = await createCatalogApp({ search: async () => { calls += 1; return { candidates: [], warnings: [] }; } });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicine-catalog/candidates",
      payload: { name: "测试药" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test("catalog endpoint passes the confirmed query to its provider", async () => {
  let received;
  const app = await createCatalogApp({
    search: async (query) => {
      received = query;
      return { candidates: [], warnings: ["请人工核对"] };
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicine-catalog/candidates",
      payload: { name: "测试药", barcode: "6900000000012", consentToShare: true },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(received, { name: "测试药", barcode: "6900000000012", consentToShare: true });
    assert.deepEqual(response.json(), { candidates: [], warnings: ["请人工核对"] });
  } finally {
    await app.close();
  }
});

test("catalog provider failure becomes a safe unavailable response", async () => {
  const app = await createCatalogApp({ search: async () => { throw new Error("secret provider detail"); } });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicine-catalog/candidates",
      payload: { name: "测试药", consentToShare: true },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "MEDICINE_CATALOG_UNAVAILABLE");
    assert.equal(response.body.includes("secret provider detail"), false);
  } finally {
    await app.close();
  }
});

test("unconfigured catalog is distinct and never makes an external request", async () => {
  const { JisuMedicineCatalogProvider } = await import("../dist/services/medicine-catalog.js");
  let externalCalls = 0;
  const provider = new JisuMedicineCatalogProvider("", async () => { externalCalls += 1; throw new Error("must not call"); });
  const app = await createCatalogApp(provider);
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/medicine-catalog/candidates",
      payload: { barcode: "6900000000012", consentToShare: true } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "MEDICINE_CATALOG_NOT_CONFIGURED");
    assert.equal(response.body.includes("API_KEY"), false);
    assert.equal(externalCalls, 0);
  } finally { await app.close(); }
});
