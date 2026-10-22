import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function loadBarcodeParser() {
  const source = fs.readFileSync(new URL("../services/barcode-parser.ts", import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const module = { exports };
  vm.runInNewContext(transpiled, { module, exports, require: () => ({}) });
  return module.exports;
}

const { parseMedicineBarcode, UNSUPPORTED_CATALOG_CODE } = loadBarcodeParser();

test("standard barcodes (8-14 digits) are accepted as-is", () => {
  for (const code of ["12345678", "6901848010014", "12345678901234"]) {
    const res = parseMedicineBarcode(code);
    assert.equal(res.raw, code);
    assert.equal(res.queryBarcode, code);
    assert.equal(res.kind, "standard");
    assert.match(res.statusText, new RegExp(code));
  }
});

test("20-digit Chinese drug code embedding 69 barcode extracts 13 digits", () => {
  const userCode = "81093690127825858280";
  const res = parseMedicineBarcode(userCode);
  assert.equal(res.raw, userCode);
  assert.equal(res.queryBarcode, "6901278258582");
  assert.equal(res.kind, "extracted_69");
  assert.match(res.statusText, /截取有效商品码 6901278258582/);
});

test("20-digit code without 69 barcode remains unsupported but preserves raw", () => {
  const code = "12345678901234567890";
  const res = parseMedicineBarcode(code);
  assert.equal(res.raw, code);
  assert.equal(res.queryBarcode, null);
  assert.equal(res.kind, "traceability_unextracted");
  assert.equal(res.statusText, UNSUPPORTED_CATALOG_CODE);
});

test("GS1 composite code with AI parentheses extracts GTIN, lot and expiry", () => {
  const gs1 = "(01)06901848010014(17)261231(10)LOT2024A";
  const res = parseMedicineBarcode(gs1);
  assert.equal(res.raw, gs1);
  assert.equal(res.queryBarcode, "6901848010014");
  assert.equal(res.kind, "gs1");
  assert.equal(res.extractedLotNumber, "LOT2024A");
  assert.equal(res.extractedExpiry?.value, "2026-12-31");
  assert.equal(res.extractedExpiry?.precision, "day");
});

test("GS1 composite code with continuous format (no parentheses)", () => {
  const gs1 = "01069222485000101725080010BATCH99";
  const res = parseMedicineBarcode(gs1);
  assert.equal(res.queryBarcode, "6922248500010");
  assert.equal(res.kind, "gs1");
  assert.equal(res.extractedLotNumber, "BATCH99");
  assert.equal(res.extractedExpiry?.value, "2025-08");
  assert.equal(res.extractedExpiry?.precision, "month");
});

test("AIM scanner symbology prefix (]C1, ]d2) is stripped cleanly", () => {
  const code = "]C10106901848010014";
  const res = parseMedicineBarcode(code);
  assert.equal(res.queryBarcode, "6901848010014");
});

test("empty, URL, and non-numeric strings are rejected gracefully", () => {
  for (const invalid of ["", "   ", "https://synthetic.invalid/trace/123", "ABC-CODE"]) {
    const res = parseMedicineBarcode(invalid);
    assert.equal(res.queryBarcode, null);
    if (invalid.trim() === "") {
      assert.match(res.statusText, /没有读到条码/);
    } else {
      assert.equal(res.statusText, UNSUPPORTED_CATALOG_CODE);
    }
  }
});
