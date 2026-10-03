import assert from "node:assert/strict";
import test from "node:test";
import { validateBatchInput } from "../dist/inputs.js";
import { calculateStockStatus } from "../dist/domain/medicine-inventory.js";
import { toBatchSummary } from "../dist/repositories/batches.js";

const now = new Date("2026-10-02T04:00:00Z");
const batch = (unit, quantity, ratio, target) => ({ unit, quantity,
  confirmedUnitsPerPackage: ratio, conversionUnit: target,
  managementExpiryDate: "2099-12-31", dispositionStatus: "active" });

test("a confirmed blister-to-tablet relation counts intact packs without guessing", () => {
  assert.deepEqual(calculateStockStatus([batch("blister", 2, 10, "tablet")],
    { quantity: 20, unit: "tablet" }, now), { state: "low", quantity: 20, unit: "tablet" });
  assert.equal(calculateStockStatus([batch("blister", 2, null, "tablet")],
    { quantity: 20, unit: "tablet" }, now).state, "unknown");
});

test("bottle-to-ml ratios accept target precision; pill quantities cannot convert to ml", () => {
  const parsed = validateBatchInput({ unit: "bottle", quantity: 2,
    confirmedUnitsPerPackage: 12.5, conversionUnit: "ml" });
  assert.equal(parsed.ok, true, parsed.message);
  assert.equal(parsed.value.conversionUnit, "ml");
  assert.equal(parsed.value.confirmedUnitsPerPackage, 12.5);
  assert.deepEqual(calculateStockStatus([batch("bottle", 2, 12.5, "ml")],
    { quantity: 25, unit: "ml" }, now), { state: "low", quantity: 25, unit: "ml" });
  assert.equal(validateBatchInput({ unit: "tablet", quantity: 2,
    confirmedUnitsPerPackage: 5, conversionUnit: "ml" }).ok, false);
});

test("conversion targets survive database decoding and do not apply to another unit", () => {
  const row = { id: "batch", medicine_id: "medicine", lot_number: null, expiry_value: null,
    expiry_precision: "unknown", quantity: "2.000", unit: "box", confirmed_units_per_package: "12.000",
    conversion_unit: "capsule", storage_location: null, opened_state: "unopened", opened_at: null,
    after_opening_limit: null, disposition_status: "active", deleted_at: null, version: 1 };
  assert.equal(toBatchSummary(row, now).conversionUnit, "capsule");
  assert.equal(calculateStockStatus([batch("box", 2, 12, "capsule")],
    { quantity: 24, unit: "tablet" }, now).state, "unknown");
  // Existing explicitly confirmed box→tablet rows keep their historical meaning.
  assert.equal(calculateStockStatus([batch("box", 2, 12, null)],
    { quantity: 24, unit: "tablet" }, now).quantity, 24);
});
