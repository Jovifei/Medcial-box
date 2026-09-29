import assert from "node:assert/strict";
import test from "node:test";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { authHeader, createApp, login, membershipRow } from "./helpers/app.mjs";

async function loggedInApp(pool) {
  const app = await createApp(pool, createTestGateway({ "js-code-1": "openid-user-1" }));
  await login(app, pool, { membership: membershipRow() });
  return app;
}

test("family inventory settings default to monthly and remain family scoped", async () => {
  const pool = createFakePool();
  const app = await loggedInApp(pool);
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/families/settings", ...authHeader() });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      settings: { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null },
    });
    assert.deepEqual(pool.callsMatching(/FROM family_inventory_settings/)[0].params, ["family-1"]);
  } finally {
    await app.close();
  }
});

test("family inventory settings reject unsupported intervals and save a valid interval", async () => {
  const pool = createFakePool();
  const app = await loggedInApp(pool);
  try {
    const invalid = await app.inject({
      method: "PUT", url: "/api/v1/families/settings", ...authHeader(),
      payload: { stocktakeInterval: "daily" },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(pool.callsMatching(/INSERT INTO family_inventory_settings/).length, 0);

    pool.on(/INSERT INTO family_inventory_settings/, {
      rows: [{ stocktake_interval: "weekly", last_stocktake_at: "2026-09-28T09:00:00.000Z" }],
      rowCount: 1,
    });
    const saved = await app.inject({
      method: "PUT", url: "/api/v1/families/settings", ...authHeader(),
      payload: { stocktakeInterval: "weekly" },
    });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().settings, {
      stocktakeInterval: "weekly",
      lastStocktakeAt: "2026-09-28T09:00:00.000Z",
      nextStocktakeAt: "2026-10-05T09:00:00.000Z",
    });
    assert.equal(pool.callsMatching(/INSERT INTO audit_events/).length, 1);
  } finally {
    await app.close();
  }
});

test("stocktake item payload validates before looking up the family session", async () => {
  const pool = createFakePool();
  const app = await loggedInApp(pool);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/stocktakes/session-1/items",
      ...authHeader(),
      payload: { items: [{ batchId: "batch-1", version: 1, outcome: "adjusted" }] },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
    assert.equal(pool.callsMatching(/FROM stocktake_sessions/).length, 0);
  } finally {
    await app.close();
  }
});

test("current stocktake is returned or null within the authenticated family", async () => {
  const pool = createFakePool();
  const app = await loggedInApp(pool);
  try {
    pool.on(/SELECT id, status, started_at, completed_at FROM stocktake_sessions/, { rows: [], rowCount: 0 });
    const response = await app.inject({ method: "GET", url: "/api/v1/families/stocktakes/current", ...authHeader() });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { stocktake: null });
    assert.deepEqual(pool.callsMatching(/SELECT id, status, started_at, completed_at FROM stocktake_sessions/)[0].params, ["family-1"]);
  } finally {
    await app.close();
  }
});

test("trash reads are family scoped and do not expose other families", async () => {
  const pool = createFakePool();
  const app = await loggedInApp(pool);
  try {
    pool.on(/FROM medicines m WHERE m.family_id/, {
      rows: [{ type: "medicine", id: "m-trash", medicine_id: "m-trash", name: "删除的药", deleted_at: "2026-09-28T08:00:00.000Z", expires_at: "2026-10-28T08:00:00.000Z", quantity: null, unit: null }],
      rowCount: 1,
    });
    const response = await app.inject({ method: "GET", url: "/api/v1/trash", ...authHeader() });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0].id, "m-trash");
    assert.equal(pool.callsMatching(/FROM medicines m WHERE m.family_id/)[0].params[0], "family-1");
  } finally {
    await app.close();
  }
});

test("audit limit validation prevents unbounded family history reads", async () => {
  const pool = createFakePool();
  const app = await loggedInApp(pool);
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/families/audit?limit=1000", ...authHeader() });
    assert.equal(response.statusCode, 400);
    assert.equal(pool.callsMatching(/FROM audit_events/).length, 0);
  } finally {
    await app.close();
  }
});
