import assert from "node:assert/strict";
import test from "node:test";

const inputs = await import("../dist/inputs.js");

test("batch validation defaults opening state to unknown and accepts a confirmed opening limit", () => {
  const plain = inputs.validateBatchInput({ quantity: 2, unit: "bottle" });
  assert.equal(plain.ok, true);
  assert.equal(plain.value.openedState, "unknown");
  assert.equal(plain.value.openedAt, null);
  assert.equal(plain.value.afterOpeningLimit, null);

  const opened = inputs.validateBatchInput({
    openedState: "opened",
    openedAt: "2026-09-28",
    afterOpeningLimit: { value: 1, unit: "month", source: "包装说明" },
  });
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.value.afterOpeningLimit, {
    value: 1,
    unit: "month",
    source: "包装说明",
  });
  assert.deepEqual(
    inputs.validateBatchInput({
      openedState: "opened",
      afterOpeningLimit: { date: "2026-10-31", source: "说明书" },
    }).value.afterOpeningLimit,
    { date: "2026-10-31", source: "说明书" },
  );
});

test("tube is a count unit for batches, thresholds, and restock requests", () => {
  const batch = inputs.validateBatchInput({ quantity: 2, unit: "tube" });
  assert.equal(batch.ok, true);
  assert.equal(batch.value.quantity, 2);
  assert.equal(batch.value.unit, "tube");
  assert.equal(inputs.validateBatchInput({ quantity: 2.5, unit: "tube" }).ok, false);
  assert.equal(inputs.validateMedicineInput({ name: "测试药", lowStockThreshold: { quantity: 2, unit: "tube" } }).ok, true);
  assert.equal(inputs.validateRestockInput({ medicineId: "m-1", unit: "tube", desiredQuantity: 2 }).ok, true);
});

test("batch validation rejects impossible dates and opening metadata on unopened stock", () => {
  assert.equal(inputs.validateBatchInput({ openedState: "opened", openedAt: "2026-02-31" }).ok, false);
  assert.equal(inputs.validateBatchInput({ openedState: "unopened", openedAt: "2026-09-28" }).ok, false);
  assert.equal(inputs.validateBatchInput({ openedState: "opened", afterOpeningLimit: { value: 0, unit: "day" } }).ok, false);
  assert.equal(inputs.validateBatchInput({ quantity: 2_147_483_648 }).ok, false);
  assert.equal(inputs.validateBatchInput({ openedState: "opened", afterOpeningLimit: { value: 1, unit: "week" } }).ok, false);
});

test("batch split requires explicit confirmation, a known split count and a valid opening date", () => {
  assert.equal(typeof inputs.validateBatchSplitInput, "function");
  const good = inputs.validateBatchSplitInput({
    confirmed: true,
    version: 4,
    openedQuantity: 1,
    openedAt: "2026-09-29",
    afterOpeningLimit: { value: 30, unit: "day", source: "说明书" },
  });
  assert.equal(good.ok, true);
  assert.equal(inputs.validateBatchSplitInput({ ...good.value, confirmed: false }).ok, false);
  assert.equal(inputs.validateBatchSplitInput({ version: 4, openedQuantity: 0, openedAt: "2026-09-29", confirmed: true }).ok, false);
  assert.equal(inputs.validateBatchSplitInput({ version: 4, openedQuantity: 1, openedAt: "2026-02-31", confirmed: true }).ok, false);
});

test("medicine validation treats a missing low-stock threshold as disabled and validates configured units", () => {
  const disabled = inputs.validateMedicineInput({ name: "测试药" });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.value.lowStockThreshold, null);
  assert.deepEqual(
    inputs.validateMedicineInput({ name: "测试药", lowStockThreshold: { quantity: 0, unit: "box" } }).value.lowStockThreshold,
    { quantity: 0, unit: "box" },
  );
  assert.equal(inputs.validateMedicineInput({ name: "测试药", lowStockThreshold: { quantity: -1, unit: "box" } }).ok, false);
  assert.equal(inputs.validateMedicineInput({ name: "测试药", lowStockThreshold: { quantity: 1, unit: "crate" } }).ok, false);
  assert.equal(inputs.validateMedicineInput({ name: "测试药", lowStockThreshold: { quantity: 1 } }).ok, false);
  assert.equal(inputs.validateMedicineUpdateInput({ name: "测试药", version: 1 }).value.lowStockThresholdProvided, false);
  assert.equal(inputs.validateMedicineUpdateInput({ name: "测试药", version: 1, lowStockThreshold: null }).value.lowStockThresholdProvided, true);
});

test("medicine validation preserves a bounded optional barcode without requiring it", () => {
  const absent = inputs.validateMedicineInput({ name: "测试药" });
  assert.equal(absent.ok, true);
  assert.equal(absent.value.barcodeValue, null);
  const scanned = inputs.validateMedicineInput({ name: "测试药", barcodeValue: "6901234567890" });
  assert.equal(scanned.ok, true);
  assert.equal(scanned.value.barcodeValue, "6901234567890");
  assert.equal(inputs.validateMedicineInput({ name: "测试药", barcodeValue: "x".repeat(161) }).ok, false);
});

test("stocktake and restock validators reject malformed or cross-family payload shapes", () => {
  assert.equal(typeof inputs.validateStocktakeItemsInput, "function");
  assert.equal(typeof inputs.validateFamilyInventorySettingsInput, "function");
  assert.equal(typeof inputs.validateRestockInput, "function");

  assert.equal(inputs.validateStocktakeItemsInput({ items: [{ batchId: "b-1", version: 1, outcome: "adjusted", quantity: 0 }] }).ok, true);
  assert.equal(inputs.validateStocktakeItemsInput({ items: [{ batchId: "b-1", version: 1, outcome: "adjusted" }] }).ok, false);
  assert.equal(inputs.validateStocktakeItemsInput({ items: [{ batchId: "b-1", version: 1, outcome: "handled", quantity: 2 }] }).ok, false);
  assert.equal(inputs.validateFamilyInventorySettingsInput({ stocktakeInterval: "monthly" }).ok, true);
  assert.equal(inputs.validateFamilyInventorySettingsInput({ stocktakeInterval: "daily" }).ok, false);
  assert.equal(inputs.validateRestockInput({ medicineId: "m-1", unit: "box", desiredQuantity: 2 }).ok, true);
  assert.equal(inputs.validateRestockInput({ medicineId: "m-1", unit: "crate", desiredQuantity: 2 }).ok, false);
});
