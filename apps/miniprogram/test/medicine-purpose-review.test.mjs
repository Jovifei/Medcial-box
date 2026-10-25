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

test("box-front recognition fills core details without opening advanced fields", async () => {
  const page = pageFor({ recognizeMedicine: async () => ({
    draft: { name: "蒙脱石散", specification: "3克×10袋", manufacturer: "合成药厂", approvalNumber: "测试准字" },
    warnings: [], requiresConfirmation: true,
  }) });
  await page.onRecognizePhoto("camera");
  assert.equal(page.data.name, "蒙脱石散");
  assert.equal(page.data.specification, "3克×10袋");
  assert.equal(page.data.optionalExpanded, false);
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

test("catalog candidates with mapped purpose tags fill empty chips but never replace manual picks", () => {
  const page = pageFor();
  const candidate = { name: "布洛芬缓释胶囊", specification: "0.3g×20粒", manufacturer: null, approvalNumber: null,
    activeIngredients: [], purposeTags: ["fever", "pain"], leaflet: null, source: "synthetic", sourceUpdatedAt: null, matchReasons: [] };
  page.setData({ candidate, candidates: [candidate] });
  page.onApplyCandidate();
  assert.deepEqual([...page.data.purposeTags], ["fever", "pain"]);
  assert.equal(page.data.purposeChips.find((chip) => chip.kind === "fever").selected, true);
  assert.equal(page.data.classificationExpanded, true);
  // 用户已手动勾选过其它标签时，候选标签不得覆盖。
  const manual = pageFor();
  manual.onTogglePurposeTag({ currentTarget: { dataset: { kind: "gastro" } } });
  manual.setData({ candidate, candidates: [candidate] });
  manual.onApplyCandidate();
  assert.deepEqual([...manual.data.purposeTags], ["gastro"]);
});

test("catalog candidates cannot revive purpose tags explicitly cleared by the user", () => {
  let writes = 0;
  const page = pageFor({ createMedicine: async () => { writes += 1; } });
  const event = { currentTarget: { dataset: { kind: "other" } } };
  page.onTogglePurposeTag(event);
  page.onTogglePurposeTag(event);
  assert.deepEqual([...page.data.purposeTags], []);
  const candidate = { name: "合成候选", activeIngredients: [], purposeTags: ["fever", "pain"], leaflet: null };
  page.setData({ candidate, candidates: [candidate] });
  page.onApplyCandidate();
  assert.deepEqual([...page.data.purposeTags], []);
  assert.equal(page.data.purposeChips.some(chip => chip.selected), false);
  assert.equal(writes, 0, "采纳候选仍需要人工保存");
});

test("catalog candidate purpose tags are whitelisted, unique and limited before entering the draft", () => {
  const page = pageFor();
  const candidate = { name: "合成候选", activeIngredients: [], leaflet: null,
    purposeTags: ["constructor", "future_tag", "fever", "fever", null, "pain", "cough", "nasal"] };
  page.setData({ candidate, candidates: [candidate], classificationExpanded: false });
  assert.deepEqual([...page.data.purposeTags], [], "查询结果不能自动采纳");
  page.onApplyCandidate();
  assert.deepEqual([...page.data.purposeTags], ["fever", "pain", "cough"]);
  assert.equal(page.data.purposeChips.filter(chip => chip.selected).length, 3);
  assert.equal(page.data.classificationExpanded, true);
  assert.equal(page.data.verified, false);
});
