import assert from "node:assert/strict";
import test from "node:test";
import { validateMedicineInput } from "../dist/inputs.js";
import { insertMedicine, updateMedicine, toMedicineSummary } from "../dist/repositories/medicines.js";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { medicineRow } from "./helpers/app.mjs";
import { createFamilyMedicineBackup, validateFamilyMedicineBackup } from "../dist/services/backup-snapshot.js";

test("brand is independent of manufacturer and new purpose tags survive validation", () => {
  const result = validateMedicineInput({ name: "合成药", brand: "测试品牌", manufacturer: "测试厂家", purposeTags: ["itch", "eye", "oral", "constipation", "diarrhea"] });
  assert.equal(result.ok, true);
  assert.equal(result.value.brand, "测试品牌");
  assert.equal(result.value.manufacturer, "测试厂家");
  assert.equal(result.value.brandProvided, true);
  assert.deepEqual(result.value.purposeTags, ["itch", "eye", "oral", "constipation", "diarrhea"]);
});

test("brand is inserted and old-client updates preserve stored brand", async () => {
  const pool = createFakePool();
  const fields = validateMedicineInput({ name: "合成药", brand: "测试品牌" }).value;
  pool.always(/INSERT INTO medicines/, { rows: [medicineRow({ brand: "测试品牌" })] });
  await insertMedicine(pool, "family-1", fields, "user-1");
  const insert = pool.callsMatching(/INSERT INTO medicines/)[0];
  assert.match(insert.sql, /updated_by, brand/);
  const columns = insert.sql.match(/INSERT INTO medicines \(([^)]+)\)/)[1].split(",").map(value => value.trim());
  assert.equal(columns.length, new Set(columns).size);
  assert.equal(columns.length, insert.params.length);
  assert.equal(insert.params[21], "测试品牌");
  pool.always(/UPDATE medicines SET/, { rows: [medicineRow({ brand: "测试品牌" })] });
  await updateMedicine(pool, "medicine-1", "family-1", validateMedicineInput({ name: "旧客户端编辑" }).value, "user-1", 1);
  const update = pool.callsMatching(/UPDATE medicines SET/)[0];
  assert.match(update.sql, /brand = CASE WHEN \$24 THEN \$23 ELSE brand END/);
  assert.equal(update.params[23], false);
  await updateMedicine(pool, "medicine-1", "family-1", validateMedicineInput({ name: "清除品牌", brand: null }).value, "user-1", 1);
  assert.equal(pool.callsMatching(/UPDATE medicines SET/)[1].params[23], true);
});

test("brand survives household backup round trip", () => {
  const medicine = toMedicineSummary(medicineRow({ brand: "测试品牌", manufacturer: "测试厂家" }), []);
  const backup = createFamilyMedicineBackup("合成家庭", [medicine], { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null });
  assert.equal(backup.medicines[0].brand, "测试品牌");
  const result = validateFamilyMedicineBackup(backup);
  assert.equal(result.ok, true);
  assert.equal(result.value.medicines[0].brand, "测试品牌");
});
