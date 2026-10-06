import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { loadPage, makePageContext } from "./runtime.mjs";

function fixture(kind) {
  let definition;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../components/medicine-date-field/index.ts", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { Component: value => { definition = value; }, Date });
  const page = makePageContext(loadPage(`pages/${kind}-edit/${kind}-edit.ts`, { modules: {
    "../../services/api": { api: {}, ApiError: class extends Error {} },
    "../../services/auth": { ensureLoggedIn: async () => {} },
  } }).definition);
  const data = () => kind === "medicine" ? page.data.batches[0] : page.data;
  const component = { properties: { disabled: false, allowPrecision: true, clearable: true },
    triggerEvent(name, detail) { assert.equal(name, "change"); page.onExpiryDateChange({ currentTarget: { dataset: { index: "0" } }, detail }); },
  };
  function sync() { component.properties.value = data().expiryValue; component.properties.precision = ["day", "month", "unknown"][data().precisionIndex]; }
  function call(method, value) { sync(); definition.methods[method].call(component, { detail: { value } }); }
  function seed(value, index = 0) { data().expiryValue = value; data().precisionIndex = index; }
  return { page, data, component, call, seed };
}

for (const kind of ["batch", "medicine"]) {
  test(`${kind}: WXML binds the actual component to the tested date handler`, () => {
    const source = fs.readFileSync(new URL(`../pages/${kind}-edit/${kind}-edit.wxml`, import.meta.url), "utf8");
    assert.match(source, /<medicine-date-field[^>]*allow-precision[^>]*bindchange="onExpiryDateChange"/);
    assert.doesNotMatch(source, /bindchange="(?:onBatchPrecisionChange|onPrecisionChange)"/);
  });
  test(`${kind}: component day/month transitions retain month and require explicit day`, () => {
    const f = fixture(kind); f.seed("2028-02-29"); f.data().quantity = "7";
    f.call("onPrecisionChange", 0); assert.equal(f.data().expiryValue, "2028-02"); assert.equal(f.data().precisionIndex, 1);
    f.call("onPrecisionChange", 1); assert.equal(f.data().expiryValue, ""); assert.equal(f.data().precisionIndex, 0);
    f.call("onDateChange", "2028-02-29"); assert.equal(f.data().expiryValue, "2028-02-29"); assert.equal(f.data().quantity, "7");
    f.page.onExpiryDateChange({ currentTarget: { dataset: { index: "0" } }, detail: { value: "2028-02-29", precision: "unknown" } });
    assert.equal(f.data().expiryValue, ""); assert.equal(f.data().precisionIndex, 2);
    f.call("onPrecisionChange", 1); assert.equal(f.data().expiryValue, "");
  });
  test(`${kind}: impossible existing date is never repaired by a precision change`, () => {
    const f = fixture(kind); f.seed("2027-02-29"); f.call("onPrecisionChange", 0);
    assert.equal(f.data().expiryValue, "2027-02-29"); assert.equal(f.data().precisionIndex, 1);
    const before = JSON.stringify(f.page.data); f.call("onDateChange", "2027-02-29"); assert.equal(JSON.stringify(f.page.data), before);
  });
  test(`${kind}: invalid date and precision events preserve the whole form`, () => {
    const f = fixture(kind); f.seed("2028-02-29");
    for (const value of [99, -1, 0.5, "nonsense", "", " "]) {
      const before = JSON.stringify(f.page.data); f.call("onPrecisionChange", value); assert.equal(JSON.stringify(f.page.data), before);
    }
    for (const value of ["2027-02-29", "2028-13-01", "2028-02-30", "2028-02-invalid", "garbage"]) {
      const before = JSON.stringify(f.page.data); f.call("onDateChange", value); assert.equal(JSON.stringify(f.page.data), before);
    }
    const before = JSON.stringify(f.page.data);
    f.page.onExpiryDateChange({ currentTarget: { dataset: { index: "0" } }, detail: { value: "2028-02", precision: "invalid" } });
    assert.equal(JSON.stringify(f.page.data), before);
  });
  test(`${kind}: disabled component cannot clear, change precision or select a date`, () => {
    const f = fixture(kind); f.seed("2028-02-29"); f.component.properties.disabled = true;
    const before = JSON.stringify(f.page.data);
    for (const method of ["onClear", "onPrecisionChange", "onDateChange"]) f.call(method, method === "onDateChange" ? "2029-01-01" : 0);
    assert.equal(JSON.stringify(f.page.data), before);
  });
}
test("medicine: malformed batch identity preserves full form and touched state", () => {
  const f = fixture("medicine"); f.seed("2028-02-29");
  const before = JSON.stringify(f.page.data);
  for (const index of ["-1", "99", "0.5", "garbage"]) f.page.onExpiryDateChange({ currentTarget: { dataset: { index } }, detail: { value: "2028-02", precision: "month" } });
  assert.equal(JSON.stringify(f.page.data), before);
});
