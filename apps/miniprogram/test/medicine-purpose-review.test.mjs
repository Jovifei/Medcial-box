import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext } from "./runtime.mjs";
import { ownedPhotoFixture } from "./support/owned-photo-fixture.mjs";

function pageFor(api = {}, wx = {}) {
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": { api, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: {
      chooseMedia: async () => ({ tempFiles: [{ tempFilePath: "/tmp/synthetic-box.jpg", size: 2048 }] }),
      ...ownedPhotoFixture(),
      ...wx,
    },
  });
  const page = makePageContext(definition);
  page.onLoad({});
  return page;
}

test("manual names and catalog ingredient text do not infer purpose labels", () => {
  const page = pageFor();
  page.onFieldInput({ currentTarget: { dataset: { field: "name" } }, detail: { value: "阿司匹林" } });
  assert.deepEqual(page.data.purposeTags, []);
  assert.equal(page.data.purposeCategory, "");
  page.setData({ candidate: { name: "布洛芬", specification: null, manufacturer: null, approvalNumber: null,
    activeIngredients: ["布洛芬"], leaflet: null, source: "synthetic", sourceUpdatedAt: null, matchReasons: [] } });
  page.onApplyCandidate();
  assert.equal(page.data.name, "阿司匹林");
  assert.deepEqual(page.data.purposeTags, []);
  assert.equal(page.data.purposeCategory, "");
});

test("structured recognition labels remain reviewable and do not replace manual edits", async () => {
  for (const edited of [false, true]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const page = pageFor({ recognizeMedicine: async () => {
      await gate;
      return { draft: { name: "布洛芬", purposeCategory: "解热镇痛", purposeTags: ["fever", "pain"] },
        warnings: [], requiresConfirmation: true };
    } });
    page.setData({ classificationExpanded: false });
    const pending = page.onRecognizePhoto("camera");
    if (edited) {
      page.onFieldInput({ currentTarget: { dataset: { field: "name" } }, detail: { value: "人工药名" } });
      page.onTogglePurposeTag({ currentTarget: { dataset: { kind: "other" } } });
    }
    release();
    await pending;
    assert.equal(page.data.name, edited ? "人工药名" : "布洛芬");
    assert.deepEqual([...page.data.purposeTags], edited ? ["other"] : ["fever", "pain"]);
    if (!edited) assert.equal(page.data.classificationExpanded, true);
  }
});

test("recognition without structured labels does not guess from the name", async () => {
  const page = pageFor({ recognizeMedicine: async () => ({ draft: { name: "布洛芬" }, warnings: [], requiresConfirmation: true }) });
  await page.onRecognizePhoto("camera");
  assert.equal(page.data.name, "布洛芬");
  assert.deepEqual([...page.data.purposeTags], []);
  assert.equal(page.data.purposeCategory, "");
});

test("barcode misses retain the code and describe an optional review draft", async () => {
  const page = pageFor({ findMedicineCandidates: async () => ({ candidates: [], warnings: [] }) }, {
    scanCode(options) { options.success({ result: "6900000000012" }); },
  });
  await page.onScanCode();
  assert.equal(page.data.barcodeValue, "6900000000012");
  assert.match(page.data.recognitionHint, /尝试生成待核对草稿/);
  assert.doesNotMatch(page.data.recognitionHint, /显卡|自动识别/);
});
