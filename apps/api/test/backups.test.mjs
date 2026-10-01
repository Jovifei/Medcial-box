import assert from "node:assert/strict";
import test from "node:test";

const module = await import("../dist/services/backup-snapshot.js").catch(() => null);

test("backup snapshot contains active fields but never tokens or personal dosage notes", () => {
  assert.ok(module, "backup snapshot service has not been implemented");
  const snapshot = module.createFamilyMedicineBackup(
    "测试家庭",
    [{
      id: "medicine-1", name: "测试药", specification: null, manufacturer: null, approvalNumber: null,
      barcodeValue: "6901234567890",
      activeIngredients: [], purposeCategory: null,
      leaflet: { purposeSummary: null, packageUsageSummary: null, contraindicationsSummary: null, precautionsSummary: null, source: "说明书", reviewStatus: "unverified" },
      lowStockThreshold: { quantity: 2, unit: "box" }, isArchived: false, version: 3,
      batches: [{ id: "batch-1", lotNumber: null, expiry: { value: null, precision: "unknown" }, expiryState: { state: "unknown", label: "未知" }, quantity: null, unit: "box", confirmedUnitsPerPackage: null, storageLocation: "药柜", openedState: "opened", openedAt: "2026-09-01", afterOpeningLimit: { date: "2026-10-01", source: "说明书" }, openedExpiryDate: "2026-10-01", managementExpiryDate: "2026-10-01", managementExpirySource: "opened", managementExpiryState: { state: "ok", label: "正常" }, dispositionStatus: "active", version: 4 }],
      privateDosage: "must not export",
    }],
    { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null },
    new Date("2026-09-29T00:00:00Z"),
  );
  assert.equal(snapshot.medicines.length, 1);
  assert.equal(snapshot.medicines[0].batches[0].afterOpeningLimit.date, "2026-10-01");
  assert.equal(snapshot.medicines[0].lowStockThreshold.quantity, 2);
  assert.equal(snapshot.medicines[0].barcodeValue, "6901234567890");
  assert.equal(JSON.stringify(snapshot).includes("must not export"), false);
  assert.equal("id" in snapshot.medicines[0], false);
  assert.equal("version" in snapshot.medicines[0], false);
});

test("backup validation rejects unsupported schema, missing names, and private fields", () => {
  assert.ok(module, "backup snapshot service has not been implemented");
  const validBase = {
    schemaVersion: 1,
    backupId: "e1d9b5aa-ea75-4f7e-a08c-0550f48f0c82",
    exportedAt: "2026-09-29T00:00:00.000Z",
    familyName: "来源家庭",
    inventorySettings: { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null },
    medicines: [{ name: "药", batches: [] }],
  };
  assert.equal(module.validateFamilyMedicineBackup(validBase).ok, true);
  // v1 与 v2 都可恢复；未知版本拒绝。
  assert.equal(module.validateFamilyMedicineBackup({ ...validBase, schemaVersion: 2 }).ok, true);
  assert.equal(module.validateFamilyMedicineBackup({ ...validBase, schemaVersion: 3 }).ok, false);
  assert.equal(module.validateFamilyMedicineBackup({ ...validBase, medicines: [{ name: "", batches: [] }] }).ok, false);
  assert.equal(module.validateFamilyMedicineBackup({ ...validBase, sessionToken: "secret" }).ok, false);
  assert.equal(module.validateFamilyMedicineBackup({ ...validBase, inventorySettings: { ...validBase.inventorySettings, lastStocktakeAt: "not-a-date" } }).ok, false);
  assert.equal(module.validateFamilyMedicineBackup({ ...validBase, inventorySettings: { ...validBase.inventorySettings, nextStocktakeAt: { value: "2026-09-29" } } }).ok, false);
  assert.equal(module.validateFamilyMedicineBackup({ ...validBase, inventorySettings: { ...validBase.inventorySettings, lastStocktakeAt: "2026-02-30T10:00:00.000Z" } }).ok, false);
});

test("backup confirmation digest is stable to key order and changes with imported content", () => {
  assert.ok(module, "backup snapshot service has not been implemented");
  const first = module.validateFamilyMedicineBackup({
    schemaVersion: 1,
    backupId: "e1d9b5aa-ea75-4f7e-a08c-0550f48f0c82",
    exportedAt: "2026-09-29T00:00:00.000Z",
    familyName: "来源家庭",
    inventorySettings: { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null },
    medicines: [{ name: "药", batches: [] }],
  });
  const same = module.validateFamilyMedicineBackup({
    medicines: [{ batches: [], name: "药" }],
    inventorySettings: { nextStocktakeAt: null, lastStocktakeAt: null, stocktakeInterval: "monthly" },
    familyName: "来源家庭",
    exportedAt: "2026-09-29T00:00:00.000Z",
    backupId: "e1d9b5aa-ea75-4f7e-a08c-0550f48f0c82",
    schemaVersion: 1,
  });
  const changed = module.validateFamilyMedicineBackup({
    schemaVersion: 1,
    backupId: "e1d9b5aa-ea75-4f7e-a08c-0550f48f0c82",
    exportedAt: "2026-09-29T00:00:00.000Z",
    familyName: "来源家庭",
    inventorySettings: { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null },
    medicines: [{ name: "另一种药", batches: [] }],
  });
  assert.equal(first.ok && same.ok && changed.ok, true);
  assert.equal(module.hashFamilyMedicineBackup(first.value), module.hashFamilyMedicineBackup(same.value));
  assert.notEqual(module.hashFamilyMedicineBackup(first.value), module.hashFamilyMedicineBackup(changed.value));
});

const roundTripMedicine = {
  id: "medicine-1",
  name: "往返保真药",
  specification: "10mg×12片",
  manufacturer: "测试制药",
  approvalNumber: "国药准字H12345678",
  barcodeValue: "6901234567890",
  activeIngredients: ["布洛芬", "淀粉"],
  purposeCategory: "解热镇痛",
  leaflet: {
    purposeSummary: "用于缓解轻至中度疼痛",
    packageUsageSummary: "口服，一次1片，一日2次",
    contraindicationsSummary: "对本品过敏者禁用",
    precautionsSummary: "避免与其他解热镇痛药同用",
    source: "药品包装拍照",
    reviewStatus: "user_confirmed",
  },
  lowStockThreshold: { quantity: 2, unit: "box" },
  isArchived: true,
  version: 7,
  batches: [
    {
      id: "b1", lotNumber: "L20260901", expiry: { value: "2027-12-31", precision: "day" },
      expiryState: { state: "ok", label: "正常" }, quantity: 5, unit: "box", confirmedUnitsPerPackage: 12,
      storageLocation: "客厅药箱", openedState: "opened", openedAt: "2026-09-01",
      afterOpeningLimit: { value: 1, unit: "month", source: "说明书" },
      openedExpiryDate: "2026-10-01", managementExpiryDate: "2026-10-01",
      managementExpirySource: "opened", managementExpiryState: { state: "ok", label: "正常" },
      dispositionStatus: "handled", version: 2,
    },
    {
      id: "b2", lotNumber: "L20260902", expiry: { value: "2028-03", precision: "month" },
      expiryState: { state: "ok", label: "正常" }, quantity: 3, unit: "box", confirmedUnitsPerPackage: null,
      storageLocation: "卧室药箱", openedState: "unopened", openedAt: null, afterOpeningLimit: null,
      openedExpiryDate: null, managementExpiryDate: "2028-03-31",
      managementExpirySource: "package", managementExpiryState: { state: "ok", label: "正常" },
      dispositionStatus: "active", version: 1,
    },
    {
      id: "b3", lotNumber: null, expiry: { value: null, precision: "unknown" },
      expiryState: { state: "unknown", label: "未知" }, quantity: null, unit: "other", confirmedUnitsPerPackage: null,
      storageLocation: "冰箱", openedState: "unknown", openedAt: null, afterOpeningLimit: null,
      openedExpiryDate: null, managementExpiryDate: null,
      managementExpirySource: null, managementExpiryState: { state: "unknown", label: "未知" },
      dispositionStatus: "active", version: 1,
    },
  ],
};

test("backup round-trip preserves expiry precision, full leaflet, source, disposition and archive state (A01/A02)", () => {
  assert.ok(module, "backup snapshot service has not been implemented");
  const snapshot = module.createFamilyMedicineBackup(
    "往返家庭",
    [roundTripMedicine],
    { stocktakeInterval: "weekly", lastStocktakeAt: null, nextStocktakeAt: null },
    new Date("2026-09-30T00:00:00Z"),
  );
  // 导出的外部格式必须携带处置状态，否则已处理库存恢复后复活为正常库存。
  assert.equal(snapshot.medicines[0].batches[0].dispositionStatus, "handled");
  assert.equal(snapshot.medicines[0].batches[1].dispositionStatus, "active");
  assert.equal(snapshot.medicines[0].isArchived, true);

  const validated = module.validateFamilyMedicineBackup(snapshot);
  assert.equal(validated.ok, true, JSON.stringify(validated.errors));
  const restored = validated.value.medicines[0];
  // 恢复路径直接消费内部已验证类型；以下字段正是二次解析时会静默丢失的。
  assert.equal(restored.name, "往返保真药");
  assert.equal(restored.specification, "10mg×12片");
  assert.equal(restored.manufacturer, "测试制药");
  assert.equal(restored.approvalNumber, "国药准字H12345678");
  assert.equal(restored.barcodeValue, "6901234567890");
  assert.deepEqual(restored.activeIngredients, ["布洛芬", "淀粉"]);
  assert.equal(restored.purposeCategory, "解热镇痛");
  assert.equal(restored.leafletPurposeSummary, "用于缓解轻至中度疼痛");
  assert.equal(restored.leafletPackageUsageSummary, "口服，一次1片，一日2次");
  assert.equal(restored.leafletContraindicationsSummary, "对本品过敏者禁用");
  assert.equal(restored.leafletPrecautionsSummary, "避免与其他解热镇痛药同用");
  assert.equal(restored.leafletSource, "药品包装拍照");
  assert.equal(restored.leafletReviewStatus, "user_confirmed");
  assert.deepEqual(restored.lowStockThreshold, { quantity: 2, unit: "box" });
  assert.equal(restored.isArchived, true);

  const [b1, b2, b3] = restored.batches;
  assert.equal(b1.expiryValue, "2027-12-31");
  assert.equal(b1.expiryPrecision, "day");
  assert.equal(b1.quantity, 5);
  assert.equal(b1.unit, "box");
  assert.equal(b1.confirmedUnitsPerPackage, 12);
  assert.equal(b1.storageLocation, "客厅药箱");
  assert.equal(b1.openedState, "opened");
  assert.equal(b1.openedAt, "2026-09-01");
  assert.deepEqual(b1.afterOpeningLimit, { value: 1, unit: "month", source: "说明书" });
  assert.equal(b1.dispositionStatus, "handled");
  assert.equal(b2.expiryValue, "2028-03");
  assert.equal(b2.expiryPrecision, "month");
  assert.equal(b2.lotNumber, "L20260902");
  assert.equal(b2.openedState, "unopened");
  assert.equal(b2.dispositionStatus, "active");
  assert.equal(b3.expiryValue, null);
  assert.equal(b3.expiryPrecision, "unknown");
  assert.equal(b3.quantity, null);
  assert.equal(b3.unit, "other");
  assert.equal(b3.openedState, "unknown");
  assert.equal(b3.dispositionStatus, "active");
});

test("legacy backups without disposition status validate as active with digest compatibility", () => {
  assert.ok(module, "backup snapshot service has not been implemented");
  const legacy = {
    schemaVersion: 1,
    backupId: "e1d9b5aa-ea75-4f7e-a08c-0550f48f0c82",
    exportedAt: "2026-09-29T00:00:00.000Z",
    familyName: "旧版家庭",
    inventorySettings: { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null },
    medicines: [{
      name: "旧版药",
      batches: [{ lotNumber: "L1", expiry: { value: "2027-06", precision: "month" }, quantity: 1, unit: "box" }],
    }],
  };
  const validated = module.validateFamilyMedicineBackup(legacy);
  assert.equal(validated.ok, true, JSON.stringify(validated.errors));
  assert.equal(validated.value.medicines[0].batches[0].dispositionStatus, "active");
});

test("backup validation rejects invalid disposition status values", () => {
  assert.ok(module, "backup snapshot service has not been implemented");
  const base = {
    schemaVersion: 1,
    backupId: "e1d9b5aa-ea75-4f7e-a08c-0550f48f0c82",
    exportedAt: "2026-09-29T00:00:00.000Z",
    familyName: "校验家庭",
    inventorySettings: { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null },
    medicines: [{
      name: "药",
      batches: [{ quantity: 1, unit: "box", dispositionStatus: "disposed" }],
    }],
  };
  assert.equal(module.validateFamilyMedicineBackup(base).ok, false);
});

test("confirmation digest changes when disposition status is edited after preview", () => {
  assert.ok(module, "backup snapshot service has not been implemented");
  const snapshot = module.createFamilyMedicineBackup(
    "往返家庭",
    [roundTripMedicine],
    { stocktakeInterval: "weekly", lastStocktakeAt: null, nextStocktakeAt: null },
    new Date("2026-09-30T00:00:00Z"),
  );
  const original = module.validateFamilyMedicineBackup(snapshot);
  assert.equal(original.ok, true);
  const tampered = module.validateFamilyMedicineBackup(structuredClone(snapshot));
  tampered.value.medicines[0].batches[0].dispositionStatus = "active";
  assert.notEqual(
    module.hashFamilyMedicineBackup(original.value),
    module.hashFamilyMedicineBackup(tampered.value),
    "editing handled state after preview must invalidate the confirmation token",
  );
});
