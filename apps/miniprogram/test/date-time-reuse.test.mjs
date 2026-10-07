import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { loadPage, makePageContext } from "./runtime.mjs";

function component(name) {
  let definition;
  const source = fs.readFileSync(new URL(`../components/${name}/index.ts`, import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { Component(value) { definition = value; }, Date });
  return definition;
}
test("time picker rejects invalid values and cannot change while disabled", () => {
  const def = component("medicine-time-field");
  const context = { properties: { disabled: false }, triggerEvent(name, detail) { this.event = { name, detail }; } };
  for (const value of ["24:00", "12:60", "8:00", ""]) def.methods.onTimeChange.call(context, { detail: { value } });
  assert.equal(context.event, undefined);
  def.methods.onTimeChange.call(context, { detail: { value: "23:59" } });
  assert.equal(context.event.detail.value, "23:59");
  context.properties.disabled = true;
  def.methods.onTimeChange.call(context, { detail: { value: "08:00" } });
  assert.equal(context.event.detail.value, "23:59");
});
test("expiry month precision never invents a day", () => {
  const def = component("medicine-date-field");
  const context = { properties: { disabled: false, allowPrecision: true, precision: "unknown", value: "" }, triggerEvent(name, detail) { this.event = { name, detail }; } };
  def.methods.onDateChange.call(context, { detail: { value: "2028-02-29" } });
  assert.deepEqual({ ...context.event.detail }, { value: "2028-02", precision: "month" });
  context.properties.value = "2028-02";
  context.properties.precision = "month";
  def.methods.onPrecisionChange.call(context, { detail: { value: 1 } });
  assert.deepEqual({ ...context.event.detail }, { value: "", precision: "day" });
});
for (const name of ["plan-create", "plan-detail"]) {
  test(`${name} edits existing slots, rejects duplicates and preserves pending saves`, () => {
    const { definition } = loadPage(`pages/${name}/${name}.ts`, { modules: { "../../services/api": { api: {}, ApiError: class extends Error {} }, "../../services/auth": {} } });
    const page = makePageContext(definition);
    page.updateDirtyState = () => {};
    page.data.timeSlots = ["08:00", "20:00"];
    page.onTimeSlotChange({ currentTarget: { dataset: { time: "08:00" } }, detail: { value: "09:30" } });
    assert.deepEqual(Array.from(page.data.timeSlots), ["09:30", "20:00"]);
    page.onTimeSlotChange({ currentTarget: { dataset: { time: "09:30" } }, detail: { value: "20:00" } });
    assert.deepEqual(Array.from(page.data.timeSlots), ["09:30", "20:00"]);
    page.data[name === "plan-create" ? "pendingCreation" : "saving"] = true;
    page.onTimeSlotChange({ currentTarget: { dataset: { time: "09:30" } }, detail: { value: "10:30" } });
    page.onRemoveTimeSlot({ currentTarget: { dataset: { time: "09:30" } } });
    assert.deepEqual(Array.from(page.data.timeSlots), ["09:30", "20:00"]);
  });
}
