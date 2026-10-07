import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, loadService, makePageContext } from "./runtime.mjs";

const modules = {
  "../../services/api": { api: {}, ApiError: class ApiError extends Error {} },
  "../../services/auth": { ensureLoggedIn: async () => {} },
};
const validation = loadService("services/input-validation.ts");
test("expiry precision never invents a day or silently repairs an impossible date", () => {
  assert.equal(validation.expiryValueForPrecision("2028-02-29", "month"), "2028-02");
  assert.equal(validation.expiryValueForPrecision("2028-02", "day"), "");
  assert.equal(validation.expiryValueForPrecision("2028-02-29", "unknown"), "");
  assert.equal(validation.expiryValueForPrecision("2027-02-29", "month"), "2027-02-29");
  assert.equal(validation.expiryValueForPrecision("2028-02-29", "day"), "2028-02-29");
});

for (const kind of ["batch", "medicine"]) {
  const make = () => {
    const name = kind === "batch" ? "batch-edit" : "medicine-edit";
    const page = makePageContext(loadPage(`pages/${name}/${name}.ts`, { modules }).definition);
    return {
      page,
      get data() { return kind === "batch" ? page.data : page.data.batches[0]; },
      precision(value) {
        const event = { currentTarget: { dataset: { index: "0" } }, detail: { value } };
        if (kind === "batch") page.onPrecisionChange(event);
        else page.onBatchPrecisionChange(event);
      },
      opening(value) { page.onOpeningLimitModeChange({ currentTarget: { dataset: { index: "0" } }, detail: { value } }); },
    };
  };
  test(`${kind}: day to month keeps month; month to day clears without inventing expiry`, () => {
    const context = make();
    context.data.expiryValue = "2028-02-29";
    context.precision(1);
    assert.equal(context.data.expiryValue, "2028-02");
    context.precision(0);
    assert.equal(context.data.expiryValue, "");
    context.data.expiryValue = "2028-02-29";
    context.precision(2);
    assert.equal(context.data.expiryValue, "");
    context.precision(0);
    assert.equal(context.data.expiryValue, "");
  });
  test(`${kind}: switching opening-limit units never reinterprets the old number`, () => {
    const context = make();
    Object.assign(context.data, { openingLimitMode: "day", openingLimitModeIndex: 1, openingLimitValue: "7" });
    context.opening(1);
    assert.equal(context.data.openingLimitValue, "7");
    context.opening(2);
    assert.equal(context.data.openingLimitValue, "");
    context.data.openingLimitValue = "2";
    context.opening(3);
    assert.equal(context.data.openingLimitValue, "");
    context.data.openingLimitValue = "2028-02-29";
    context.opening(1);
    assert.equal(context.data.openingLimitValue, "");
    context.data.openingLimitValue = "7";
    context.opening(0);
    assert.equal(context.data.openingLimitValue, "");
  });
  test(`${kind}: invalid precision events leave the form unchanged`, () => {
    const context = make();
    context.data.expiryValue = "2028-02-29";
    const before = JSON.stringify(context.data);
    context.precision(99);
    assert.equal(JSON.stringify(context.data), before);
    context.opening(99);
    assert.equal(JSON.stringify(context.data), before);
  });
}
