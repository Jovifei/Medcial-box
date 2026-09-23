import assert from "node:assert/strict";
import test from "node:test";
import { buildServer } from "../dist/app.js";

test("liveness reports that the API process is running", async () => {
  const app = await buildServer({ database: { query: async () => undefined }, logger: false });

  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
  } finally {
    await app.close();
  }
});

test("health endpoints respond over a local HTTP listener", async () => {
  const app = await buildServer({ database: { query: async () => undefined }, logger: false });

  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const live = await fetch(new URL("/api/v1/health/live", address));
    const ready = await fetch(new URL("/api/v1/health/ready", address));

    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "ok" });
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ok", database: "connected" });
  } finally {
    await app.close();
  }
});

test("readiness confirms a successful database query", async () => {
  let queryCount = 0;
  const app = await buildServer({
    database: {
      query: async (sql) => {
        assert.equal(sql, "SELECT 1");
        queryCount += 1;
      },
    },
    logger: false,
  });

  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok", database: "connected" });
    assert.equal(queryCount, 1);
  } finally {
    await app.close();
  }
});

test("readiness fails closed without exposing database errors", async () => {
  const app = await buildServer({
    database: { query: async () => Promise.reject(new Error("synthetic connection failure")) },
    logger: false,
  });

  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: "unavailable", database: "disconnected" });
    assert.equal(response.body.includes("synthetic connection failure"), false);
  } finally {
    await app.close();
  }
});
