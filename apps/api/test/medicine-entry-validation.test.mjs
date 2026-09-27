import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../../miniprogram/pages/medicine-edit/medicine-edit.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(`${source}\nexport { buildBatchPayloads };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, {
  exports,
  require: () => ({}),
  Page: () => {},
});
const { buildBatchPayloads } = exports;

function batch(overrides = {}) {
  return {
    id: null, version: null, lotNumber: "", expiryValue: "", precisionIndex: 2,
    quantity: "", quantityUnknown: true, unitIndex: 4, confirmedUnits: "", storageLocation: "",
    ...overrides,
  };
}

test("quick entry keeps unknown stock and date distinct from confirmed zero", () => {
  const unknown = buildBatchPayloads([batch()]);
  assert.equal(unknown.error, null);
  assert.equal(unknown.payloads[0].quantity, null);
  assert.equal(unknown.payloads[0].expiry, null);

  const empty = buildBatchPayloads([batch({ quantityUnknown: false, quantity: "0" })]);
  assert.equal(empty.error, null);
  assert.equal(empty.payloads[0].quantity, 0);
});

test("stock and package conversion reject fractional or trailing input", () => {
  for (const quantity of ["2.5", "2x", "9007199254740992"]) {
    assert.notEqual(buildBatchPayloads([batch({ quantityUnknown: false, quantity })]).error, null);
  }
  for (const confirmedUnits of ["24x", "1.5", "0"]) {
    assert.notEqual(buildBatchPayloads([batch({ confirmedUnits })]).error, null);
  }
});

test("expiry rejects impossible days and months without inventing a day", () => {
  assert.notEqual(buildBatchPayloads([batch({ precisionIndex: 0, expiryValue: "2027-02-31" })]).error, null);
  assert.notEqual(buildBatchPayloads([batch({ precisionIndex: 1, expiryValue: "2027-13" })]).error, null);
  const leap = buildBatchPayloads([batch({ precisionIndex: 0, expiryValue: "2028-02-29" })]);
  assert.equal(leap.error, null);
  const month = buildBatchPayloads([batch({ precisionIndex: 1, expiryValue: "2027-12" })]);
  assert.equal(month.error, null);
  assert.equal(month.payloads[0].expiry.precision, "month");
  assert.equal(month.payloads[0].expiry.value, "2027-12");
});
