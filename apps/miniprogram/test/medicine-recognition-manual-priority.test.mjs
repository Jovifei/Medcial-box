import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext } from "./runtime.mjs";
import { ownedPhotoFixture } from "./support/owned-photo-fixture.mjs";
import { harness, select } from "./photo-queue-test-harness.mjs";

function pageFor(recognizeMedicine) {
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    setTimeoutFn: () => 0,
    modules: {
      "../../services/api": { api: { recognizeMedicine }, ApiError: class extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: {
      ...ownedPhotoFixture(),
      chooseMedia: async () => ({ tempFiles: [{ tempFilePath: "/synthetic-box.jpg", size: 4 }] }),
    },
  });
  const page = makePageContext(definition);
  page.onLoad({});
  return page;
}

function edit(page, field, value) {
  page.onFieldInput({ currentTarget: { dataset: { field } }, detail: { value } });
}

const candidate = {
  name: "识别候选", brand: "候选品牌", specification: "10片", manufacturer: "候选厂家",
  approvalNumber: null, barcodeValue: null, activeIngredients: [], purposeTags: [],
  leaflet: { purposeSummary: "候选用途", packageUsageSummary: "候选用法", contraindicationsSummary: null, precautionsSummary: null },
  source: "synthetic", sourceUpdatedAt: null, matchReasons: [],
};

test("a prior explicit clear of name and population is not refilled by a later photo", async () => {
  let calls = 0;
  const page = pageFor(async () => {
    calls++;
    return { draft: { name: "识别药名", populationTags: ["adult"] }, warnings: [], requiresConfirmation: true };
  });
  edit(page, "name", "家人填写");
  edit(page, "name", "");
  const toggle = { currentTarget: { dataset: { kind: "adult" } } };
  page.onTogglePopulationTag(toggle);
  page.onTogglePopulationTag(toggle);
  await page.onRecognizePhoto("camera");
  assert.equal(calls, 1);
  assert.equal(page.data.name, "", "主动清空的名称须留给用户决定");
  assert.deepEqual([...page.data.populationTags], [], "主动取消的人群不能自动复选");
});

test("manual clears before a catalog selection are not overwritten", () => {
  const page = pageFor(async () => { throw new Error("not used"); });
  for (const field of ["name", "brand", "specification", "manufacturer", "leafletUsage"]) {
    edit(page, field, "家人填写");
    edit(page, field, "");
  }
  page.setData({ candidate, candidates: [candidate] });
  page.onApplyCandidate();
  for (const field of ["name", "brand", "specification", "manufacturer", "leafletUsage"]) {
    assert.equal(page.data[field], "", `${field} 的人工清空不能被候选覆盖`);
  }
});

test("a catalog candidate that changes no leaflet text keeps the user's existing verification", () => {
  const page = pageFor(async () => { throw new Error("not used"); });
  page.setData({
    leafletPurpose: "本人用途", leafletUsage: "本人用法", leafletContraindications: "本人禁忌",
    leafletPrecautions: "本人注意事项", leafletSource: "本人来源", verified: true,
    candidate, candidates: [candidate],
  });
  page.onApplyCandidate();
  assert.equal(page.data.verified, true);
  assert.equal(page.data.leafletSource, "本人来源");
});

test("manual clear remains associated with its photo draft after selecting another draft and back", () => {
  const h = harness();
  const first = h.draft("photo-101-manual");
  const second = h.draft("photo-102-untouched");
  h.seed([first, second]);
  h.attach(h.a, [first, second], first.id);
  h.a.loadPhotoDrafts();
  edit(h.a, "manufacturer", "家人填写");
  edit(h.a, "manufacturer", "");

  select(h.a, second.id);
  h.a.setData({ candidate, candidates: [candidate] });
  h.a.onApplyCandidate();
  assert.equal(h.a.data.manufacturer, "候选厂家", "另一份未编辑草稿可接收候选");

  select(h.a, first.id);
  h.a.setData({ candidate, candidates: [candidate] });
  h.a.onApplyCandidate();
  assert.equal(h.a.data.manufacturer, "", "切回后仍保留该草稿的人工清空");
  assert.equal(h.calls.create, 0);
});

test("manual clear remains protected after the photo draft is restored in a new page", () => {
  const h = harness();
  const first = h.draft("photo-103-manual");
  h.seed([first]);
  h.attach(h.a, [first]);
  h.a.loadPhotoDrafts();
  edit(h.a, "brand", "家人填写");
  edit(h.a, "brand", "");
  const reopened = h.page();
  h.attach(reopened, h.read());
  select(reopened, first.id);
  reopened.setData({ candidate, candidates: [candidate] });
  reopened.onApplyCandidate();
  assert.equal(reopened.data.brand, "", "恢复后不能忘记人工清空");
  assert.equal(h.calls.create, 0);
});
