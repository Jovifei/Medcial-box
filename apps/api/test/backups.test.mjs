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
  assert.equal(module.validateFamilyMedicineBackup({ ...validBase, schemaVersion: 2 }).ok, false);
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
