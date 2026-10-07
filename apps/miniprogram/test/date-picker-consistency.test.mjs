import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function template(relative) {
  return fs.readFileSync(path.resolve(import.meta.dirname, "..", relative), "utf8");
}

test("medicine batch date fields use native date pickers instead of typed YYYY-MM-DD input", () => {
  const edit = template("pages/medicine-edit/medicine-edit.wxml");
  const batch = template("pages/batch-edit/batch-edit.wxml");

  assert.equal(edit.includes('placeholder="YYYY-MM-DD"'), false);
  assert.equal(batch.includes('placeholder="YYYY-MM-DD"'), false);

  const component = template("components/medicine-date-field/index.wxml");
  assert.match(component, /<picker mode="date"/);
  assert.match(component, /fields="\{\{pickerPrecision === 'month' \? 'month' : 'day'\}\}"/);
  for (const form of [edit, batch]) {
    assert.equal((form.match(/<medicine-date-field /g) ?? []).length, 3);
    for (const field of ["openedAt", "openingLimitValue"]) {
      assert.match(form, new RegExp(`<medicine-date-field [^>]*data-field="${field}"[^>]*bindchange="on(?:Batch)?FieldInput"`));
    }
    assert.match(form, /<medicine-date-field [^>]*allow-precision="\{\{true\}\}"/);
  }
});
