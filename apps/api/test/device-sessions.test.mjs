import assert from "node:assert/strict";
import test from "node:test";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { authHeader, createApp, login, membershipRow } from "./helpers/app.mjs";

test("current user lists sessions and can revoke only their other Android sessions", async () => {
  const pool = createFakePool();
  const app = await createApp(pool, createTestGateway({ "js-code-1": "openid-user-1" }));
  try {
    await login(app, pool, { membership: membershipRow() });
    pool.always(/FROM sessions WHERE token_hash/, {
      rows: [{ id: "10000000-0000-4000-8000-000000000001", user_id: "user-1", expires_at: "2099-01-01T00:00:00Z" }],
      rowCount: 1,
    });
    pool.always(/FROM sessions WHERE user_id =/, {
      rows: [
        { id: "10000000-0000-4000-8000-000000000001", client_kind: "miniprogram", created_at: "2026-09-28T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" },
        { id: "10000000-0000-4000-8000-000000000002", client_kind: "android", created_at: "2026-09-29T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" },
      ],
      rowCount: 2,
    });
    pool.on(/DELETE FROM sessions WHERE id =/, { rows: [{ id: "10000000-0000-4000-8000-000000000002" }], rowCount: 1 });

    const list = await app.inject({ method: "GET", url: "/api/v1/auth/devices", ...authHeader() });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().devices.map((device) => device.clientKind), ["miniprogram", "android"]);
    assert.equal(list.json().devices[0].isCurrent, true);

    const revoked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/devices/10000000-0000-4000-8000-000000000002/revoke",
      ...authHeader(),
    });
    assert.equal(revoked.statusCode, 200);
    assert.deepEqual(revoked.json(), { revoked: true });
    const deletion = pool.callsMatching(/DELETE FROM sessions WHERE id =/)[0];
    assert.match(deletion.sql, /client_kind = 'android'/);
    assert.deepEqual(deletion.params, ["10000000-0000-4000-8000-000000000002", "user-1"]);
  } finally {
    await app.close();
  }
});

test("a session cannot revoke another user's App session", async () => {
  const pool = createFakePool();
  const app = await createApp(pool, createTestGateway({ "js-code-1": "openid-user-1" }));
  try {
    await login(app, pool, { membership: membershipRow() });
    pool.always(/FROM sessions WHERE token_hash/, {
      rows: [{ id: "10000000-0000-4000-8000-000000000001", user_id: "user-1", expires_at: "2099-01-01T00:00:00Z" }],
      rowCount: 1,
    });
    pool.on(/DELETE FROM sessions WHERE id =/, { rows: [], rowCount: 0 });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/devices/20000000-0000-4000-8000-000000000001/revoke",
      ...authHeader(),
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
  }
});
