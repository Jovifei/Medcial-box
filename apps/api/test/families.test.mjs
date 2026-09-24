// 家庭端点合成测试：创建即 owner、一账号一家庭（409）、当前家庭查询。
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { authHeader, createApp, familyRow, login, membershipRow } from "./helpers/app.mjs";

test("creating a family makes the user owner inside one transaction", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await createApp(pool, gateway);
  try {
    await login(app, pool, { membership: null });
    pool.on(/INSERT INTO families/, {
      rows: [familyRow({ id: "family-1", name: "我的家庭" })],
      rowCount: 1,
    });
    pool.on(/INSERT INTO family_members/, {
      rows: [membershipRow({ id: "membership-1", family_id: "family-1", user_id: "user-1", role: "owner" })],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families",
      ...authHeader(),
      payload: { name: "我的家庭" },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.family.id, "family-1");
    assert.equal(body.family.name, "我的家庭");
    assert.equal(body.membership.role, "owner");

    const insert = pool.callsMatching(/INSERT INTO families/)[0];
    assert.deepEqual(insert.params, ["我的家庭", "user-1"]);
    assert.equal(pool.callsMatching(/BEGIN/).length, 1);
    assert.equal(pool.callsMatching(/COMMIT/).length, 1);
  } finally {
    await app.close();
  }
});

test("a user already in a family cannot create a second one (409)", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await createApp(pool, gateway);
  try {
    await login(app, pool, { membership: membershipRow() });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families",
      ...authHeader(),
      payload: { name: "另一个家庭" },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "ALREADY_IN_FAMILY");
    assert.equal(pool.callsMatching(/INSERT INTO families/).length, 0);
  } finally {
    await app.close();
  }
});

test("family creation validates the name (400)", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await createApp(pool, gateway);
  try {
    await login(app, pool, { membership: null });
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/families",
      ...authHeader(),
      payload: {},
    });
    const blank = await app.inject({
      method: "POST",
      url: "/api/v1/families",
      ...authHeader(),
      payload: { name: "   " },
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.code, "VALIDATION_ERROR");
    assert.equal(blank.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("GET /families/current returns the family with its members", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await createApp(pool, gateway);
  try {
    await login(app, pool, { membership: membershipRow() });
    pool.always(/FROM families WHERE id/, { rows: [familyRow()], rowCount: 1 });
    pool.always(/FROM family_members WHERE family_id/, {
      rows: [
        membershipRow({ id: "membership-1", role: "owner", user_id: "user-1" }),
        membershipRow({ id: "membership-2", role: "member", user_id: "user-2" }),
      ],
      rowCount: 2,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/families/current",
      ...authHeader(),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.family.id, "family-1");
    assert.equal(body.family.role, "owner");
    assert.equal(body.family.members.length, 2);
    assert.deepEqual(
      body.family.members.map((member) => member.role).sort(),
      ["member", "owner"],
    );
  } finally {
    await app.close();
  }
});

test("GET /families/current without a family returns 404 FAMILY_NOT_FOUND", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await createApp(pool, gateway);
  try {
    await login(app, pool, { membership: null });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/families/current",
      ...authHeader(),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "FAMILY_NOT_FOUND");
  } finally {
    await app.close();
  }
});
