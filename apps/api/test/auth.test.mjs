// 认证与会话合成测试：假网关登录成功/失败、令牌仅存哈希、401 语义区分。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { createApp, login } from "./helpers/app.mjs";

const ANY_TOKEN = "b".repeat(64);

test("login creates a session for a new wechat user and stores only the token hash", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-new": "openid-new-1" });
  pool.on(/FROM users WHERE openid/, { rows: [], rowCount: 0 });
  pool.always(/INSERT INTO users/, {
    rows: [{ id: "user-new-1", openid: "openid-new-1", nickname: null }],
    rowCount: 1,
  });
  pool.always(/FROM family_members WHERE user_id/, { rows: [], rowCount: 0 });
  pool.always(/INSERT INTO sessions/, { rows: [{ id: "session-1", expires_at: "2099-01-01T00:00:00Z" }], rowCount: 1 });

  const app = await createApp(pool, gateway);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat",
      payload: { code: "js-code-new" },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.user.id, "user-new-1");
    assert.equal(body.user.hasFamily, false);
    assert.match(body.token, /^[0-9a-f]{64}$/);

    // 数据库只存 sha256 哈希，绝不落明文令牌。
    const insert = pool.callsMatching(/INSERT INTO sessions/)[0];
    const tokenHash = createHash("sha256").update(body.token).digest("hex");
    assert.equal(insert.params[1], tokenHash);
    assert.notEqual(insert.params[1], body.token);
  } finally {
    await app.close();
  }
});

test("login with an existing openid reuses the user (idempotent)", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  pool.always(/FROM users WHERE openid/, {
    rows: [{ id: "user-1", openid: "openid-user-1", nickname: null }],
    rowCount: 1,
  });
  pool.always(/FROM family_members WHERE user_id/, { rows: [], rowCount: 0 });

  const app = await createApp(pool, gateway);
  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat",
      payload: { code: "js-code-1" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat",
      payload: { code: "js-code-1" },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.json().user.id, "user-1");
    assert.equal(second.json().user.id, "user-1");
    assert.equal(pool.callsMatching(/INSERT INTO users/).length, 0);
  } finally {
    await app.close();
  }
});

test("login with an invalid wechat code fails with 401 WECHAT_EXCHANGE_FAILED", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({});
  const app = await createApp(pool, gateway);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat",
      payload: { code: "unknown-code" },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "WECHAT_EXCHANGE_FAILED");
  } finally {
    await app.close();
  }
});

test("a gateway outage surfaces as 502 WECHAT_GATEWAY_ERROR without internal details", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  gateway.setFailure(new Error("synthetic gateway outage"));
  const app = await createApp(pool, gateway);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat",
      payload: { code: "js-code-1" },
    });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, "WECHAT_GATEWAY_ERROR");
    assert.equal(response.body.includes("synthetic gateway outage"), false);
  } finally {
    await app.close();
  }
});

test("login without a code fails validation with 400", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({});
  const app = await createApp(pool, gateway);
  try {
    const missing = await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: {} });
    const blank = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat",
      payload: { code: "   " },
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.code, "VALIDATION_ERROR");
    assert.equal(blank.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("wechat login is rate limited per client address", async () => {
  const pool = createFakePool();
  const app = await createApp(pool, createTestGateway({}));
  try {
    for (let index = 0; index < 30; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/wechat",
        payload: { code: "" },
      });
      assert.equal(response.statusCode, 400);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat",
      payload: { code: "" },
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "RATE_LIMITED");
  } finally {
    await app.close();
  }
});

test("only declared health endpoints bypass authentication", async () => {
  const app = await createApp(createFakePool(), createTestGateway({}));
  try {
    const live = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    assert.equal(live.statusCode, 200);

    const unknownHealthPath = await app.inject({
      method: "GET",
      url: "/api/v1/health/private",
    });
    assert.equal(unknownHealthPath.statusCode, 401);
    assert.equal(unknownHealthPath.json().error.code, "UNAUTHORIZED");
  } finally {
    await app.close();
  }
});

test("protected endpoints reject missing and invalid tokens with 401", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({});
  const app = await createApp(pool, gateway);
  try {
    const noToken = await app.inject({ method: "GET", url: "/api/v1/medicines" });
    assert.equal(noToken.statusCode, 401);
    assert.equal(noToken.json().error.code, "UNAUTHORIZED");

    const badToken = await app.inject({
      method: "GET",
      url: "/api/v1/medicines",
      headers: { authorization: "Bearer deadbeef" },
    });
    assert.equal(badToken.statusCode, 401);
    assert.equal(badToken.json().error.code, "UNAUTHORIZED");
  } finally {
    await app.close();
  }
});

test("an expired session is reported as SESSION_EXPIRED (401)", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({});
  pool.always(/FROM sessions WHERE token_hash/, {
    rows: [{ id: "session-1", user_id: "user-1", expires_at: "2020-01-01T00:00:00Z" }],
    rowCount: 1,
  });
  const app = await createApp(pool, gateway);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/medicines",
      headers: { authorization: "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "SESSION_EXPIRED");
  } finally {
    await app.close();
  }
});

test("a valid session without a family gets 404 FAMILY_NOT_FOUND on business endpoints", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await createApp(pool, gateway);
  try {
    await login(app, pool, { membership: null });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/medicines",
      headers: { authorization: `Bearer ${ANY_TOKEN}` },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "FAMILY_NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("GET /auth/me returns the current user and minimal family membership", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await createApp(pool, gateway);
  try {
    const token = await login(app, pool, { membership: {
      id: "membership-1",
      family_id: "family-1",
      role: "owner",
      joined_at: "2026-09-24T08:00:00Z",
    } });
    pool.always(/SELECT id, openid, nickname FROM users WHERE id/, {
      rows: [{ id: "user-1", openid: "openid-user-1", nickname: "小王" }],
      rowCount: 1,
    });
    pool.always(/FROM families WHERE id/, {
      rows: [{ id: "family-1", name: "本地测试家庭", created_by: "user-1", created_at: "2026-09-24T08:00:00Z", updated_at: "2026-09-24T08:00:00Z" }],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      user: { id: "user-1", nickname: "小王", hasFamily: true },
      family: { id: "family-1", name: "本地测试家庭", role: "owner" },
    });
  } finally {
    await app.close();
  }
});

test("PATCH and POST /users/me nickname routes trim and clear the optional nickname", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await createApp(pool, gateway);
  try {
    const token = await login(app, pool, { membership: null });
    pool.always(/UPDATE users SET nickname/, (sql, params) => ({
      rows: [{ id: "user-1", openid: "openid-user-1", nickname: params[1] }],
      rowCount: 1,
    }));

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { nickname: "  家人  " },
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json(), { user: { id: "user-1", nickname: "家人" } });

    const mobileUpdated = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/nickname",
      headers: { authorization: `Bearer ${token}` },
      payload: { nickname: "  手机端  " },
    });
    assert.equal(mobileUpdated.statusCode, 200);
    assert.deepEqual(mobileUpdated.json(), { user: { id: "user-1", nickname: "手机端" } });

    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { nickname: null },
    });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(cleared.json(), { user: { id: "user-1", nickname: null } });
    assert.equal(pool.callsMatching(/UPDATE users SET nickname/).at(-1).params[1], null);
  } finally {
    await app.close();
  }
});

test("PATCH /users/me rejects missing, non-text, and oversized nicknames", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await createApp(pool, gateway);
  try {
    const token = await login(app, pool, { membership: null });
    const headers = { authorization: `Bearer ${token}` };
    for (const nickname of [undefined, 123, "x".repeat(41)]) {
      const payload = nickname === undefined ? {} : { nickname };
      const response = await app.inject({ method: "PATCH", url: "/api/v1/users/me", headers, payload });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, "VALIDATION_ERROR");
    }
    assert.equal(pool.callsMatching(/UPDATE users SET nickname/).length, 0);
  } finally {
    await app.close();
  }
});

test("POST /auth/logout revokes the current bearer hash", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await createApp(pool, gateway);
  try {
    const token = await login(app, pool, { membership: null });
    pool.always(/DELETE FROM sessions WHERE token_hash/, { rows: [], rowCount: 0 });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { revoked: true });
    const deletion = pool.callsMatching(/DELETE FROM sessions WHERE token_hash/)[0];
    assert.equal(deletion.params[0], createHash("sha256").update(token).digest("hex"));
  } finally {
    await app.close();
  }
});

test("POST /auth/logout without a session is rejected cleanly", async () => {
  const app = await createApp(createFakePool(), createTestGateway({}));
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/logout", payload: {} });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "UNAUTHORIZED");
  } finally {
    await app.close();
  }
});
