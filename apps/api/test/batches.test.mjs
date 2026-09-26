// 批次端点合成测试：同药多批次、数量未知/零、批次级 409、盒→片换算校验、删除。
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import {
  authHeader,
  batchRow,
  createApp,
  login,
  medicineRow,
  membershipRow,
} from "./helpers/app.mjs";

async function loggedInApp(pool, gateway) {
  const app = await createApp(pool, gateway);
  await login(app, pool, { membership: membershipRow() });
  return app;
}

test("one medicine keeps multiple batches with independent versions", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    // 审核修复 #3：批次增/改/删成功后递增药品聚合版本。
    pool.always(/UPDATE medicines SET version = version \+ 1/, {
      rows: [{ id: "m-1" }],
      rowCount: 1,
    });
    pool.on(/INSERT INTO medicine_batches/, {
      rows: [batchRow({ id: "b-1", version: 1 })],
      rowCount: 1,
    });
    pool.on(/INSERT INTO medicine_batches/, {
      rows: [batchRow({ id: "b-2", lot_number: "LOT-2", version: 1 })],
      rowCount: 1,
    });
    pool.always(/FROM medicine_batches WHERE medicine_id/, {
      rows: [
        batchRow({ id: "b-1", version: 2, quantity: 3 }),
        batchRow({ id: "b-2", lot_number: "LOT-2", version: 1, quantity: null }),
      ],
      rowCount: 2,
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/m-1/batches",
      ...authHeader(),
      payload: { lotNumber: "LOT-1", expiry: { value: "2099-12-31", precision: "day" }, quantity: 2 },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/m-1/batches",
      ...authHeader(),
      payload: { lotNumber: "LOT-2", expiry: { value: "2099-12", precision: "month" }, quantity: null },
    });
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/medicines/m-1/batches",
      ...authHeader(),
    });
    assert.equal(list.statusCode, 200);
    const batches = list.json().batches;
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map((batch) => batch.id), ["b-1", "b-2"]);
    assert.equal(batches[0].version, 2);
    assert.equal(batches[1].version, 1);
  } finally {
    await app.close();
  }
});

test("quantity null means unknown and zero means definitely empty", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    pool.always(/UPDATE medicines SET version = version \+ 1/, {
      rows: [{ id: "m-1" }],
      rowCount: 1,
    });
    pool.on(/INSERT INTO medicine_batches/, {
      rows: [batchRow({ id: "b-1", quantity: null })],
      rowCount: 1,
    });
    pool.on(/INSERT INTO medicine_batches/, {
      rows: [batchRow({ id: "b-2", quantity: 0 })],
      rowCount: 1,
    });

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/m-1/batches",
      ...authHeader(),
      payload: { expiry: { value: "2099-12-31", precision: "day" }, quantity: null },
    });
    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/m-1/batches",
      ...authHeader(),
      payload: { expiry: { value: "2099-12-31", precision: "day" }, quantity: 0 },
    });
    assert.equal(unknown.statusCode, 201);
    assert.equal(unknown.json().quantity, null);
    assert.equal(empty.statusCode, 201);
    assert.equal(empty.json().quantity, 0);

    const quantities = pool
      .callsMatching(/INSERT INTO medicine_batches/)
      .map((call) => call.params[5]);
    assert.deepEqual(quantities, [null, 0]);
  } finally {
    await app.close();
  }
});

test("confirmed units per package must be a positive integer or absent", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    pool.always(/UPDATE medicines SET version = version \+ 1/, {
      rows: [{ id: "m-1" }],
      rowCount: 1,
    });
    pool.on(/INSERT INTO medicine_batches/, {
      rows: [batchRow({ id: "b-1", confirmed_units_per_package: 24 })],
      rowCount: 1,
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/m-1/batches",
      ...authHeader(),
      payload: { confirmedUnitsPerPackage: 0 },
    });
    assert.equal(invalid.statusCode, 400);

    const valid = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/m-1/batches",
      ...authHeader(),
      payload: { confirmedUnitsPerPackage: 24 },
    });
    assert.equal(valid.statusCode, 201);
    assert.equal(valid.json().confirmedUnitsPerPackage, 24);
  } finally {
    await app.close();
  }
});

test("batch endpoints reject unknown or cross-family medicines with 404", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [], rowCount: 0 });
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/medicines/m-other/batches",
      ...authHeader(),
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/m-other/batches",
      ...authHeader(),
      payload: { quantity: 1 },
    });
    assert.equal(list.statusCode, 404);
    assert.equal(create.statusCode, 404);
    assert.equal(list.json().error.code, "NOT_FOUND");

    const query = pool.callsMatching(/FROM medicines WHERE id/)[0];
    assert.equal(query.params[1], "family-1");
  } finally {
    await app.close();
  }
});

test("a batch-level version conflict does not affect the medicine row", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    pool.always(/FROM medicine_batches WHERE id/, {
      rows: [batchRow({ id: "b-1", version: 2 })],
      rowCount: 1,
    });
    pool.on(/UPDATE medicine_batches SET/, { rows: [], rowCount: 0 });
    pool.always(/FROM medicine_batches WHERE medicine_id/, {
      rows: [batchRow({ id: "b-1", version: 2 })],
      rowCount: 1,
    });

    const conflict = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1/batches/b-1",
      ...authHeader(),
      payload: { quantity: 5, version: 1 },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "VERSION_CONFLICT");

    const medicine = await app.inject({
      method: "GET",
      url: "/api/v1/medicines/m-1",
      ...authHeader(),
    });
    assert.equal(medicine.statusCode, 200);
    assert.equal(medicine.json().batches[0].version, 2);
  } finally {
    await app.close();
  }
});

test("updating a batch with the matching version bumps it and returns the row", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    pool.always(/UPDATE medicines SET version = version \+ 1/, {
      rows: [{ id: "m-1" }],
      rowCount: 1,
    });
    pool.always(/FROM medicine_batches WHERE id/, {
      rows: [batchRow({ id: "b-1", version: 1 })],
      rowCount: 1,
    });
    pool.on(/UPDATE medicine_batches SET/, {
      rows: [batchRow({ id: "b-1", version: 2, quantity: 5, unit: "tablet" })],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1/batches/b-1",
      ...authHeader(),
      payload: { quantity: 5, unit: "tablet", version: 1 },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.version, 2);
    assert.equal(body.quantity, 5);

    const update = pool.callsMatching(/UPDATE medicine_batches SET/)[0];
    assert.deepEqual(update.params.slice(0, 3), ["b-1", "m-1", "family-1"]);
    assert.equal(update.params[11], 1);
  } finally {
    await app.close();
  }
});

test("a missing batch is a 404 and deletion is physical", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    pool.always(/UPDATE medicines SET version = version \+ 1/, {
      rows: [{ id: "m-1" }],
      rowCount: 1,
    });

    pool.always(/FROM medicine_batches WHERE id/, { rows: [], rowCount: 0 });
    const missingUpdate = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1/batches/b-missing",
      ...authHeader(),
      payload: { quantity: 1, version: 1 },
    });
    assert.equal(missingUpdate.statusCode, 404);
    assert.equal(missingUpdate.json().error.code, "NOT_FOUND");

    pool.on(/DELETE FROM medicine_batches/, { rows: [{ id: "b-1" }], rowCount: 1 });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/medicines/m-1/batches/b-1",
      ...authHeader(),
    });
    assert.equal(deleted.statusCode, 204);

    pool.on(/DELETE FROM medicine_batches/, { rows: [], rowCount: 0 });
    const missingDelete = await app.inject({
      method: "DELETE",
      url: "/api/v1/medicines/m-1/batches/b-missing",
      ...authHeader(),
    });
    assert.equal(missingDelete.statusCode, 404);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 审核修复 #3：批次独立操作递增药品聚合版本（整体保存的旧页面必须撞 409）
// ---------------------------------------------------------------------------

test("standalone batch creation bumps the medicine aggregate version", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, {
      rows: [medicineRow({ id: "m-1", version: 1 })],
      rowCount: 1,
    });
    pool.always(/UPDATE medicines SET version = version \+ 1/, {
      rows: [{ id: "m-1" }],
      rowCount: 1,
    });
    pool.on(/INSERT INTO medicine_batches/, {
      rows: [batchRow({ id: "b-new" })],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/m-1/batches",
      ...authHeader(),
      payload: { quantity: 3, unit: "box" },
    });
    assert.equal(response.statusCode, 201);
    const bumps = pool.callsMatching(/UPDATE medicines SET version = version \+ 1/);
    assert.equal(bumps.length, 1, "批次新增必须递增药品聚合版本");
    // 聚合版本递增与批次插入在同一事务（BEGIN…COMMIT 包裹）。
    const ordered = pool.calls.map((call) => call.sql);
    const begin = ordered.indexOf("BEGIN");
    const bump = ordered.findIndex((sql) => sql.includes("UPDATE medicines SET version"));
    const commit = ordered.indexOf("COMMIT");
    assert.ok(begin !== -1 && begin < bump && bump < commit, "版本递增必须在事务内");
  } finally {
    await app.close();
  }
});

test("failed batch mutation does not bump the medicine aggregate version", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    pool.always(/FROM medicine_batches WHERE id/, {
      rows: [batchRow({ id: "b-1", version: 2 })],
      rowCount: 1,
    });
    pool.on(/UPDATE medicine_batches SET/, { rows: [], rowCount: 0 });

    const conflict = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1/batches/b-1",
      ...authHeader(),
      payload: { quantity: 5, version: 1 },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(
      pool.callsMatching(/UPDATE medicines SET version = version \+ 1/).length,
      0,
      "失败操作不得递增药品版本",
    );
    assert.equal(pool.callsMatching(/^ROLLBACK$/).length, 1, "失败操作必须整体回滚");
  } finally {
    await app.close();
  }
});
