import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadApi, loadPage, loadService, makePageContext } from "./runtime.mjs";

const appJsonPath = path.resolve(import.meta.dirname, "../app.json");

function medicine(overrides = {}) {
  return {
    id: "medicine-1",
    name: "合成感冒药",
    specification: "10片",
    manufacturer: "示例制药厂",
    approvalNumber: "国药准字Z00000000",
    activeIngredients: ["对乙酰氨基酚"],
    purposeCategory: "感冒咳嗽",
    leaflet: {
      purposeSummary: null,
      packageUsageSummary: null,
      contraindicationsSummary: null,
      precautionsSummary: null,
      source: null,
      reviewStatus: "unverified",
    },
    batches: [{
      id: "batch-1",
      lotNumber: "LOT-1",
      expiry: { value: "2027-12-31", precision: "day" },
      expiryState: { state: "ok", label: "有效期至 2027-12-31" },
      quantity: 2,
      unit: "box",
      confirmedUnitsPerPackage: null,
      storageLocation: "客厅药箱",
      openedState: "unopened",
      openedAt: null,
      afterOpeningLimit: null,
      version: 4,
    }],
    lowStockThreshold: null,
    stockStatus: { state: "ok", quantity: 2, unit: "box" },
    expiryState: { state: "ok", label: "有效期正常" },
    isArchived: false,
    version: 7,
    ...overrides,
  };
}

test("app navigation exposes medicine, pending, and mine tabs", () => {
  const config = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));
  assert.deepEqual(config.tabBar.list.map((item) => item.text), ["药箱", "待处理", "我的"]);
  assert.deepEqual(config.tabBar.list.map((item) => item.pagePath), [
    "pages/index/index",
    "pages/pending/pending",
    "pages/mine/mine",
  ]);
});

test("all registered pages have TypeScript, WXML, and page configuration", () => {
  const config = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));
  for (const pagePath of config.pages) {
    assert.equal(fs.existsSync(path.resolve(import.meta.dirname, `../${pagePath}.ts`)), true, `${pagePath}.ts`);
    assert.equal(fs.existsSync(path.resolve(import.meta.dirname, `../${pagePath}.wxml`)), true, `${pagePath}.wxml`);
    assert.equal(fs.existsSync(path.resolve(import.meta.dirname, `../${pagePath}.json`)), true, `${pagePath}.json`);
  }
});

test("medicine list search matches manufacturer, ingredients, and storage location", () => {
  const { definition } = loadPage("pages/index/index.ts", {
    modules: {
      "../../services/api": { api: {}, ApiError: class ApiError extends Error {} , readToken: () => "token" },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
  });
  const page = makePageContext(definition);
  page.applyMedicines([medicine()], "测试家庭");
  for (const keyword of ["示例制药厂", "对乙酰氨基酚", "客厅药箱"]) {
    page.onSearchInput({ detail: { value: keyword } });
    assert.equal(page.data.items.length, 1, `expected ${keyword} to match`);
  }
});

test("scan lookup stores a candidate for review and does not save medicine", async () => {
  const calls = [];
  const candidate = {
    name: "候选药品",
    specification: "12片",
    manufacturer: "候选厂家",
    approvalNumber: null,
    activeIngredients: [],
    leaflet: null,
    source: "demo-catalog",
    sourceUpdatedAt: null,
    matchReasons: ["条码匹配"],
  };
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": {
        api: {
          findMedicineCandidates: async (query) => { calls.push(["lookup", query]); return { candidates: [candidate], warnings: [] }; },
          createMedicine: async () => calls.push(["save"]),
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
    wx: { scanCode(options) { options.success({ result: "6900000000012" }); } },
  });
  const page = makePageContext(definition);
  await page.onScanCode();
  assert.equal(page.data.candidate?.name, "候选药品");
  assert.equal(page.data.scannedBarcode, "6900000000012");
  assert.equal(page.data.barcodeValue, "6900000000012");
  assert.deepEqual(calls, [["lookup", "6900000000012"]]);
  assert.equal(page.data.name, "");
  assert.equal(calls.some(([kind]) => kind === "save"), false);
});

test("saving a scanned medicine preserves the raw barcode in the API payload", async () => {
  const saved = [];
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": { api: { createMedicine: async (payload) => saved.push(payload) }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
  });
  const page = makePageContext(definition);
  page.setData({ name: "商品码合成测试药", scannedBarcode: "6900000000012", barcodeValue: "6900000000012" });
  await page.onSubmit();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].barcodeValue, "6900000000012");
});

test("same-ingredient matching is exact and requires verified data on both medicines", () => {
  const { findVerifiedIngredientMatches } = loadService("services/ingredient-matches.ts");
  const verified = medicine({
    id: "verified",
    activeIngredients: ["对乙酰氨基酚", "咖啡因"],
    leaflet: { reviewStatus: "matched" },
  });
  const unverified = medicine({
    id: "unverified",
    activeIngredients: ["咖啡因"],
    leaflet: { reviewStatus: "unverified" },
  });
  assert.deepEqual(
    findVerifiedIngredientMatches(["咖啡因"], [verified, unverified], true).map((item) => item.id),
    ["verified"],
  );
  assert.equal(findVerifiedIngredientMatches(["咖啡"], [verified], true).length, 0);
  assert.equal(findVerifiedIngredientMatches(["咖啡因"], [verified], false).length, 0);
});

test("medicine save warns only for exact, verified ingredient overlap and cancellation blocks save", async () => {
  const existing = medicine({
    id: "verified-medicine",
    name: "家中已核验药",
    activeIngredients: ["咖啡因"],
    leaflet: { reviewStatus: "user_confirmed" },
  });
  const saved = [];
  const modal = [];
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": {
        api: {
          listMedicines: async () => ({ medicines: [existing] }),
          createMedicine: async (payload) => saved.push(payload),
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
    wx: { showModal(options) { modal.push(options); options.success({ confirm: false }); } },
  });
  const page = makePageContext(definition);
  page.setData({ name: "新录入药", ingredients: "咖啡因", verified: true });
  await page.onSubmit();
  assert.equal(modal[0].title, "家中已有相同成分记录");
  assert.match(modal[0].content, /不是选药建议/);
  assert.deepEqual(saved, []);
});

test("same-ingredient reminders require exact, verified ingredients and never make a selection recommendation", async () => {
  let modalContent = "";
  const { findVerifiedIngredientMatches, confirmIngredientOverlap } = loadService(
    "services/ingredient-matches.ts",
    { wx: { showModal(options) { modalContent = options.content; options.success({ confirm: false }); } } },
  );
  const verified = medicine({
    id: "verified-med",
    name: "已核验组合药",
    activeIngredients: ["对乙酰氨基酚", "咖啡因"],
    leaflet: { reviewStatus: "user_confirmed" },
  });
  const unverified = medicine({
    id: "unverified-med",
    name: "未核验药",
    activeIngredients: ["咖啡因"],
    leaflet: { reviewStatus: "unverified" },
  });
  assert.deepEqual(
    findVerifiedIngredientMatches([" 咖啡因 "], [verified, unverified], true).map((item) => item.id),
    ["verified-med"],
  );
  assert.equal(findVerifiedIngredientMatches(["咖啡"], [verified], true).length, 0);
  assert.equal(findVerifiedIngredientMatches(["咖啡因"], [verified], false).length, 0);

  const confirm = await confirmIngredientOverlap([verified]);
  assert.equal(confirm, false);
  assert.match(modalContent, /这只是重复成分提醒，不是选药建议/);
});

test("medicine entry pauses save for a verified same-ingredient confirmation", async () => {
  const saved = [];
  let modalTitle = "";
  const verified = medicine({
    id: "verified-med",
    name: "家中已核验药",
    activeIngredients: ["咖啡因"],
    leaflet: { reviewStatus: "matched" },
  });
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": {
        api: {
          listMedicines: async () => ({ medicines: [verified] }),
          createMedicine: async (payload) => saved.push(payload),
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
    wx: {
      showModal(options) { modalTitle = options.title; options.success({ confirm: false }); },
    },
    setTimeoutFn: (callback) => { callback(); return 0; },
  });
  const page = makePageContext(definition);
  page.setData({ name: "新录入药", ingredients: "咖啡因", verified: true });
  await page.onSubmit();
  assert.equal(modalTitle, "家中已有相同成分记录");
  assert.equal(saved.length, 0, "cancelling the duplicate warning must keep the user on the form");
});

test("barcode lookup outage keeps the scanned code and asks again before retry", async () => {
  const calls = [];
  const modalTitles = [];
  class CatalogApiError extends Error { constructor(code, message, statusCode) { super(message); this.code = code; this.statusCode = statusCode; } }
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": {
        api: { findMedicineCandidates: async (query) => { calls.push(query); throw new CatalogApiError("MEDICINE_CATALOG_UNAVAILABLE", "unavailable", 503); } },
        ApiError: CatalogApiError,
      },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
    wx: {
      scanCode(options) { options.success({ result: "6900000000012" }); },
      showModal(options) { modalTitles.push(options.title); options.success({ confirm: options.title !== "重新查询商品码" }); },
    },
  });
  const page = makePageContext(definition);
  await page.onScanCode();
  assert.equal(page.data.scannedBarcode, "6900000000012");
  assert.equal(page.data.canRetryBarcode, true);
  assert.match(page.data.barcodeLookupStatus, /服务当前不可用/);
  await page.onRetryBarcodeLookup();
  assert.deepEqual(calls, ["6900000000012"]);
  assert.deepEqual(modalTitles, ["查询药品资料候选", "重新查询商品码"]);
});

test("barcode retry uses the retained code after the user confirms again", async () => {
  let queryCount = 0;
  class CatalogApiError extends Error { constructor(code) { super(code); this.code = code; this.statusCode = 503; } }
  const candidate = { name: "条码候选药", specification: "10片", manufacturer: "示例厂家", approvalNumber: null,
    barcodeValue: "6900000000012", activeIngredients: [], leaflet: null, source: "jisu", sourceUpdatedAt: null, matchReasons: ["条码一致"] };
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": { api: { findMedicineCandidates: async () => {
        queryCount += 1;
        if (queryCount === 1) throw new CatalogApiError("MEDICINE_CATALOG_UNAVAILABLE");
        return { candidates: [candidate], warnings: [] };
      } }, ApiError: CatalogApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: (value) => /^\d+$/.test(value), isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value), isValidExpiryValue: () => true },
    },
    wx: { scanCode(options) { options.success({ result: "6900000000012" }); }, showModal(options) { options.success({ confirm: true }); } },
  });
  const page = makePageContext(definition);
  await page.onScanCode();
  assert.equal(page.data.canRetryBarcode, true);
  await page.onRetryBarcodeLookup();
  assert.equal(queryCount, 2);
  assert.equal(page.data.candidate.name, "条码候选药");
  assert.equal(page.data.scannedBarcode, "6900000000012");
  assert.equal(page.data.canRetryBarcode, false);
});

test("dirty medicine form offers keep, discard, and continue actions and retains kept data locally", () => {
  const storage = new Map();
  const navigations = [];
  const unloadMessages = [];
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": { api: {}, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
    wx: {
      getStorageSync(key) { return storage.get(key); },
      setStorageSync(key, value) { storage.set(key, value); },
      removeStorageSync(key) { storage.delete(key); },
      enableAlertBeforeUnload(options) { unloadMessages.push(options.message); },
      navigateBack(options) { navigations.push("back"); options.success?.(); },
    },
  });
  const page = makePageContext(definition);
  page.onLoad({});
  page.onToggleOpeningInfo({ currentTarget: { dataset: { index: "0" } } });
  assert.equal(page.data.isDirty, false);
  page.onFieldInput({ currentTarget: { dataset: { field: "name" } }, detail: { value: "本地草稿药" } });
  assert.equal(page.data.isDirty, true);
  assert.match(unloadMessages[0], /本机草稿/);
  page.onRequestLeave();
  assert.equal(page.data.leaveSheetVisible, true);
  page.onLeaveChoice({ currentTarget: { dataset: { choice: "continue" } } });
  assert.equal(navigations.length, 0);
  assert.equal(page.data.name, "本地草稿药");
  page.onRequestLeave();
  page.onLeaveChoice({ currentTarget: { dataset: { choice: "keep" } } });
  assert.deepEqual(navigations, ["back"]);
  const saved = storage.get("medicine-edit-draft:new");
  assert.equal(saved.fields.name, "本地草稿药");
  const reopened = makePageContext(definition);
  reopened.onLoad({});
  assert.equal(reopened.data.draftAvailable, true);
  reopened.onRestoreDraft();
  assert.equal(reopened.data.name, "本地草稿药");
  assert.equal(reopened.data.isDirty, true);
});

test("discard medicine form removes draft and leaves the form", () => {
  const storage = new Map();
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": { api: {}, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
    wx: {
      getStorageSync(key) { return storage.get(key); },
      setStorageSync(key, value) { storage.set(key, value); },
      removeStorageSync(key) { storage.delete(key); },
      navigateBack() {},
    },
  });
  const page = makePageContext(definition);
  page.onLoad({});
  page.onFieldInput({ currentTarget: { dataset: { field: "name" } }, detail: { value: "稍后放弃" } });
  page.onRequestLeave();
  page.onLeaveChoice({ currentTarget: { dataset: { choice: "discard" } } });
  assert.equal(storage.has("medicine-edit-draft:new"), false);
  assert.equal(page.data.isDirty, false);
});

test("confirming a catalog candidate fills the editable draft but still does not save", () => {
  const candidate = {
    name: "候选药品",
    specification: "12片",
    manufacturer: "候选厂家",
    approvalNumber: null,
    activeIngredients: ["成分甲"],
    leaflet: null,
    source: "catalog",
    sourceUpdatedAt: null,
    matchReasons: [],
  };
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": { api: {}, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
  });
  const page = makePageContext(definition, { data: { ...structuredClone(definition.data), candidate } });
  page.onApplyCandidate();
  assert.equal(page.data.name, "候选药品");
  assert.equal(page.data.specification, "12片");
  assert.equal(page.data.candidate, null);
});

test("medicine name alone is enough to save an entry with unknown stock and expiry", async () => {
  const saved = [];
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": { api: { createMedicine: async (payload) => saved.push(payload) }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
  });
  const page = makePageContext(definition);
  page.setData({ name: "合成测试药" });
  assert.equal(page.data.batches[0].openingExpanded, false);
  await page.onSubmit();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, "合成测试药");
  assert.equal(saved[0].batches[0].quantity, null);
  assert.equal(saved[0].batches[0].expiry, null);
  assert.equal(saved[0].manufacturer, null);
});

test("barcode lookup consent cancellation prevents opening scanner or calling catalog", async () => {
  const calls = [];
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/api": { api: { findMedicineCandidates: async () => calls.push("lookup") }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
    wx: {
      showModal(options) { options.success({ confirm: false }); },
      scanCode() { calls.push("scan"); },
    },
  });
  const page = makePageContext(definition);
  await page.onScanCode();
  assert.deepEqual(calls, []);
});

test("batch payload preserves optional opening date and post-opening deadline", () => {
  const { definition } = loadPage("pages/batch-edit/batch-edit.ts", {
    modules: {
      "../../services/api": { api: {}, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
  });
  const page = makePageContext(definition, {
    data: {
      ...structuredClone(definition.data),
      precisionIndex: 2,
      quantityUnknown: true,
      openedState: "opened",
      openedAt: "2026-09-28",
      openingLimitMode: "month",
      openingLimitValue: "2",
      openingLimitSource: "包装说明书",
    },
  });
  const result = page.buildPayload();
  assert.equal(result.error, null);
  assert.equal(result.payload.openedState, "opened");
  assert.equal(result.payload.openedAt, "2026-09-28");
  assert.deepEqual(JSON.parse(JSON.stringify(result.payload.afterOpeningLimit)), {
    value: 2,
    unit: "month",
    source: "包装说明书",
  });
});

test("detail quick action marks only the selected batch as opened using its current version", async () => {
  const calls = [];
  const singlePack = medicine();
  singlePack.batches[0].quantity = 1;
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": {
        api: { updateBatch: async (...args) => calls.push(args), getMedicine: async () => singlePack, listDosageNotes: async () => ({ notes: [] }), listLeafletPhotos: async () => ({ photos: [] }) },
        ApiError: class ApiError extends Error {},
      },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: (value) => /^\d+$/.test(value) },
    },
  });
  const page = makePageContext(definition, { data: { ...structuredClone(definition.data), medicineId: "medicine-1", batchRecords: singlePack.batches } });
  await page.onMarkOpened({ currentTarget: { dataset: { id: "batch-1" } } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["medicine-1", "batch-1"]);
  assert.equal(calls[0][2].openedState, "opened");
  assert.equal(calls[0][2].version, 4);
});

test("multi-pack opening opens an explicit split panel and cancel makes no API request", async () => {
  const calls = [];
  const multiPack = medicine();
  multiPack.batches[0].quantity = 5;
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        openSplitBatch: async (...args) => calls.push(args),
        getMedicine: async () => multiPack, listDosageNotes: async () => ({ notes: [] }), listLeafletPhotos: async () => ({ photos: [] }),
      }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
  });
  const page = makePageContext(definition, { data: { ...structuredClone(definition.data), medicineId: "medicine-1", batchRecords: multiPack.batches } });
  await page.onMarkOpened({ currentTarget: { dataset: { id: "batch-1" } } });
  assert.equal(page.data.openingSplitBatchId, "batch-1");
  assert.match(page.data.openingSplitPreview, /开封 1盒；未开封余量 4盒/);
  page.onCancelOpenSplit();
  assert.equal(page.data.openingSplitBatchId, "");
  assert.deepEqual(calls, []);
});

test("partial-pack opening validates the remainder and sends confirmed dates and post-open limit", async () => {
  const calls = [];
  const multiPack = medicine();
  multiPack.batches[0].quantity = 5;
  const opened = { ...multiPack.batches[0], id: "opened-batch", quantity: 2, openedState: "opened", openedAt: "2026-09-29" };
  const remaining = { ...multiPack.batches[0], quantity: 3 };
  const refreshed = medicine({ batches: [opened, remaining] });
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        openSplitBatch: async (...args) => { calls.push(args); return { openedBatch: opened, remainingBatch: remaining }; },
        getMedicine: async () => refreshed, listDosageNotes: async () => ({ notes: [] }), listLeafletPhotos: async () => ({ photos: [] }),
      }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
  });
  const page = makePageContext(definition, { data: { ...structuredClone(definition.data), medicineId: "medicine-1", batchRecords: multiPack.batches } });
  await page.onMarkOpened({ currentTarget: { dataset: { id: "batch-1" } } });
  page.onSplitQuantityInput({ detail: { value: "2" } });
  assert.match(page.data.openingSplitPreview, /开封 2盒；未开封余量 3盒/);
  page.onSplitDateChange({ detail: { value: "2026-09-29" } });
  page.onSplitLimitModeChange({ detail: { value: 2 } });
  page.onSplitLimitValueInput({ detail: { value: "2" } });
  page.onSplitLimitSourceInput({ detail: { value: "包装说明书" } });
  await page.onConfirmOpenSplit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "medicine-1");
  assert.equal(calls[0][1], "batch-1");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), {
    version: 4,
    openedQuantity: 2,
    openedAt: "2026-09-29",
    afterOpeningLimit: { value: 2, unit: "month", source: "包装说明书" },
    confirmed: true,
  });
  assert.equal(page.data.batchRecords.length, 2);
  assert.equal(page.data.batchRecords[1].quantity, 3);
});

test("partial-pack opening rejects whole-quantity split and keeps unknown/single-unit batches on whole-open path", async () => {
  const calls = [];
  const multiPack = medicine();
  multiPack.batches[0].quantity = 5;
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        openSplitBatch: async (...args) => calls.push(args),
        updateBatch: async (...args) => calls.push(args),
        getMedicine: async () => multiPack, listDosageNotes: async () => ({ notes: [] }), listLeafletPhotos: async () => ({ photos: [] }),
      }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
    wx: { showToast() {} },
  });
  const page = makePageContext(definition, { data: { ...structuredClone(definition.data), medicineId: "medicine-1", batchRecords: multiPack.batches } });
  await page.onMarkOpened({ currentTarget: { dataset: { id: "batch-1" } } });
  page.onSplitQuantityInput({ detail: { value: "5" } });
  await page.onConfirmOpenSplit();
  assert.equal(page.data.openingSplitError.includes("1 到 4"), true);
  assert.deepEqual(calls, []);
  const unknown = { ...multiPack.batches[0], quantity: null };
  page.setData({ batchRecords: [unknown], openingSplitBatchId: "" });
  await page.onMarkOpened({ currentTarget: { dataset: { id: "batch-1" } } });
  assert.equal(page.data.openingSplitBatchId, "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].quantity, null);
  const empty = { ...multiPack.batches[0], quantity: 0 };
  page.setData({ batchRecords: [empty] });
  await page.onMarkOpened({ currentTarget: { dataset: { id: "batch-1" } } });
  assert.equal(calls.length, 1);
});

test("stale split-open conflict refreshes the batch and reports no split was saved", async () => {
  const multiPack = medicine();
  multiPack.batches[0].quantity = 5;
  const current = medicine();
  current.batches[0].quantity = 4;
  current.batches[0].version = 5;
  class SplitApiError extends Error { constructor(code, message, statusCode) { super(message); this.code = code; this.statusCode = statusCode; } }
  const modalTexts = [];
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        openSplitBatch: async () => { throw new SplitApiError("VERSION_CONFLICT", "stale", 409); },
        getMedicine: async () => current, listDosageNotes: async () => ({ notes: [] }), listLeafletPhotos: async () => ({ photos: [] }),
      }, ApiError: SplitApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": {
        isStrictNonNegativeInteger: (value) => /^\d+$/.test(value),
        isStrictPositiveInteger: (value) => /^[1-9]\d*$/.test(value),
        isValidExpiryValue: () => true,
      },
    },
    wx: { showModal(options) { modalTexts.push(options.content); options.success({ confirm: true }); } },
  });
  const page = makePageContext(definition, { data: { ...structuredClone(definition.data), medicineId: "medicine-1", batchRecords: multiPack.batches } });
  await page.onMarkOpened({ currentTarget: { dataset: { id: "batch-1" } } });
  page.onSplitQuantityInput({ detail: { value: "2" } });
  page.onSplitDateChange({ detail: { value: "2026-09-29" } });
  await page.onConfirmOpenSplit();
  assert.equal(page.data.openingSplitBatchId, "");
  assert.equal(page.data.batchRecords[0].version, 5);
  assert.equal(page.data.batchRecords[0].quantity, 4);
  assert.ok(modalTexts.some((text) => text.includes("拆分未完成，库存没有改变")));
});

test("low-stock threshold is saved through the medicine update contract", async () => {
  const calls = [];
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": {
        api: {
          updateMedicine: async (...args) => calls.push(args),
          getMedicine: async () => medicine(),
          listDosageNotes: async () => ({ notes: [] }),
          listLeafletPhotos: async () => ({ photos: [] }),
        },
        ApiError: class ApiError extends Error {},
      },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: (value) => /^\d+$/.test(value) },
    },
  });
  const page = makePageContext(definition, { data: {
    ...structuredClone(definition.data), medicineId: "medicine-1", medicineSummary: medicine(),
    thresholdEnabled: true, thresholdQuantity: "2", thresholdUnitIndex: 4,
  } });
  await page.onSaveThreshold();
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].lowStockThreshold)), { quantity: 2, unit: "box" });
});

test("stocktake retry submits only unresolved batches after a partial save", async () => {
  const calls = [];
  const { definition } = loadPage("pages/stocktake/stocktake.ts", {
    modules: {
      "../../services/api": {
        api: {
          submitStocktakeItems: async (_id, items) => { calls.push(items); return { results: items.map((item) => ({ batchId: item.batchId, outcome: "saved" })) }; },
          completeStocktake: async () => ({ completed: true, completedAt: "2026-09-29T00:00:00.000Z", nextStocktakeAt: null }),
          getCurrentStocktake: async () => ({ stocktake: null }),
        },
        ApiError: class ApiError extends Error {},
      },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: (value) => /^\d+$/.test(value) },
    },
  });
  const page = makePageContext(definition, { data: {
    ...structuredClone(definition.data),
    stocktake: { id: "stocktake-1", status: "open", startedAt: "2026-09-29T00:00:00.000Z", items: [] },
    items: [
      { batchId: "saved-batch", version: 5, medicineId: "m1", medicineName: "已保存药", quantity: 2, unit: "box", outcome: "adjusted", outcomeIndex: 2, adjustedQuantity: "2", result: "saved", resultLabel: "已保存" },
      { batchId: "conflict-batch", version: 6, medicineId: "m2", medicineName: "冲突药", quantity: 1, unit: "box", outcome: "adjusted", outcomeIndex: 2, adjustedQuantity: "3", result: "conflict", resultLabel: "家人已修改" },
    ],
  } });
  page.onOutcomeChange({ currentTarget: { dataset: { index: "1" } }, detail: { value: 2 } });
  await page.onSubmit();
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0], (item) => item.batchId), ["conflict-batch"]);
  assert.equal(calls[0][0].quantity, 3);
});

test("stocktake refresh reloads the latest version and quantity for conflicted batches", async () => {
  const current = {
    id: "stocktake-1", status: "open", startedAt: "2026-09-29T00:00:00.000Z",
    items: [{ batchId: "batch-1", medicineId: "medicine-1", medicineName: "合成感冒药", quantity: 1,
      unit: "box", expiry: { value: "2027-12-31", precision: "day" }, openedState: "unopened", openedAt: null,
      managementExpiryDate: "2027-12-31", version: 2, result: "conflict" }],
  };
  const { definition } = loadPage("pages/stocktake/stocktake.ts", {
    modules: {
      "../../services/api": { api: {
        getCurrentStocktake: async () => ({ stocktake: current }),
        getMedicine: async () => medicine({ batches: [{ ...medicine().batches[0], version: 3, quantity: 4 }] }),
      }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: (value) => /^\d+$/.test(value) },
    },
  });
  const page = makePageContext(definition);
  await page.refresh();
  assert.equal(page.data.items[0].version, 3);
  assert.equal(page.data.items[0].quantity, 4);
  assert.equal(page.data.items[0].result, "conflict");
  assert.match(page.data.items[0].resultLabel, /重新核对/);
  page.onQuantityInput({ currentTarget: { dataset: { index: "0" } }, detail: { value: "5" } });
  assert.equal(page.data.items[0].outcome, "adjusted");
  assert.equal(page.data.items[0].result, "pending");
});

test("mini API uses POST for catalog lookup and app device approval", async () => {
  const service = loadApi();
  await service.api.findMedicineCandidates("6900000000012");
  await service.api.approveAppDeviceLink("ABC123");
  const requests = service.requests.map(({ method, url, data }) => [method, url, data === undefined ? null : JSON.parse(JSON.stringify(data))]);
  assert.deepEqual(requests, [
    ["POST", "https://medicine.test/api/v1/medicine-catalog/candidates", { barcode: "6900000000012", consentToShare: true }],
    ["POST", "https://medicine.test/api/v1/auth/device-links/approve", { code: "ABC123" }],
  ]);
});

test("mini API sends split-open confirmation with batch version and opened allocation", async () => {
  const service = loadApi();
  const payload = { version: 4, openedQuantity: 2, openedAt: "2026-09-29", afterOpeningLimit: { value: 30, unit: "day", source: "说明书" }, confirmed: true };
  await service.api.openSplitBatch("medicine-1", "batch-1", payload);
  const request = service.requests.map(({ method, url, data }) => [method, url, data === undefined ? null : JSON.parse(JSON.stringify(data))]);
  assert.deepEqual(request, [["POST", "https://medicine.test/api/v1/medicines/medicine-1/batches/batch-1/open-split", payload]]);
});

test("mini API lists device sessions and revokes only through Android revoke route", async () => {
  const service = loadApi();
  await service.api.getDevices();
  await service.api.revokeAndroidDevice("android-session-1");
  const requests = service.requests.map(({ method, url, data }) => [method, url, data === undefined ? null : JSON.parse(JSON.stringify(data))]);
  assert.deepEqual(requests, [
    ["GET", "https://medicine.test/api/v1/auth/devices", null],
    ["POST", "https://medicine.test/api/v1/auth/devices/android-session-1/revoke", {}],
  ]);
});

test("mine page lists sessions, protects the current Mini Program session, and revokes Android sessions", async () => {
  const calls = [];
  let devices = [
    { id: "mini-session", clientKind: "miniprogram", createdAt: "2026-09-29T00:00:00.000Z", expiresAt: "2026-10-29T00:00:00.000Z", isCurrent: true },
    { id: "android-session", clientKind: "android", createdAt: "2026-09-28T00:00:00.000Z", expiresAt: "2026-10-28T00:00:00.000Z", isCurrent: false },
  ];
  const { definition } = loadPage("pages/mine/mine.ts", {
    modules: {
      "../../services/api": { api: {
        getCurrentFamily: async () => ({ family: { name: "合成家庭", role: "owner" } }),
        getDevices: async () => ({ devices }),
        revokeAndroidDevice: async (id) => { calls.push(id); devices = devices.filter((device) => device.id !== id); return { revoked: true }; },
      }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: { showModal(options) { options.success({ confirm: true }); } },
  });
  const page = makePageContext(definition);
  await page.refresh();
  assert.equal(page.data.devices.length, 2);
  assert.equal(page.data.devices[0].kindLabel, "微信小程序");
  await page.onRevokeDevice({ currentTarget: { dataset: { id: "mini-session" } } });
  assert.deepEqual(calls, []);
  await page.onRevokeDevice({ currentTarget: { dataset: { id: "android-session" } } });
  assert.deepEqual(calls, ["android-session"]);
  assert.equal(page.data.devices.length, 1);
  assert.equal(page.data.devices[0].isCurrent, true);
});

test("App device approval rejects anything except the server's 8-digit one-time code", async () => {
  const calls = [];
  const { definition } = loadPage("pages/app-link/app-link.ts", {
    modules: {
      "../../services/api": { api: { approveAppDeviceLink: async (code) => { calls.push(code); return { approved: true }; } }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: { showModal(options) { options.success({ confirm: true }); } },
  });
  const page = makePageContext(definition, { data: { ...structuredClone(definition.data), code: "1234567" } });
  await page.onApprove();
  assert.deepEqual(calls, []);
  assert.match(page.data.resultText, /8 位数字/);
  page.setData({ code: "12345678" });
  await page.onApprove();
  assert.deepEqual(calls, ["12345678"]);
  assert.match(page.data.resultText, /连接已确认/);
});

test("App device confirmation is guarded against repeated taps while the prompt is open", async () => {
  let modalOptions;
  const calls = [];
  const { definition } = loadPage("pages/app-link/app-link.ts", {
    modules: {
      "../../services/api": { api: { approveAppDeviceLink: async (code) => { calls.push(code); return { approved: true }; } }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: { showModal(options) { modalOptions = options; } },
  });
  const page = makePageContext(definition, { data: { ...structuredClone(definition.data), code: "12345678" } });
  const first = page.onApprove();
  assert.equal(page.data.submitting, true);
  await page.onApprove();
  assert.deepEqual(calls, []);
  modalOptions.success({ confirm: true });
  await first;
  assert.deepEqual(calls, ["12345678"]);
});

test("mini API exposes current pending notifications and explicitly requested subscription", async () => {
  const service = loadApi();
  await service.api.getPendingNotifications();
  await service.api.subscribeToNotifications(["template-id"]);
  const requests = service.requests.map(({ method, url, data }) => [method, url, data === undefined ? null : JSON.parse(JSON.stringify(data))]);
  assert.deepEqual(requests, [
    ["GET", "https://medicine.test/api/v1/notifications/pending", null],
    ["POST", "https://medicine.test/api/v1/notifications/subscribe", { acceptedTemplateIds: ["template-id"] }],
  ]);
});

test("pending expiry action opens the exact batch editor", () => {
  const navigations = [];
  const { definition } = loadPage("pages/pending/pending.ts", {
    modules: {
      "../../services/api": { api: {}, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: { navigateTo(options) { navigations.push(options.url); } },
  });
  const page = makePageContext(definition);
  page.onHandle({ currentTarget: { dataset: { id: "medicine 1", batchId: "batch/1", action: "edit_batch" } } });
  assert.deepEqual(navigations, ["/pages/batch-edit/batch-edit?medicineId=medicine%201&batchId=batch%2F1"]);
});

test("leaflet photo API uses authenticated private endpoints and only uploads explicit payloads", async () => {
  const service = loadApi();
  await service.api.listLeafletPhotos("medicine-1");
  await service.api.uploadLeafletPhoto("medicine-1", "/9j/AAEC/9k=", "image/jpeg", "package_leaflet");
  await service.api.deleteLeafletPhoto("medicine-1", "photo-1");
  const requests = service.requests.map(({ method, url, data }) => [method, url, data === undefined ? null : JSON.parse(JSON.stringify(data))]);
  assert.deepEqual(requests, [
    ["GET", "https://medicine.test/api/v1/medicines/medicine-1/leaflet-photos", null],
    ["POST", "https://medicine.test/api/v1/medicines/medicine-1/leaflet-photos", { imageBase64: "/9j/AAEC/9k=", mimeType: "image/jpeg", source: "package_leaflet" }],
    ["DELETE", "https://medicine.test/api/v1/medicines/medicine-1/leaflet-photos/photo-1", null],
  ]);
});

test("private leaflet photo download sends the current bearer token", async () => {
  const downloads = [];
  const service = loadApi({ wx: { downloadFile(options) { downloads.push(options); options.success({ statusCode: 200, tempFilePath: "wxfile://tmp/leaflet.jpg" }); } } });
  const localPath = await service.api.downloadLeafletPhoto("medicine 1", "photo/1");
  assert.equal(localPath, "wxfile://tmp/leaflet.jpg");
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].url, "https://medicine.test/api/v1/medicines/medicine%201/leaflet-photos/photo%2F1");
  assert.equal(downloads[0].header.authorization, "Bearer test-token");
});

test("private leaflet photo 401 clears the stale Mini Program session token", async () => {
  const removed = [];
  const service = loadApi({ wx: {
    removeStorageSync(key) { removed.push(key); },
    downloadFile(options) { options.success({ statusCode: 401, tempFilePath: "" }); },
  } });
  await assert.rejects(service.api.downloadLeafletPhoto("medicine-1", "photo-1"), (error) => error.code === "UNAUTHORIZED");
  assert.deepEqual(removed, ["home_medicine_session_token"]);
});

test("medicine details list leaflet photo metadata without downloading photos until preview is tapped", async () => {
  const calls = [];
  const photo = { id: "photo-1", medicineId: "medicine-1", contentType: "image/jpeg", sizeBytes: 1024,
    source: "package_leaflet", createdAt: "2026-09-29T00:00:00.000Z", url: "/private/photo-1" };
  let preview;
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        getMedicine: async () => medicine(), listDosageNotes: async () => ({ notes: [] }),
        listLeafletPhotos: async () => { calls.push("list"); return { photos: [photo] }; },
        downloadLeafletPhoto: async () => { calls.push("download"); return "wxfile://private/photo.jpg"; },
        uploadLeafletPhoto: async () => { calls.push("upload"); return { photo }; },
      }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: (value) => /^\d+$/.test(value) },
    },
    wx: { previewImage(options) { preview = options; options.success?.(); } },
  });
  const page = makePageContext(definition);
  page.onLoad({ id: "medicine-1" });
  await page.refresh();
  assert.deepEqual(calls, ["list"]);
  assert.equal(page.data.leafletPhotos[0].sizeText, "1 KB");
  assert.equal(calls.includes("upload"), false);
  await page.onPreviewLeafletPhoto({ currentTarget: { dataset: { id: "photo-1" } } });
  assert.deepEqual(calls, ["list", "download"]);
  assert.equal(preview.current, "wxfile://private/photo.jpg");
});

test("leaflet photo upload requires explicit selection and confirmation, then refreshes the list", async () => {
  const calls = [];
  const sourceTypes = [];
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0xff, 0xd9]).toString("base64");
  let photos = [];
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        getMedicine: async () => medicine(), listDosageNotes: async () => ({ notes: [] }),
        listLeafletPhotos: async () => ({ photos }),
        uploadLeafletPhoto: async (...args) => { calls.push(args); photos = [{ id: "photo-new", medicineId: "medicine-1", contentType: "image/jpeg", sizeBytes: 8, source: "package_leaflet", createdAt: "2026-09-29T00:00:00.000Z", url: "/private/photo-new" }]; return { photo: photos[0] }; },
      }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: (value) => /^\d+$/.test(value) },
    },
    wx: {
      showActionSheet(options) { options.success({ tapIndex: 1 }); },
      chooseMedia(options) { sourceTypes.push(options.sourceType[0]); options.success({ tempFiles: [{ tempFilePath: "synthetic.jpg", size: 8 }] }); },
      getFileSystemManager() { return { readFile(options) { options.success({ data: fakeJpeg }); } }; },
      showModal(options) { options.success({ confirm: true }); },
    },
  });
  const page = makePageContext(definition);
  page.onLoad({ id: "medicine-1" });
  await page.refresh();
  assert.deepEqual(calls, []);
  await page.onAddLeafletPhoto();
  assert.deepEqual(sourceTypes, ["album"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "medicine-1");
  assert.equal(calls[0][1], fakeJpeg);
  assert.equal(calls[0][2], "image/jpeg");
  assert.equal(calls[0][3], "package_leaflet");
  assert.equal(page.data.leafletPhotos.length, 1);
});

test("declining leaflet photo upload confirmation leaves the photo on device only", async () => {
  const calls = [];
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0xff, 0xd9]).toString("base64");
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        uploadLeafletPhoto: async (...args) => calls.push(args),
        listLeafletPhotos: async () => ({ photos: [] }),
        getMedicine: async () => medicine(), listDosageNotes: async () => ({ notes: [] }),
      }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: (value) => /^\d+$/.test(value) },
    },
    wx: {
      showActionSheet(options) { options.success({ tapIndex: 0 }); },
      chooseMedia(options) { options.success({ tempFiles: [{ tempFilePath: "synthetic.jpg", size: 8 }] }); },
      getFileSystemManager() { return { readFile(options) { options.success({ data: fakeJpeg }); } }; },
      showModal(options) { options.success({ confirm: false }); },
    },
  });
  const page = makePageContext(definition);
  page.onLoad({ id: "medicine-1" });
  await page.onAddLeafletPhoto();
  assert.deepEqual(calls, []);
  assert.match(page.data.photoStatus, /未上传/);
});

test("oversized leaflet photo is rejected locally before any upload request", async () => {
  const calls = [];
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: { uploadLeafletPhoto: async (...args) => calls.push(args) }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: (value) => /^\d+$/.test(value) },
    },
    wx: {
      showActionSheet(options) { options.success({ tapIndex: 0 }); },
      chooseMedia(options) { options.success({ tempFiles: [{ tempFilePath: "synthetic-large.jpg", size: 7 * 1024 * 1024 }] }); },
    },
  });
  const page = makePageContext(definition, { data: { ...structuredClone(definition.data), medicineId: "medicine-1" } });
  await page.onAddLeafletPhoto();
  assert.deepEqual(calls, []);
  assert.match(page.data.photoError, /6 MB/);
});

test("leaflet photo delete requires confirmation and removes only the selected photo", async () => {
  const calls = [];
  let confirm = false;
  let photos = [{ id: "photo-1", medicineId: "medicine-1", contentType: "image/jpeg", sizeBytes: 8,
    source: "package_leaflet", createdAt: "2026-09-29T00:00:00.000Z", url: "/private/photo-1" }];
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        listLeafletPhotos: async () => ({ photos }),
        deleteLeafletPhoto: async (_medicineId, photoId) => { calls.push(photoId); photos = []; return null; },
      }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: (value) => /^\d+$/.test(value) },
    },
    wx: { showModal(options) { options.success({ confirm }); } },
  });
  const page = makePageContext(definition, { data: { ...structuredClone(definition.data), medicineId: "medicine-1" } });
  await page.refreshLeafletPhotos();
  await page.onDeleteLeafletPhoto({ currentTarget: { dataset: { id: "photo-1" } } });
  assert.deepEqual(calls, []);
  confirm = true;
  await page.onDeleteLeafletPhoto({ currentTarget: { dataset: { id: "photo-1" } } });
  assert.deepEqual(calls, ["photo-1"]);
  assert.equal(page.data.leafletPhotos.length, 0);
});

test("leaflet photo list failures keep medicine details available and expose a recoverable error", async () => {
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        getMedicine: async () => medicine(), listDosageNotes: async () => ({ notes: [] }),
        listLeafletPhotos: async () => { throw new Error("photo service unavailable"); },
      }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: (value) => /^\d+$/.test(value) },
    },
  });
  const page = makePageContext(definition);
  page.onLoad({ id: "medicine-1" });
  await page.refresh();
  assert.equal(page.data.name, "合成感冒药");
  assert.equal(page.data.photoLoading, false);
  assert.match(page.data.photoError, /无法读取说明书照片/);
});

test("mini API uses the family scoped restock routes and optimistic version", async () => {
  const service = loadApi();
  await service.api.listRestockItems();
  await service.api.createRestockItem({ medicineId: "medicine-1", desiredQuantity: 2, unit: "box" });
  await service.api.updateRestockItem("restock-1", "purchased", 3);
  await service.api.deleteRestockItem("restock-1");
  const requests = service.requests.map(({ method, url, data }) => [method, url, data === undefined ? null : JSON.parse(JSON.stringify(data))]);
  assert.deepEqual(requests, [
    ["GET", "https://medicine.test/api/v1/families/restock", null],
    ["POST", "https://medicine.test/api/v1/families/restock", { medicineId: "medicine-1", desiredQuantity: 2, unit: "box" }],
    ["PUT", "https://medicine.test/api/v1/families/restock/restock-1", { status: "purchased", version: 3 }],
    ["DELETE", "https://medicine.test/api/v1/families/restock/restock-1", null],
  ]);
});

test("purchased restock item opens its medicine details for batch intake", () => {
  const navigations = [];
  const { definition } = loadPage("pages/restock/restock.ts", {
    modules: {
      "../../services/api": { api: {}, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: { navigateTo(options) { navigations.push(options.url); } },
  });
  const page = makePageContext(definition);
  page.onOpenMedicine({ currentTarget: { dataset: { id: "medicine-1" } } });
  assert.deepEqual(navigations, ["/pages/medicine-detail/medicine-detail?id=medicine-1"]);
});

test("mini API backup calls preview without writing and restores only after explicit confirmation", async () => {
  const service = loadApi();
  const backup = {
    schemaVersion: 1,
    backupId: "backup-1",
    exportedAt: "2026-09-29T00:00:00.000Z",
    familyName: "合成家庭",
    medicines: [],
    inventorySettings: { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null },
  };
  await service.api.createJsonBackup();
  await service.api.previewJsonBackup(backup);
  await service.api.restoreJsonBackup(backup, "a".repeat(64));
  const requests = service.requests.map(({ method, url, data }) => [method, url, data === undefined ? null : JSON.parse(JSON.stringify(data))]);
  assert.deepEqual(requests, [
    ["POST", "https://medicine.test/api/v1/backups/json", {}],
    ["POST", "https://medicine.test/api/v1/backups/preview", { backup }],
    ["POST", "https://medicine.test/api/v1/backups/restore", { backup, confirmationToken: "a".repeat(64), confirmed: true }],
  ]);
});

test("backup import keeps payload out of view data and writes only after confirmation", async () => {
  const backup = {
    schemaVersion: 1,
    backupId: "backup-import-1",
    exportedAt: "2026-09-29T00:00:00.000Z",
    familyName: "合成家庭",
    medicines: [{ name: "合成测试药", batches: [] }],
    inventorySettings: { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null },
  };
  const calls = [];
  const { definition } = loadPage("pages/backup-restore/backup-restore.ts", {
    modules: {
      "../../services/api": { api: {
        previewJsonBackup: async (payload) => { calls.push(["preview", payload]); return { valid: true, duplicateBackup: false, confirmationToken: "b".repeat(64), inventorySettings: { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null }, medicineCount: 1, likelyMatches: [], errors: [] }; },
        restoreJsonBackup: async (payload, token) => { calls.push(["restore", payload, token]); return { restoredCount: 1, backupId: payload.backupId }; },
      }, ApiError: class ApiError extends Error {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: {
      chooseMessageFile(options) { options.success({ tempFiles: [{ path: "backup.json", name: "backup.json" }] }); },
      getFileSystemManager() { return { readFile(options) { options.success({ data: JSON.stringify(backup) }); } }; },
      showModal(options) { options.success({ confirm: true }); },
    },
  });
  const page = makePageContext(definition);
  await page.onChooseImport();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "preview");
  assert.equal(Object.hasOwn(page.data.importPreview, "confirmationToken"), false);
  assert.equal(page.pendingConfirmationToken, "b".repeat(64));
  assert.equal(page.data.importPayload, undefined);
  assert.equal(page.pendingImportPayload.backupId, backup.backupId);
  await page.onConfirmRestore();
  assert.deepEqual(calls.map(([kind]) => kind), ["preview", "restore"]);
  assert.equal(calls[1][2], "b".repeat(64));
  assert.equal(page.data.conflictText.includes("monthly"), true);
  assert.equal(page.pendingConfirmationToken, null);
  assert.equal(page.pendingImportPayload, null);
});

test("notification page requests only available templates after the user taps", async () => {
  const calls = [];
  const { definition } = loadPage("pages/notification-settings/notification-settings.ts", {
    modules: {
      "../../services/api": {
        api: {
          subscribeToNotifications: async (acceptedTemplateIds) => { calls.push(["save", acceptedTemplateIds]); return { acceptedTemplateIds }; },
        },
        ApiError: class ApiError extends Error {},
      },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: { requestSubscribeMessage(options) { calls.push(["prompt", options.tmplIds]); options.success({ "template-a": "accept" }); } },
  });
  const page = makePageContext(definition, { data: {
    ...structuredClone(definition.data),
    templates: [{ templateId: "template-a", title: "过期提醒", available: true }],
  } });
  page.onTapSubscribe();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [["prompt", ["template-a"]], ["save", ["template-a"]]]);
  assert.match(page.data.statusText, /服务端已记录/);
});
