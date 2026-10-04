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

  assert.match(edit, /mode="date"[^>]*data-field="openedAt"[^>]*bindchange="onBatchDateChange"/);
  assert.match(edit, /mode="date"[^>]*data-field="openingLimitValue"[^>]*bindchange="onBatchDateChange"/);

  assert.match(batch, /mode="date"[^>]*bindchange="onExpiryDateChange"/);
  assert.match(batch, /mode="date"[^>]*data-field="openedAt"[^>]*bindchange="onDateFieldChange"/);
  assert.match(batch, /mode="date"[^>]*data-field="openingLimitValue"[^>]*bindchange="onDateFieldChange"/);
});
