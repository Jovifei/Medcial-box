// 药品端点合成测试：列表派生有效期状态、创建/编辑/归档、跨家庭 404、409 冲突。
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

test("listing medicines groups batches and derives expiry states", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(
      /FROM medicines WHERE family_id/,
      {
        rows: [
          medicineRow({ id: "m-1" }),
          medicineRow({ id: "m-2", name: "阿莫西林胶囊" }),
        ],
        rowCount: 2,
      },
    );
    pool.always(/FROM medicine_batches WHERE family_id/, {
      rows: [
        batchRow({ id: "b-1", medicine_id: "m-1", expiry_value: "2099-12-31", expiry_precision: "day" }),
        batchRow({ id: "b-2", medicine_id: "m-2", expiry_value: "1999-01", expiry_precision: "month", quantity: null }),
      ],
      rowCount: 2,
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/medicines", ...authHeader() });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.medicines.length, 2);
    assert.equal(body.medicines[0].batches.length, 1);
    assert.equal(body.medicines[0].expiryState.state, "ok");
    assert.equal(body.medicines[0].batches[0].expiryState.state, "ok");
    // 数量未知（null）+ 年月精度过期批次 → 该药整体已过期。
    assert.equal(body.medicines[1].batches[0].quantity, null);
    assert.equal(body.medicines[1].batches[0].expiryState.state, "expired");
    assert.equal(body.medicines[1].expiryState.state, "expired");
  } finally {
    await app.close();
  }
});

test("archived medicines are hidden by default and shown with includeArchived=true", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE family_id/, { rows: [], rowCount: 0 });
    pool.always(/FROM medicine_batches WHERE family_id/, { rows: [], rowCount: 0 });

    await app.inject({ method: "GET", url: "/api/v1/medicines", ...authHeader() });
    await app.inject({
      method: "GET",
      url: "/api/v1/medicines?includeArchived=true",
      ...authHeader(),
    });

    const queries = pool.callsMatching(/FROM medicines WHERE family_id/);
    assert.equal(queries.length, 2);
    assert.match(queries[0].sql, /AND is_archived = FALSE/);
    assert.doesNotMatch(queries[1].sql, /is_archived = FALSE/);
  } finally {
    await app.close();
  }
});

test("creating a medicine with an initial batch returns version 1 and derived state", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.on(/INSERT INTO medicines/, {
      rows: [medicineRow({ id: "m-new", name: "布洛芬缓释胶囊", version: 1 })],
      rowCount: 1,
    });
    pool.on(/INSERT INTO medicine_batches/, {
      rows: [batchRow({ id: "b-new", medicine_id: "m-new", quantity: 2, unit: "box", version: 1 })],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicines",
      ...authHeader(),
      payload: {
        name: "布洛芬缓释胶囊",
        leaflet: { source: "包装内说明书", reviewStatus: "user_confirmed" },
        batches: [
          {
            lotNumber: "LOT-1",
            expiry: { value: "2099-12-31", precision: "day" },
            quantity: 2,
            unit: "box",
          },
        ],
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.version, 1);
    assert.equal(body.batches.length, 1);
    assert.equal(body.batches[0].expiryState.state, "ok");
    assert.equal(body.leaflet.reviewStatus, "user_confirmed");

    const insertMedicine = pool.callsMatching(/INSERT INTO medicines/)[0];
    assert.equal(insertMedicine.params[0], "family-1");
    assert.equal(insertMedicine.params[13], "user-1");
    const insertBatch = pool.callsMatching(/INSERT INTO medicine_batches/)[0];
    assert.equal(insertBatch.params[0], "m-new");
    assert.equal(insertBatch.params[1], "family-1");
  } finally {
    await app.close();
  }
});

test("medicine creation rejects invalid payloads with 400", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    const cases = [
      { payload: { name: "   " } },
      { payload: { name: "药", batches: [{ expiry: { value: "2026-10", precision: "day" } }] } },
      { payload: { name: "药", batches: [{ quantity: -1 }] } },
      { payload: { name: "药", batches: [{ confirmedUnitsPerPackage: 0 }] } },
      { payload: { name: "药", activeIngredients: "布洛芬" } },
    ];
    for (const { payload } of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/medicines",
        ...authHeader(),
        payload,
      });
      assert.equal(response.statusCode, 400, `payload should fail: ${JSON.stringify(payload)}`);
      assert.equal(response.json().error.code, "VALIDATION_ERROR");
    }
    assert.equal(pool.callsMatching(/INSERT INTO medicines/).length, 0);
  } finally {
    await app.close();
  }
});

test("cross-family access to a medicine is a 404 that leaks no existence", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [], rowCount: 0 });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/medicines/medicine-other-family",
      ...authHeader(),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "NOT_FOUND");

    // 归属谓词必须包含当前家庭。
    const query = pool.callsMatching(/FROM medicines WHERE id/)[0];
    assert.deepEqual(query.params, ["medicine-other-family", "family-1"]);
  } finally {
    await app.close();
  }
});

test("updating a medicine bumps the version when the expected version matches", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, {
      rows: [medicineRow({ id: "m-1", version: 1 })],
      rowCount: 1,
    });
    pool.on(/UPDATE medicines SET/, {
      rows: [medicineRow({ id: "m-1", name: "布洛芬缓释胶囊（改）", version: 2 })],
      rowCount: 1,
    });
    pool.always(/FROM medicine_batches WHERE medicine_id/, { rows: [], rowCount: 0 });

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1",
      ...authHeader(),
      payload: { name: "布洛芬缓释胶囊（改）", version: 1 },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.version, 2);
    assert.equal(body.name, "布洛芬缓释胶囊（改）");

    const update = pool.callsMatching(/UPDATE medicines SET/)[0];
    assert.equal(update.params[0], "m-1");
    assert.equal(update.params[1], "family-1");
    assert.equal(update.params[15], 1);
  } finally {
    await app.close();
  }
});

test("a stale version yields 409 VERSION_CONFLICT and a fresh retry succeeds", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, {
      rows: [medicineRow({ id: "m-1", version: 3 })],
      rowCount: 1,
    });
    pool.on(/UPDATE medicines SET/, { rows: [], rowCount: 0 });
    pool.on(/UPDATE medicines SET/, {
      rows: [medicineRow({ id: "m-1", version: 4 })],
      rowCount: 1,
    });
    pool.always(/FROM medicine_batches WHERE medicine_id/, { rows: [], rowCount: 0 });

    const conflict = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1",
      ...authHeader(),
      payload: { name: "布洛芬缓释胶囊", version: 1 },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "VERSION_CONFLICT");

    const retry = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1",
      ...authHeader(),
      payload: { name: "布洛芬缓释胶囊", version: 3 },
    });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().version, 4);
  } finally {
    await app.close();
  }
});

test("archiving is idempotent and missing medicines still return 404", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.on(/UPDATE medicines SET is_archived/, { rows: [{ id: "m-1" }], rowCount: 1 });
    const first = await app.inject({
      method: "DELETE",
      url: "/api/v1/medicines/m-1",
      ...authHeader(),
    });
    assert.equal(first.statusCode, 204);

    pool.on(/UPDATE medicines SET is_archived/, { rows: [], rowCount: 0 });
    pool.always(/FROM medicines WHERE id/, {
      rows: [medicineRow({ id: "m-1", is_archived: true })],
      rowCount: 1,
    });
    const second = await app.inject({
      method: "DELETE",
      url: "/api/v1/medicines/m-1",
      ...authHeader(),
    });
    assert.equal(second.statusCode, 204);

    pool.on(/UPDATE medicines SET is_archived/, { rows: [], rowCount: 0 });
    pool.always(/FROM medicines WHERE id/, { rows: [], rowCount: 0 });
    const missing = await app.inject({
      method: "DELETE",
      url: "/api/v1/medicines/m-unknown",
      ...authHeader(),
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 审核修复 #2/#3：药品+批次在同一连接事务内创建与同步
// ---------------------------------------------------------------------------

test("medicine creation runs inside a single transaction (BEGIN before, COMMIT after)", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.on(/INSERT INTO medicines/, {
      rows: [medicineRow({ id: "m-tx", version: 1 })],
      rowCount: 1,
    });
    pool.on(/INSERT INTO medicine_batches/, {
      rows: [batchRow({ id: "b-tx", medicine_id: "m-tx" })],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicines",
      ...authHeader(),
      payload: { name: "事务药品", batches: [{ quantity: 1, unit: "box" }] },
    });
    assert.equal(response.statusCode, 201);

    // BEGIN → INSERT medicines → INSERT medicine_batches → COMMIT 顺序必须成立。
    const ordered = pool.calls.map((call) => call.sql);
    const begin = ordered.findIndex((sql) => sql === "BEGIN");
    const commit = ordered.findIndex((sql) => sql === "COMMIT");
    const insertMedicineAt = ordered.findIndex((sql) => sql.includes("INSERT INTO medicines"));
    const insertBatchAt = ordered.findIndex((sql) => sql.includes("INSERT INTO medicine_batches"));
    assert.ok(begin !== -1 && commit !== -1, "事务必须显式开启并提交");
    assert.ok(begin < insertMedicineAt && insertMedicineAt < insertBatchAt && insertBatchAt < commit);
  } finally {
    await app.close();
  }
});

test("medicine update syncs batches (add / update / delete) in one transaction", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, {
      rows: [medicineRow({ id: "m-1", version: 2 })],
      rowCount: 1,
    });
    pool.on(/UPDATE medicines SET/, {
      rows: [medicineRow({ id: "m-1", version: 3 })],
      rowCount: 1,
    });
    // 模拟真实库：同步后再查询时，行集合应反映已插入/已删除的批次。
    pool.always(/FROM medicine_batches WHERE medicine_id/, () => {
      const inserted = pool.callsMatching(/INSERT INTO medicine_batches/).length > 0;
      const deleted = pool.callsMatching(/DELETE FROM medicine_batches/).length > 0;
      const rows = [
        batchRow({ id: "b-keep", version: 5 }),
        ...(inserted ? [batchRow({ id: "b-new", medicine_id: "m-1" })] : []),
        ...(deleted ? [] : [batchRow({ id: "b-drop", version: 1 })]),
      ];
      return { rows, rowCount: rows.length };
    });
    pool.on(/UPDATE medicine_batches SET/, {
      rows: [batchRow({ id: "b-keep", version: 5 })],
      rowCount: 1,
    });
    pool.on(/INSERT INTO medicine_batches/, {
      rows: [batchRow({ id: "b-new", medicine_id: "m-1" })],
      rowCount: 1,
    });
    pool.on(/DELETE FROM medicine_batches/, {
      rows: [{ id: "b-drop" }],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1",
      ...authHeader(),
      payload: {
        name: "布洛芬缓释胶囊",
        version: 2,
        batches: [
          // 更新已有批次（携带其当前版本作为乐观锁门）。
          { id: "b-keep", version: 4, quantity: 5, unit: "box" },
          // 新增批次（无 id）。
          { quantity: 2, unit: "box" },
          // b-drop 未出现 → 视为用户已删除。
        ],
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(
      body.batches.map((batch) => batch.id).sort(),
      ["b-keep", "b-new"],
      "删除的批次不应出现在结果里",
    );
    assert.equal(pool.callsMatching(/DELETE FROM medicine_batches/).length, 1);
    assert.equal(pool.callsMatching(/INSERT INTO medicine_batches/).length, 1);
    assert.equal(pool.callsMatching(/UPDATE medicine_batches SET/).length, 1);
  } finally {
    await app.close();
  }
});

test("a stale batch version during medicine save yields 409 and rolls the whole save back", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    pool.always(/FROM medicines WHERE id/, {
      rows: [medicineRow({ id: "m-1", version: 2 })],
      rowCount: 1,
    });
    pool.on(/UPDATE medicines SET/, {
      rows: [medicineRow({ id: "m-1", version: 3 })],
      rowCount: 1,
    });
    pool.always(/FROM medicine_batches WHERE medicine_id/, {
      rows: [batchRow({ id: "b-1", version: 7 })],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1",
      ...authHeader(),
      payload: {
        name: "布洛芬缓释胶囊",
        version: 2,
        batches: [{ id: "b-1", version: 1, quantity: 9, unit: "box" }],
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "VERSION_CONFLICT");
    // 整个保存回滚：ROLLBACK 必须出现，且事务显式开启。
    const rollback = pool.callsMatching(/^ROLLBACK$/).length;
    assert.equal(rollback, 1);
  } finally {
    await app.close();
  }
});
