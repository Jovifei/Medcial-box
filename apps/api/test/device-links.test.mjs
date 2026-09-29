import assert from "node:assert/strict";
import test from "node:test";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { authHeader, createApp, login, membershipRow } from "./helpers/app.mjs";

test("device link start returns one pairing code and a separate private poll token", async () => {
  const pool = createFakePool();
  const app = await createApp(pool, createTestGateway({ "js-code-1": "openid-user-1" }));
  try {
    pool.on(/INSERT INTO device_link_requests/, {
      rows: [{ id: "link-1", expires_at: "2026-09-28T04:05:00.000Z" }],
      rowCount: 1,
    });
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/device-links" });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.match(body.code, /^\d{8}$/);
    assert.match(body.pollToken, /^[a-f0-9]{64}$/);
    const remaining = Date.parse(body.expiresAt) - Date.now();
    assert.ok(remaining > 4 * 60_000 && remaining <= 5 * 60_000);
    const insert = pool.callsMatching(/INSERT INTO device_link_requests/)[0];
    assert.equal(insert.params.length, 3);
    assert.notEqual(insert.params[0], body.code);
    assert.notEqual(insert.params[1], body.pollToken);
  } finally {
    await app.close();
  }
});

test("device link code collision retries instead of approving more than one app", async () => {
  const pool = createFakePool();
  const app = await createApp(pool, createTestGateway());
  try {
    pool.on(/INSERT INTO device_link_requests/, { rows: [], rowCount: 0 });
    pool.on(/INSERT INTO device_link_requests/, {
      rows: [{ id: "link-after-retry", expires_at: "2026-09-28T04:05:00.000Z" }],
      rowCount: 1,
    });
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/device-links" });
    assert.equal(response.statusCode, 201);
    assert.equal(pool.callsMatching(/INSERT INTO device_link_requests/).length, 2);
    const [first, second] = pool.callsMatching(/INSERT INTO device_link_requests/);
    assert.notEqual(first.params[0], second.params[0]);
    assert.match(response.json().code, /^\d{8}$/);
  } finally {
    await app.close();
  }
});

test("only a family member can approve a pairing code and approval does not return a session", async () => {
  const pool = createFakePool();
  const app = await createApp(pool, createTestGateway({ "js-code-1": "openid-user-1" }));
  try {
    await login(app, pool, { membership: membershipRow() });
    pool.on(/UPDATE device_link_requests SET status = 'approved'/, {
      rows: [{ id: "link-1" }],
      rowCount: 1,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device-links/approve",
      ...authHeader(),
      payload: { code: "12345678" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { approved: true });
    assert.equal("token" in response.json(), false);
    const update = pool.callsMatching(/UPDATE device_link_requests SET status = 'approved'/)[0];
    assert.equal(update.params[1], "user-1");
    assert.equal(update.params[2], "family-1");
  } finally {
    await app.close();
  }
});

test("device link exchange returns pending without a token until the mini program approves", async () => {
  const pool = createFakePool();
  const app = await createApp(pool, createTestGateway({ "js-code-1": "openid-user-1" }));
  try {
    pool.on(/FROM device_link_requests WHERE poll_token_hash/, {
      rows: [{ id: "link-1", status: "pending", expires_at: "2099-01-01T00:00:00.000Z" }],
      rowCount: 1,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device-links/exchange",
      payload: { pollToken: "d".repeat(64) },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { state: "pending" });
    assert.equal(pool.callsMatching(/INSERT INTO sessions/).length, 0);
  } finally {
    await app.close();
  }
});
