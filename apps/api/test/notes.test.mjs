// 个人剂量备注合成测试：可见性（本人 + family 可见）、他人备注 404、409 冲突。
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import {
  authHeader,
  createApp,
  login,
  medicineRow,
  membershipRow,
  noteRow,
} from "./helpers/app.mjs";

async function loggedInApp(pool, gateway) {
  const app = await createApp(pool, gateway);
  await login(app, pool, { membership: membershipRow() });
  return app;
}

test("listing notes returns mine plus family-visible ones with isMine flags", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    pool.always(/FROM dosage_notes WHERE medicine_id/, {
      rows: [
        noteRow({ id: "n-1", user_id: "user-1", visibility: "private", content: "每日一次" }),
        noteRow({ id: "n-2", user_id: "user-2", visibility: "family", content: "饭后服用" }),
      ],
      rowCount: 2,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/medicines/m-1/dosage-notes",
      ...authHeader(),
    });
    assert.equal(response.statusCode, 200);
    const notes = response.json().notes;
    assert.equal(notes.length, 2);
    assert.equal(notes[0].isMine, true);
    assert.equal(notes[1].isMine, false);
    assert.equal(notes[1].userId, "user-2");

    // 可见性谓词：本人 OR family 可见，且按家庭成员过滤。
    const query = pool.callsMatching(/FROM dosage_notes WHERE medicine_id/)[0];
    assert.match(query.sql, /user_id = \$3 OR visibility = 'family'/);
    assert.deepEqual(query.params, ["m-1", "family-1", "user-1"]);
  } finally {
    await app.close();
  }
});

test("creating a note defaults to private visibility", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    pool.always(/INSERT INTO dosage_notes/, {
      rows: [noteRow({ id: "n-9", user_id: "user-1", visibility: "private", content: "每日两次" })],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/m-1/dosage-notes",
      ...authHeader(),
      payload: { content: "每日两次，每次1片" },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.visibility, "private");
    assert.equal(body.isMine, true);

    const insert = pool.callsMatching(/INSERT INTO dosage_notes/)[0];
    assert.equal(insert.params[4], "private");
  } finally {
    await app.close();
  }
});

test("creating a note with empty content or bad visibility fails with 400", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    const cases = [{ payload: {} }, { payload: { content: "  " } }, { payload: { content: "x", visibility: "public" } }];
    for (const { payload } of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/medicines/m-1/dosage-notes",
        ...authHeader(),
        payload,
      });
      assert.equal(response.statusCode, 400, `payload should fail: ${JSON.stringify(payload)}`);
      assert.equal(response.json().error.code, "VALIDATION_ERROR");
    }
    assert.equal(pool.callsMatching(/INSERT INTO dosage_notes/).length, 0);
  } finally {
    await app.close();
  }
});

test("another member's note is invisible for edits (404), including family-visible ones", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    pool.always(/FROM dosage_notes WHERE id/, { rows: [], rowCount: 0 });

    const update = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1/dosage-notes/n-2",
      ...authHeader(),
      payload: { content: "试图改别人的备注", version: 1 },
    });
    const remove = await app.inject({
      method: "DELETE",
      url: "/api/v1/medicines/m-1/dosage-notes/n-2",
      ...authHeader(),
    });
    assert.equal(update.statusCode, 404);
    assert.equal(remove.statusCode, 404);

    // 编辑查询必须绑定备注所属成员。
    const query = pool.callsMatching(/FROM dosage_notes WHERE id/)[0];
    assert.deepEqual(query.params, ["n-2", "m-1", "family-1", "user-1"]);
  } finally {
    await app.close();
  }
});

test("updating my own note honors the version and conflicts yield 409", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    pool.always(/FROM dosage_notes WHERE id/, {
      rows: [noteRow({ id: "n-1", user_id: "user-1", version: 1 })],
      rowCount: 1,
    });
    pool.on(/UPDATE dosage_notes SET/, { rows: [], rowCount: 0 });
    pool.on(/UPDATE dosage_notes SET/, {
      rows: [noteRow({ id: "n-1", user_id: "user-1", content: "改好的用法", version: 2 })],
      rowCount: 1,
    });

    const conflict = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1/dosage-notes/n-1",
      ...authHeader(),
      payload: { content: "改好的用法", version: 9 },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "VERSION_CONFLICT");

    const retry = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1/dosage-notes/n-1",
      ...authHeader(),
      payload: { content: "改好的用法", version: 1 },
    });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().version, 2);

    // 仅改可见性时沿用原内容。
    pool.on(/UPDATE dosage_notes SET/, {
      rows: [noteRow({ id: "n-1", user_id: "user-1", visibility: "family", version: 3 })],
      rowCount: 1,
    });
    const visibilityOnly = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1/dosage-notes/n-1",
      ...authHeader(),
      payload: { visibility: "family", version: 2 },
    });
    assert.equal(visibilityOnly.statusCode, 200);
    assert.equal(visibilityOnly.json().visibility, "family");
    const visibilityUpdate = pool.callsMatching(/UPDATE dosage_notes SET/).at(-1);
    assert.equal(visibilityUpdate.params[4], "每日两次，每次1片");
  } finally {
    await app.close();
  }
});

test("deleting my own note returns 204; unknown notes return 404", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    pool.on(/DELETE FROM dosage_notes/, { rows: [{ id: "n-1" }], rowCount: 1 });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/medicines/m-1/dosage-notes/n-1",
      ...authHeader(),
    });
    assert.equal(deleted.statusCode, 204);

    pool.on(/DELETE FROM dosage_notes/, { rows: [], rowCount: 0 });
    const missing = await app.inject({
      method: "DELETE",
      url: "/api/v1/medicines/m-1/dosage-notes/n-missing",
      ...authHeader(),
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("note endpoints on a missing or cross-family medicine return 404", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [], rowCount: 0 });
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/medicines/m-other/dosage-notes",
      ...authHeader(),
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/m-other/dosage-notes",
      ...authHeader(),
      payload: { content: "x" },
    });
    assert.equal(list.statusCode, 404);
    assert.equal(create.statusCode, 404);
    assert.equal(list.json().error.code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});
