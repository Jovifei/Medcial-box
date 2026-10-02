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

test("decimal ml quantities are summed exactly and never mistaken for unknown (B03)", () => {
  const now = new Date("2026-10-02T04:00:00Z");
  const batch = (quantity, unit = "ml") => ({
    quantity, unit, confirmedUnitsPerPackage: null, managementExpiryDate: "2027-01-01",
  });
  // 5.5ml 阈值 10ml → low（此前 isSafeInteger 判 unknown）
  assert.deepEqual(
    rules.calculateStockStatus([batch(5.5)], { quantity: 10, unit: "ml" }, now),
    { state: "low", quantity: 5.5, unit: "ml" },
  );
  // 0.1 + 0.2 定点累加 = 0.3，不留浮点误差
  assert.deepEqual(
    rules.calculateStockStatus([batch(0.1), batch(0.2)], { quantity: 0.3, unit: "ml" }, now),
    { state: "low", quantity: 0.3, unit: "ml" },
  );
  // 1.5 + 1.5 = 3.0，等阈值含边界
  assert.deepEqual(
    rules.calculateStockStatus([batch(1.5), batch(1.5)], { quantity: 3, unit: "ml" }, now),
    { state: "low", quantity: 3, unit: "ml" },
  );
  // 已知零 → exhausted（不是 unknown，也不是 ok）
  assert.deepEqual(
    rules.calculateStockStatus([batch(0)], { quantity: 1, unit: "ml" }, now),
    { state: "exhausted", quantity: 0, unit: "ml" },
  );
  // 未知批次与已知混合 → 仍 unknown
  assert.deepEqual(
    rules.calculateStockStatus([batch(5.5), { quantity: null, unit: "ml", confirmedUnitsPerPackage: null, managementExpiryDate: null }], { quantity: 10, unit: "ml" }, now),
    { state: "unknown", quantity: null, unit: "ml" },
  );
});
