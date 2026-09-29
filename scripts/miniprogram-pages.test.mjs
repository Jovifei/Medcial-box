import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { loadPage, makePageContext } from "../apps/miniprogram/test/runtime.mjs";

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

test("invite and mini-program API use guarded request flows", async () => {
  const invite = await readProjectFile("apps/miniprogram/pages/invite/invite.ts");
  assert.match(invite, /api\.previewInvitation\(code\)/);
  assert.match(invite, /data\.preview === null \|\| data\.preview\.code !== code/);
  assert.match(invite, /const confirmed = await confirmModal\(/);
  assert.equal(invite.includes('        invitationCode: "",\n        nickname:'), false);

  const api = await readProjectFile("apps/miniprogram/services/api.ts");
  assert.match(api, /path: "\/api\/v1\/users\/me\/nickname"/);
  assert.match(api, /updateProfile[\s\S]*?method: "POST"/);
});

test("editing waits for the existing medicine load before sending a save", async () => {
  let resolveMedicine;
  const medicineLoad = new Promise((resolve) => { resolveMedicine = resolve; });
  const updates = [];
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": {
        api: {
          getMedicine: async () => medicineLoad,
          updateMedicine: async (id, payload) => updates.push({ id, payload }),
        },
        ApiError: class ApiError extends Error {},
      },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
  });
  const page = makePageContext(definition);
  page.onLoad({ id: "medicine-1" });
  const save = page.onSubmit();
  await Promise.resolve();
  assert.deepEqual(updates, [], "the pending form must not save default/empty fields");

  resolveMedicine({
    id: "medicine-1",
    name: "已加载药品",
    specification: "20片",
    manufacturer: "厂家甲",
    approvalNumber: "国药准字H00000001",
    barcodeValue: null,
    activeIngredients: [],
    purposeCategory: null,
    leaflet: { purposeSummary: null, packageUsageSummary: null, contraindicationsSummary: null, precautionsSummary: null, source: null, reviewStatus: "unverified" },
    batches: [],
    version: 5,
  });
  await save;
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "medicine-1");
  assert.equal(updates[0].payload.name, "已加载药品");
  assert.equal(updates[0].payload.version, 5);
});
