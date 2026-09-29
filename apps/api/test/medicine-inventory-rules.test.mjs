import assert from "node:assert/strict";
import test from "node:test";

const rules = await import("../dist/domain/medicine-inventory.js").catch(() => null);

test("opening shelf life uses calendar arithmetic and clamps month end", () => {
  assert.equal(typeof rules?.calculateOpenedExpiryDate, "function");
  assert.equal(
    rules.calculateOpenedExpiryDate("2026-01-31", { value: 1, unit: "month" }),
    "2026-02-28",
  );
  assert.equal(
    rules.calculateOpenedExpiryDate("2028-01-31", { value: 1, unit: "month" }),
    "2028-02-29",
  );
  assert.equal(
    rules.calculateOpenedExpiryDate("2026-12-31", { value: 30, unit: "day" }),
    "2027-01-30",
  );
  assert.equal(rules.calculateOpenedExpiryDate(null, { date: "2026-11-30" }), "2026-11-30");
});

test("effective medicine deadline is the earlier known package or opening deadline", () => {
  assert.equal(typeof rules?.calculateEffectiveExpiryDate, "function");
  assert.deepEqual(
    rules.calculateEffectiveExpiryDate(
      { value: "2026-10", precision: "month" },
      "2026-11-15",
    ),
    { date: "2026-10-31", source: "package" },
  );
  assert.deepEqual(
    rules.calculateEffectiveExpiryDate(
      { value: "2027-03", precision: "month" },
      "2026-10-12",
    ),
    { date: "2026-10-12", source: "opened" },
  );
  assert.deepEqual(
    rules.calculateEffectiveExpiryDate(
      { value: null, precision: "unknown" },
      "2026-10-12",
    ),
    { date: "2026-10-12", source: "opened" },
  );
});

test("low stock sums only known, unexpired compatible batches and uses an inclusive threshold", () => {
  assert.equal(typeof rules?.calculateStockStatus, "function");
  const batches = [
    { quantity: 2, unit: "box", confirmedUnitsPerPackage: null, managementExpiryDate: "2027-01-01" },
    { quantity: 1, unit: "box", confirmedUnitsPerPackage: null, managementExpiryDate: "2027-01-01" },
    { quantity: 9, unit: "box", confirmedUnitsPerPackage: null, managementExpiryDate: "2026-01-01" },
  ];
  assert.deepEqual(
    rules.calculateStockStatus(batches, { quantity: 3, unit: "box" }, new Date("2026-09-28T04:00:00Z")),
    { state: "low", quantity: 3, unit: "box" },
  );
  assert.deepEqual(
    rules.calculateStockStatus(
      [{ quantity: 1, unit: "box", confirmedUnitsPerPackage: 12, managementExpiryDate: "2027-01-01" }],
      { quantity: 12, unit: "tablet" },
      new Date("2026-09-28T04:00:00Z"),
    ),
    { state: "low", quantity: 12, unit: "tablet" },
  );
  assert.deepEqual(
    rules.calculateStockStatus(
      [{ quantity: null, unit: "box", confirmedUnitsPerPackage: null, managementExpiryDate: null }],
      { quantity: 1, unit: "box" },
      new Date("2026-09-28T04:00:00Z"),
    ),
    { state: "unknown", quantity: null, unit: "box" },
  );
});
