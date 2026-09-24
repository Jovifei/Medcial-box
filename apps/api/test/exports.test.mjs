// Markdown 导出合成测试：字段完整性、分区正确性、转义、个人剂量权限、归档排除。
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
  noteRow,
} from "./helpers/app.mjs";

async function loggedInApp(pool, gateway) {
  const app = await createApp(pool, gateway);
  await login(app, pool, { membership: membershipRow() });
  return app;
}

function seedMedicines(pool, rows, batchRows) {
  pool.always(/FROM medicines WHERE family_id/, { rows, rowCount: rows.length });
  pool.always(/FROM medicine_batches WHERE family_id/, {
    rows: batchRows,
    rowCount: batchRows.length,
  });
}

test("default export renders complete fields for an active medicine", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    seedMedicines(
      pool,
      [medicineRow({ id: "m-1" })],
      [batchRow({ id: "b-1", medicine_id: "m-1", quantity: 2, unit: "box", storage_location: "客厅药箱" })],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/exports/markdown",
      ...authHeader(),
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    const markdown = body.markdown;
    assert.ok(markdown.startsWith("# 家庭药箱库存清单"));
    assert.ok(markdown.includes("以说明书和医嘱为准"), "disclaimer must be present");
    assert.ok(markdown.includes("布洛芬缓释胶囊"));
    assert.ok(markdown.includes("0.3g\\*20粒"), "specification rendered with * escaped");
    assert.equal(markdown.includes("0.3g*20粒"), false, "unescaped * must not appear");
    assert.ok(markdown.includes("客厅药箱"), "storage location included by default (D1)");
    assert.ok(markdown.includes("2 盒"));
    assert.ok(markdown.includes("2099-12-31"));
    assert.ok(markdown.includes("在用库存"));
    assert.ok(markdown.includes("本人已核对"), "confirmed leaflet rendered");
    assert.ok(markdown.includes("来源：包装内说明书"));
    assert.ok(markdown.includes("个人剂量备注：未包含"), "notes excluded by default");
    // 归档默认排除（D4）
    assert.equal(markdown.includes("## 已归档"), false);
    // 未请求个人剂量时不查备注表
    assert.equal(pool.callsMatching(/FROM dosage_notes/).length, 0);
  } finally {
    await app.close();
  }
});

test("medicines land in the correct sections (active / expired / exhausted / missing date)", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    seedMedicines(
      pool,
      [
        medicineRow({ id: "m-ok", name: "正常药品" }),
        medicineRow({ id: "m-expired", name: "过期药品" }),
        medicineRow({ id: "m-empty", name: "耗尽药品" }),
        medicineRow({ id: "m-nodate", name: "待补充药品" }),
      ],
      [
        batchRow({ id: "b-ok", medicine_id: "m-ok", expiry_value: "2099-12-31", quantity: 1 }),
        batchRow({ id: "b-unknown", medicine_id: "m-ok", expiry_value: "2099-03-01", quantity: null }),
        batchRow({ id: "b-expired", medicine_id: "m-expired", expiry_value: "1999-01", expiry_precision: "month", quantity: 3 }),
        batchRow({ id: "b-empty", medicine_id: "m-empty", quantity: 0 }),
        batchRow({ id: "b-nodate", medicine_id: "m-nodate", expiry_value: null, expiry_precision: "unknown", quantity: 2 }),
      ],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/exports/markdown",
      ...authHeader(),
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    const markdown = response.json().markdown;

    const idx = (text) => markdown.indexOf(text);
    const activeIdx = idx("## 在用库存");
    const expiredIdx = idx("## 已过期");
    const exhaustedIdx = idx("## 已耗尽");
    const missingIdx = idx("## 日期待补充");
    for (const value of [activeIdx, expiredIdx, exhaustedIdx, missingIdx]) {
      assert.ok(value >= 0, "all four sections present");
    }
    assert.ok(idx("正常药品") > activeIdx && idx("正常药品") < expiredIdx, "active medicine in active section");
    assert.ok(idx("过期药品") > expiredIdx && idx("过期药品") < exhaustedIdx, "expired medicine in expired section");
    assert.ok(idx("耗尽药品") > exhaustedIdx && idx("耗尽药品") < missingIdx, "exhausted medicine in exhausted section");
    assert.ok(idx("待补充药品") > missingIdx, "missing-date medicine in last section");
    assert.ok(markdown.includes("仅到月"), "month precision labelled without inventing a day");
    assert.ok(markdown.includes("数量未知"), "null quantity explicitly labelled as unknown");
    assert.ok(markdown.includes("已耗尽"), "zero quantity explicitly labelled as exhausted");
  } finally {
    await app.close();
  }
});

test("user input is escaped: pipes, emphasis, headings and newlines", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    seedMedicines(
      pool,
      [
        medicineRow({
          id: "m-evil",
          name: "布|洛*芬#药",
          manufacturer: "示例\n药业",
          leaflet_precautions_summary: "勿与 `[含]` 同服",
        }),
      ],
      [batchRow({ id: "b-evil", medicine_id: "m-evil", lot_number: "LOT|X", storage_location: "客厅" })],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/exports/markdown",
      ...authHeader(),
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    const markdown = response.json().markdown;
    assert.ok(markdown.includes("布\\|洛\\*芬\\#药"), "name fully escaped");
    assert.equal(markdown.includes("布|洛"), false, "raw pipes must not appear");
    assert.equal(markdown.includes("示例\n药业"), false, "newlines flattened");
    assert.ok(markdown.includes("示例 药业"));
    assert.ok(markdown.includes("LOT\\|X"));
    assert.ok(markdown.includes("\\[含\\]"));
  } finally {
    await app.close();
  }
});

test("includePersonalDosage renders only notes the viewer may see, with ownership labels", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    seedMedicines(pool, [medicineRow({ id: "m-1" })], [batchRow({ id: "b-1", medicine_id: "m-1", quantity: 1 })]);
    pool.always(/FROM dosage_notes WHERE medicine_id/, {
      rows: [
        noteRow({ id: "n-1", user_id: "user-1", content: "每日两次，每次1片" }),
        noteRow({ id: "n-2", user_id: "user-2", visibility: "family", content: "饭后服用" }),
      ],
      rowCount: 2,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/exports/markdown",
      ...authHeader(),
      payload: { includePersonalDosage: true },
    });
    assert.equal(response.statusCode, 200);
    const markdown = response.json().markdown;
    assert.ok(markdown.includes("个人剂量备注：已包含"));
    assert.ok(markdown.includes("- 本人：每日两次，每次1片"));
    assert.ok(markdown.includes("- 家庭成员：饭后服用"));
    // 他人 private 备注不进导出：SQL 谓词按成员过滤。
    const noteQuery = pool.callsMatching(/FROM dosage_notes/)[0];
    assert.match(noteQuery.sql, /user_id = \$3 OR visibility = 'family'/);
    assert.deepEqual(noteQuery.params, ["m-1", "family-1", "user-1"]);
  } finally {
    await app.close();
  }
});

test("archived medicines are excluded by default and rendered in a dedicated section when requested", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    // 默认查询：真实库按 is_archived = FALSE 过滤 → 空结果（FIFO 第一条）；
    // includeArchived 查询：返回归档行（FIFO 第二条）。
    pool.on(/FROM medicines WHERE family_id/, { rows: [], rowCount: 0 });
    pool.on(/FROM medicines WHERE family_id/, {
      rows: [medicineRow({ id: "m-arch", is_archived: true, name: "旧药" })],
      rowCount: 1,
    });
    pool.always(/FROM medicine_batches WHERE family_id/, { rows: [], rowCount: 0 });

    const excluded = await app.inject({
      method: "POST",
      url: "/api/v1/exports/markdown",
      ...authHeader(),
      payload: {},
    });
    assert.equal(excluded.statusCode, 200);
    assert.equal(excluded.json().markdown.includes("旧药"), false);
    assert.match(pool.callsMatching(/FROM medicines WHERE family_id/)[0].sql, /is_archived = FALSE/);

    const included = await app.inject({
      method: "POST",
      url: "/api/v1/exports/markdown",
      ...authHeader(),
      payload: { includeArchived: true },
    });
    assert.equal(included.statusCode, 200);
    const markdown = included.json().markdown;
    assert.ok(markdown.includes("## 已归档"));
    assert.ok(markdown.includes("旧药（已归档）"));
    assert.doesNotMatch(pool.callsMatching(/FROM medicines WHERE family_id/)[1].sql, /is_archived = FALSE/);
  } finally {
    await app.close();
  }
});

test("export requires a family and a valid session (401 / 404)", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await createApp(pool, gateway);
  try {
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/v1/exports/markdown",
      payload: {},
    });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().error.code, "UNAUTHORIZED");

    await login(app, pool, { membership: null });
    const noFamily = await app.inject({
      method: "POST",
      url: "/api/v1/exports/markdown",
      ...authHeader(),
      payload: {},
    });
    assert.equal(noFamily.statusCode, 404);
    assert.equal(noFamily.json().error.code, "FAMILY_NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("storage location can be omitted via includeStorageLocation=false (D1 option)", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-code-1": "openid-user-1" });
  const app = await loggedInApp(pool, gateway);
  try {
    seedMedicines(
      pool,
      [medicineRow({ id: "m-1" })],
      [batchRow({ id: "b-1", medicine_id: "m-1", storage_location: "客厅药箱" })],
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/exports/markdown",
      ...authHeader(),
      payload: { includeStorageLocation: false },
    });
    assert.equal(response.statusCode, 200);
    const markdown = response.json().markdown;
    assert.equal(markdown.includes("客厅药箱"), false);
    assert.ok(markdown.includes("存放位置：未包含"));
  } finally {
    await app.close();
  }
});
