// R1 定点数量与新单位（ml / blister）的真实 PostgreSQL 验证。
// 独立文件运行：登录限流是进程本地的（30 次/分钟按客户端地址共享），
// 与 integration-pg.test.mjs 合并会耗尽配额。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { createReminderTemplateConfig } from "../dist/services/subscribe-messages.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres } from "./helpers/isolated-pg.mjs";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
  return expected === 204 ? null : response.json();
}

test("real PostgreSQL: decimal quantities and ml/blister units (R1)", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
  concurrency: 1,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL; real PostgreSQL cannot be skipped");
  const fixture = await isolatedPostgres(url);
  const { pool, database } = fixture;
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(pool);
    app = await buildServer({
      database,
      wechatGateway: gateway,
      reminderTemplateConfig: createReminderTemplateConfig({
        appId: "synthetic-app-id",
        appSecret: "synthetic-secret",
        templateId: "synthetic-reminder-template",
      }),
      logger: { level: "error" },
    });
    const request = (user, method, path, payload) => app.inject({ method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${user.token}` }, ...(payload === undefined ? {} : { payload }) });
    async function family() {
      const code = randomUUID();
      gateway.registerCode(code, `r1-${code}`);
      const auth = status(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      const owner = { token: auth.token, id: auth.user.id };
      const created = status(await request(owner, "POST", "/families", { name: `家庭-${randomUUID()}` }), 201);
      owner.membershipId = created.membership.id;
      return { owner, id: created.family.id };
    }

    await t.test("create retry is idempotent and explicit bottle conversion persists", async () => {
      const { owner } = await family();
      const payload = { name: "合成测试勿服用", idempotencyKey: `entry-${randomUUID()}`, lowStockThreshold: { quantity: 200, unit: "ml" }, batches: [{ quantity: 2, unit: "bottle", confirmedUnitsPerPackage: 100.5, conversionUnit: "ml" }] };
      const [a,b] = await Promise.all([request(owner,"POST","/medicines",payload),request(owner,"POST","/medicines",payload)]);
      const first=status(a,201); assert.equal(status(b,201).id,first.id);
      assert.ok(first.createdAt);
      assert.equal(first.batches[0].conversionUnit,"ml");
      const list=status(await request(owner,"GET","/medicines"),200);
      assert.equal(list.medicines.length,1); assert.equal(list.medicines[0].batches[0].confirmedUnitsPerPackage,100.5);
      status(await request(owner,"POST","/medicines",{...payload,name:"changed"}),409);
      const receipts=await pool.query("SELECT count(*)::int AS n FROM medicine_create_receipts"); assert.equal(receipts.rows[0].n,1);
      const batch=first.batches[0];
      const changed=status(await request(owner,"PUT",`/medicines/${first.id}/batches/${batch.id}`,{
        version:batch.version,unit:'bottle',quantity:1,confirmedUnitsPerPackage:100.5,
      }),200);
      assert.equal(changed.conversionUnit,'ml'); assert.equal(changed.confirmedUnitsPerPackage,100.5);
      const current=status(await request(owner,"GET",`/medicines/${first.id}`),200);
      const edited=status(await request(owner,"PUT",`/medicines/${first.id}`,{
        name:current.name,version:current.version,batches:[{id:changed.id,version:changed.version,unit:'bottle',quantity:2,confirmedUnitsPerPackage:100.5}],
      }),200);
      assert.equal(edited.batches[0].conversionUnit,'ml');
      status(await request(owner,'POST',`/medicines/${first.id}/batches`,{unit:'bottle',quantity:1,confirmedUnitsPerPackage:12.5}),400);
      await assert.rejects(pool.query("UPDATE medicine_batches SET conversion_unit=NULL, confirmed_units_per_package=12.5 WHERE id=$1",[changed.id]),error=>error.code==='23514');
    });

    await t.test("migration 013 is applied after the established migrations", async () => {
      assert.deepEqual(await applyMigrations(pool), [], "re-running migrations on an up-to-date schema must be empty");
      const columns = await pool.query(
        `SELECT table_name, column_name, numeric_scale
         FROM information_schema.columns
         WHERE table_schema = $1 AND column_name = ANY($2::text[])
         ORDER BY table_name, column_name`,
        [fixture.schema, ["quantity", "confirmed_units_per_package", "low_stock_threshold_quantity", "expected_quantity", "observed_quantity", "desired_quantity"]],
      );
      assert.ok(columns.rows.length >= 6, JSON.stringify(columns.rows));
      for (const row of columns.rows) {
        assert.equal(row.numeric_scale, 3, `${row.table_name}.${row.column_name} must be numeric(*,3)`);
      }
      const units = await pool.query(
        `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE c.conname = 'medicine_batches_unit_check' AND n.nspname = $1`,
        [fixture.schema],
      );
      assert.equal(units.rowCount, 1, "the unit constraint must exist in this isolated schema");
      assert.match(units.rows[0].def, /ml/);
      assert.match(units.rows[0].def, /blister/);
    });

    await t.test("millilitre quantities keep three decimals through create, read and update", async () => {
      const { owner } = await family();
      const created = status(await request(owner, "POST", "/medicines", {
        name: "止咳糖浆",
        lowStockThreshold: { quantity: 5.5, unit: "ml" },
        batches: [
          { lotNumber: "ML-1", expiry: { value: "2027-06-30", precision: "day" }, quantity: 12.5, unit: "ml", storageLocation: "冰箱" },
          { lotNumber: "BL-1", expiry: { value: "2027-06-30", precision: "day" }, quantity: 2, unit: "blister" },
        ],
      }), 201);
      assert.equal(created.lowStockThreshold.quantity, 5.5);
      const mlBatch = created.batches.find((item) => item.unit === "ml");
      assert.equal(mlBatch.quantity, 12.5, "12.5ml must not degrade to 12 or '12.500'");
      assert.equal(created.batches.find((item) => item.unit === "blister").quantity, 2);

      const reopened = status(await request(owner, "GET", `/medicines/${created.id}`), 200);
      assert.equal(reopened.batches.find((item) => item.unit === "ml").quantity, 12.5);
      assert.equal(typeof reopened.batches.find((item) => item.unit === "ml").quantity, "number");

      // 0.001（三位小数）允许；这是毫升的最小精度。
      const precise = status(await request(owner, "PUT", `/medicines/${created.id}/batches/${mlBatch.id}`, {
        ...mlBatch, quantity: 0.001,
      }), 200);
      assert.equal(precise.quantity, 0.001);

      const back = status(await request(owner, "PUT", `/medicines/${created.id}/batches/${mlBatch.id}`, {
        ...precise, quantity: 12.5,
      }), 200);
      assert.equal(back.quantity, 12.5);
    });

    await t.test("fractional counts are rejected while millilitres are accepted", async () => {
      const { owner } = await family();
      const created = status(await request(owner, "POST", "/medicines", {
        name: "校验用药品",
        batches: [{ quantity: 1, unit: "box" }],
      }), 201);
      const boxBatch = created.batches[0];

      // 计件单位不接受小数
      const fractionRejected = await request(owner, "PUT", `/medicines/${created.id}/batches/${boxBatch.id}`, {
        ...boxBatch, quantity: 1.5,
      });
      assert.equal(fractionRejected.statusCode, 400, fractionRejected.body);
      assert.match(fractionRejected.body, /整数|INVALID|VALIDATION/);

      // 毫升最多三位小数
      const tooPrecise = await request(owner, "POST", `/medicines/${created.id}/batches`, {
        quantity: 1.2345, unit: "ml",
      });
      assert.equal(tooPrecise.statusCode, 400, tooPrecise.body);

      const accepted = status(await request(owner, "POST", `/medicines/${created.id}/batches`, {
        quantity: 1.235, unit: "ml",
      }), 201);
      assert.equal(accepted.quantity, 1.235);

      // 负数在任何单位下都不接受
      const negative = await request(owner, "POST", `/medicines/${created.id}/batches`, {
        quantity: -0.5, unit: "ml",
      });
      assert.equal(negative.statusCode, 400, negative.body);
    });

    await t.test("zero stays distinct from unknown and stocktake keeps decimals", async () => {
      const { owner } = await family();
      const created = status(await request(owner, "POST", "/medicines", {
        name: "余量语义药品",
        batches: [
          { expiry: { value: "2027-06-30", precision: "day" }, quantity: 0, unit: "ml" },
          { expiry: { value: "2027-06-30", precision: "day" }, unit: "ml" },
        ],
      }), 201);
      const zeroBatch = created.batches.find((item) => item.quantity === 0);
      const unknownBatch = created.batches.find((item) => item.quantity === null);
      assert.ok(zeroBatch, "0ml must be stored as an explicit zero");
      assert.ok(unknownBatch, "omitted quantity must stay null (unknown)");

      const session = status(await request(owner, "POST", "/families/stocktakes"), 201).stocktake;
      const adjusted = status(await request(owner, "POST", `/families/stocktakes/${session.id}/items`, {
        items: [{ batchId: zeroBatch.id, version: zeroBatch.version, outcome: "adjusted", quantity: 2.25 }],
      }), 200);
      assert.equal(adjusted.results.length, 1);
      assert.equal(adjusted.results[0].batchId, zeroBatch.id);
      assert.equal(adjusted.results[0].outcome, "saved");
      const after = status(await request(owner, "GET", `/medicines/${created.id}`), 200);
      assert.equal(after.batches.find((item) => item.id === zeroBatch.id).quantity, 2.25, "stocktake must keep millilitre decimals");
    });

    await t.test("miniprogram entry survives a Flutter threshold update with tags intact (B01)", async () => {
      const { owner } = await family();
      // 小程序形状：12.5ml + 标签 + 条码
      const created = status(await request(owner, "POST", "/medicines", {
        name: "生理盐水",
        barcodeValue: "6901234500017",
        populationTags: ["child"],
        purposeTags: ["nasal"],
        tagSource: "manual",
        batches: [
          { quantity: 12.5, unit: "ml", expiry: { value: "2027-06", precision: "month" } },
        ],
      }), 201);
      assert.equal(created.batches[0].quantity, 12.5);

      // App（修复后）形状：完整字段更新，只改阈值；标签/条码原样回传
      const detail = status(await request(owner, "GET", `/medicines/${created.id}`), 200);
      const updated = status(await request(owner, "PUT", `/medicines/${created.id}`, {
        name: detail.name,
        specification: detail.specification,
        manufacturer: detail.manufacturer,
        approvalNumber: detail.approvalNumber,
        barcodeValue: detail.barcodeValue,
        activeIngredients: detail.activeIngredients,
        purposeCategory: detail.purposeCategory,
        populationTags: detail.populationTags,
        purposeTags: detail.purposeTags,
        tagSource: detail.tagSource,
        leaflet: detail.leaflet,
        lowStockThreshold: { quantity: 50, unit: "ml" },
        version: detail.version,
        batches: detail.batches.map((batch) => ({
          id: batch.id,
          lotNumber: batch.lotNumber,
          expiry: batch.expiry,
          quantity: batch.quantity,
          unit: batch.unit,
          confirmedUnitsPerPackage: batch.confirmedUnitsPerPackage,
          storageLocation: batch.storageLocation,
          openedState: batch.openedState ?? "unknown",
          openedAt: batch.openedAt ?? null,
          afterOpeningLimit: batch.afterOpeningLimit ?? null,
          version: batch.version,
        })),
      }), 200);
      assert.equal(updated.barcodeValue, "6901234500017", "barcode must survive a full update");
      assert.deepEqual(updated.populationTags, ["child"], "population tags must survive a full update");
      assert.deepEqual(updated.purposeTags, ["nasal"], "purpose tags must survive a full update");
      assert.equal(updated.batches[0].quantity, 12.5, "decimal quantity must survive a full update");
      assert.equal(updated.lowStockThreshold.quantity, 50);
      // 5.5ml + 阈值 10ml → low（B03 的聚合侧验证）
      const fiveFive = status(await request(owner, "GET", "/medicines"), 200).medicines
        .find((entry) => entry.id === created.id);
      assert.equal(fiveFive.stockStatus.state, "low");
      assert.equal(fiveFive.stockStatus.quantity, 12.5);
    });

    await t.test("backup round-trip preserves decimal quantities and new units", async () => {
      const { owner } = await family();
      const created = status(await request(owner, "POST", "/medicines", {
        name: "备份糖浆",
        lowStockThreshold: { quantity: 7.5, unit: "ml" },
        batches: [
          { lotNumber: "BK-1", expiry: { value: "2027-06-30", precision: "day" }, quantity: 12.5, unit: "ml", confirmedUnitsPerPackage: 200.5 },
          { lotNumber: "BK-2", expiry: { value: "2027-06-30", precision: "day" }, quantity: 3, unit: "blister" },
        ],
      }), 201);
      const before = status(await request(owner, "GET", "/medicines?includeArchived=true"), 200).medicines;
      const backup = status(await request(owner, "POST", "/backups/json"), 200);
      const exported = backup.medicines.find((item) => item.name === "备份糖浆");
      assert.equal(exported.lowStockThreshold.quantity, 7.5);
      assert.equal(exported.batches.find((item) => item.lotNumber === "BK-1").quantity, 12.5);
      assert.equal(exported.batches.find((item) => item.lotNumber === "BK-1").confirmedUnitsPerPackage, 200.5);

      // 清空源数据后恢复到同一家庭（单次登录即可完成往返比对）。
      for (const medicine of before) {
        status(await request(owner, "POST", `/medicines/${medicine.id}/trash`), 204);
      }
      assert.deepEqual(status(await request(owner, "GET", "/medicines?includeArchived=true"), 200).medicines, []);
      const restoreBackup = structuredClone(backup);
      restoreBackup.backupId = randomUUID();
      const preview = status(await request(owner, "POST", "/backups/preview", { backup: restoreBackup }), 200);
      status(await request(owner, "POST", "/backups/restore", {
        backup: restoreBackup, confirmationToken: preview.confirmationToken, confirmed: true,
      }), 201);
      const restored = status(await request(owner, "GET", "/medicines?includeArchived=true"), 200).medicines;
      const restoredMain = restored.find((item) => item.name === "备份糖浆");
      assert.equal(restoredMain.lowStockThreshold.quantity, 7.5, "threshold decimals must survive the round-trip");
      assert.equal(restoredMain.batches.find((item) => item.lotNumber === "BK-1").quantity, 12.5);
      assert.equal(restoredMain.batches.find((item) => item.lotNumber === "BK-1").confirmedUnitsPerPackage, 200.5);
      assert.equal(restoredMain.batches.find((item) => item.lotNumber === "BK-2").unit, "blister");
      assert.ok(created.id);
    });

    // S3/R08：拆分入口按单位解析——毫升允许小数并守恒，计件单位拒绝小数。
    await t.test("open-split conserves millilitre decimals and rejects fractional counts", async () => {
      const { owner } = await family();
      const created = status(await request(owner, "POST", "/medicines", {
        name: "拆分糖浆",
        batches: [
          { lotNumber: "SP-ML", expiry: { value: "2027-06-30", precision: "day" }, quantity: 12.5, unit: "ml", openedState: "unopened" },
          { lotNumber: "SP-BOX", expiry: { value: "2027-06-30", precision: "day" }, quantity: 10, unit: "box", openedState: "unopened" },
        ],
      }), 201);
      const mlBatch = created.batches.find((item) => item.unit === "ml");
      const boxBatch = created.batches.find((item) => item.unit === "box");

      const split = status(await request(owner, "POST", `/medicines/${created.id}/batches/${mlBatch.id}/open-split`, {
        version: mlBatch.version, openedQuantity: 2.5, openedAt: "2026-10-02", confirmed: true,
      }), 201);
      assert.equal(split.openedBatch.quantity, 2.5, "毫升拆分必须保留小数");
      assert.equal(split.remainingBatch.quantity, 10);
      assert.equal(split.openedBatch.quantity + split.remainingBatch.quantity, 12.5, "拆分必须守恒");

      const fractional = await request(owner, "POST", `/medicines/${created.id}/batches/${boxBatch.id}/open-split`, {
        version: boxBatch.version, openedQuantity: 2.5, openedAt: "2026-10-02", confirmed: true,
      });
      assert.equal(fractional.statusCode, 400, fractional.body);
      assert.match(fractional.body, /整数|VALIDATION/);

      const boxSplit = status(await request(owner, "POST", `/medicines/${created.id}/batches/${boxBatch.id}/open-split`, {
        version: boxBatch.version, openedQuantity: 3, openedAt: "2026-10-02", confirmed: true,
      }), 201);
      assert.equal(boxSplit.openedBatch.quantity, 3);
      assert.equal(boxSplit.remainingBatch.quantity, 7);
    });

    // S3/R08：盘点入口按批次单位复核——计件单位拒绝小数，毫升保留小数（既有测试已覆盖毫升保存）。
    await t.test("stocktake rejects fractional counts for count units", async () => {
      const { owner } = await family();
      const created = status(await request(owner, "POST", "/medicines", {
        name: "盘点校验药品",
        batches: [{ lotNumber: "ST-BOX", expiry: { value: "2027-06-30", precision: "day" }, quantity: 5, unit: "box" }],
      }), 201);
      const boxBatch = created.batches[0];
      const session = status(await request(owner, "POST", "/families/stocktakes"), 201).stocktake;

      const rejected = await request(owner, "POST", `/families/stocktakes/${session.id}/items`, {
        items: [{ batchId: boxBatch.id, version: boxBatch.version, outcome: "adjusted", quantity: 2.5 }],
      });
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.match(rejected.body, /整数|VALIDATION/);

      // 拒绝后事务回滚，版本未变；整数盘点仍可保存。
      const saved = status(await request(owner, "POST", `/families/stocktakes/${session.id}/items`, {
        items: [{ batchId: boxBatch.id, version: boxBatch.version, outcome: "adjusted", quantity: 3 }],
      }), 200);
      assert.equal(saved.results[0].outcome, "saved");
      const after = status(await request(owner, "GET", `/medicines/${created.id}`), 200);
      assert.equal(after.batches.find((item) => item.id === boxBatch.id).quantity, 3);
    });

    // S3/R08：补货修改入口按最终单位复核——毫升允许小数，计件单位拒绝小数。
    await t.test("restock update accepts millilitre decimals and rejects fractional counts", async () => {
      const { owner } = await family();
      const created = status(await request(owner, "POST", "/medicines", {
        name: "补货校验药品",
        batches: [{ quantity: 1, unit: "ml" }],
      }), 201);

      const mlItem = status(await request(owner, "POST", "/families/restock", {
        medicineId: created.id, desiredQuantity: 5, unit: "ml",
      }), 201);
      const mlUpdated = status(await request(owner, "PUT", `/families/restock/${mlItem.id}`, {
        desiredQuantity: 7.5, version: mlItem.version,
      }), 200);
      assert.equal(mlUpdated.desiredQuantity, 7.5, "毫升补货目标必须保留小数");

      const boxItem = status(await request(owner, "POST", "/families/restock", {
        medicineId: created.id, desiredQuantity: 2, unit: "box",
      }), 201);
      const rejected = await request(owner, "PUT", `/families/restock/${boxItem.id}`, {
        desiredQuantity: 2.5, version: boxItem.version,
      });
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.match(rejected.body, /整数|VALIDATION/);
    });

    await t.test("tube stock persists through API and PostgreSQL", async () => {
      const { owner } = await family();
      const payload = {
        name: "合成测试勿服用",
        idempotencyKey: `tube-${randomUUID()}`,
        lowStockThreshold: { quantity: 1, unit: "tube" },
        batches: [{ quantity: 2, unit: "tube" }],
      };
      const created = status(await request(owner, "POST", "/medicines", payload), 201);
      assert.equal(created.lowStockThreshold.unit, "tube");
      assert.equal(created.batches[0].quantity, 2);
      assert.equal(created.batches[0].unit, "tube");
      const listed = status(await request(owner, "GET", "/medicines"), 200);
      assert.equal(listed.medicines[0].batches[0].unit, "tube");
      status(await request(owner, "POST", "/medicines", {
        ...payload,
        idempotencyKey: `fractional-tube-${randomUUID()}`,
        batches: [{ quantity: 1.5, unit: "tube" }],
      }), 400);
    });
  } finally {
    if (app !== undefined) await app.close();
    await fixture.close();
  }
});
