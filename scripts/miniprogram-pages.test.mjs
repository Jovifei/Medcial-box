import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

async function readProjectFile(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

async function loadTypeScriptModule(relativePath) {
  const source = await readProjectFile(relativePath);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: relativePath,
  }).outputText;
  const module = { exports: {} };
  const run = new Function("require", "module", "exports", output);
  run(require, module, module.exports);
  return module.exports;
}

test("mini-program input validation rejects truncated numbers and impossible dates", async () => {
  const validation = await loadTypeScriptModule("apps/miniprogram/services/input-validation.ts");

  assert.equal(validation.isStrictNonNegativeInteger("0"), true);
  assert.equal(validation.isStrictNonNegativeInteger("12"), true);
  assert.equal(validation.isStrictNonNegativeInteger("12abc"), false);
  assert.equal(validation.isStrictNonNegativeInteger("1.5"), false);
  assert.equal(validation.isStrictNonNegativeInteger("2e3"), false);
  assert.equal(validation.isStrictNonNegativeInteger("9007199254740992"), false);

  assert.equal(validation.isStrictPositiveInteger("1"), true);
  assert.equal(validation.isStrictPositiveInteger("0"), false);
  assert.equal(validation.isStrictPositiveInteger("24abc"), false);

  assert.equal(validation.isValidExpiryValue("2028-02-29", "day"), true);
  assert.equal(validation.isValidExpiryValue("2027-02-29", "day"), false);
  assert.equal(validation.isValidExpiryValue("2027-04-31", "day"), false);
  assert.equal(validation.isValidExpiryValue("2027-13-01", "day"), false);
  assert.equal(validation.isValidExpiryValue("2027-02", "month"), true);
  assert.equal(validation.isValidExpiryValue("2027-13", "month"), false);
  assert.equal(validation.isValidExpiryValue("", "unknown"), true);
});

test("invite and medicine edit pages keep the guarded flows in source", async () => {
  const invite = await readProjectFile("apps/miniprogram/pages/invite/invite.ts");
  assert.match(invite, /api\.previewInvitation\(code\)/);
  assert.match(invite, /data\.preview === null \|\| data\.preview\.code !== code/);
  assert.match(invite, /const confirmed = await confirmModal\(/);
  assert.equal(invite.includes('        invitationCode: "",\n        nickname:'), false);

  const medicineEdit = await readProjectFile("apps/miniprogram/pages/medicine-edit/medicine-edit.ts");
  assert.match(medicineEdit, /medicineLoadPromise = this\.loadMedicine\(options\.id\)/);
  assert.match(medicineEdit, /if \(this\.medicineLoadPromise !== null\) await this\.medicineLoadPromise;/);

  const api = await readProjectFile("apps/miniprogram/services/api.ts");
  assert.match(api, /path: "\/api\/v1\/users\/me\/nickname"/);
  assert.match(api, /updateProfile[\s\S]*?method: "POST"/);
});
