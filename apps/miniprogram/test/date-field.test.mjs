import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { loadPage, makePageContext } from "./runtime.mjs";

function component() {
  const source = fs.readFileSync(new URL("../components/medicine-date-field/index.ts", import.meta.url), "utf8");
  let definition;
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
    { Component(value) { definition = value; }, Date });
  return definition;
}
test("date component shows Chinese but emits ISO, retaining month precision", () => {
  const def = component();
  const context = { properties:{precision:"day",disabled:false},setData(value){this.data=value;},triggerEvent(name,detail){this.event={name,detail};} };
  def.observers["value, precision"].call(context,"2028-02-29","day");
  assert.equal(context.data.displayValue,"2028年2月29日");
  def.methods.onDateChange.call(context,{detail:{value:"2028-02-29"}});
  assert.equal(context.event.detail.value,"2028-02-29");
  context.properties.precision="month";
  def.observers["value, precision"].call(context,"2028-02","month");
  assert.equal(context.data.displayValue,"2028年2月");
  def.methods.onDateChange.call(context,{detail:{value:"2028-02-29"}});
  assert.equal(context.event.detail.value,"2028-02");
});
test("invalid or disabled selection cannot change date, empty value remains empty", () => {
  const def=component();
  const context={properties:{precision:"day",disabled:false},setData(value){this.data=value;},triggerEvent(){throw Error("unexpected event");}};
  def.observers["value, precision"].call(context,"","day");
  assert.equal(context.data.displayValue,"");
  def.methods.onDateChange.call(context,{detail:{value:"2027-02-29"}});
  context.properties.disabled=true;
  def.methods.onDateChange.call(context,{detail:{value:"2028-02-29"}});
});
test("optional date clear emits empty value and respects the disabled form", () => {
  const def = component();
  const context = { properties: { clearable: true, disabled: false, precision: "month" }, triggerEvent(name, detail) { this.event = { name, detail }; } };
  def.methods.onClear.call(context);
  assert.equal(context.event.detail.value, "");
  assert.equal(context.event.detail.precision, "month");
  context.event = null;
  context.properties.disabled = true;
  def.methods.onClear.call(context);
  assert.equal(context.event, null);
});
test("batch date event uses existing field bridge and precision does not invent day", () => {
  const {definition}=loadPage("pages/batch-edit/batch-edit.ts",{modules:{"../../services/api":{api:{},ApiError:class extends Error{}},"../../services/auth":{}}});
  const page=makePageContext(definition);
  page.onFieldInput({currentTarget:{dataset:{field:"openedAt"}},detail:{value:"2028-02-29"}});
  assert.equal(page.data.openedAt,"2028-02-29");
  page.data.expiryValue="2028-02-29";
  page.onPrecisionChange({detail:{value:1}});
  assert.equal(page.data.expiryValue,"2028-02");
  page.onPrecisionChange({detail:{value:0}});
  assert.equal(page.data.expiryValue,"");
});
test("both forms route all three date fields through one component", () => {
  for(const page of ["batch-edit","medicine-edit"]){
    const markup=fs.readFileSync(new URL(`../pages/${page}/${page}.wxml`,import.meta.url),"utf8");
    assert.equal((markup.match(/<medicine-date-field /g)||[]).length,3);
    assert.match(markup, /<medicine-date-field [^>]*allow-precision="\{\{true\}\}"[^>]*bindchange="onExpiryDateChange"/);
    for(const field of ["openedAt","openingLimitValue"]){
      assert.match(markup,new RegExp(`<medicine-date-field [^>]*data-field="${field}"[^>]*bindchange="on(?:Batch)?FieldInput"`));
    }
    if(page==="medicine-edit") assert.equal((markup.match(/<medicine-date-field [^>]*data-index="\{\{index\}\}"/g)||[]).length,3);
  }
});
