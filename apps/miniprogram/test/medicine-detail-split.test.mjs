import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext } from "./runtime.mjs";

/**
 * R08/S3：药品详情"拆分开封"入口必须按单位解析。
 * 复现的缺陷：毫升批次拆分 2.5ml 被 isStrictPositiveInteger 拒绝；
 * 计件单位却可能放过小数。这里验证毫升允许小数并守恒、计件单位拒绝小数，
 * 且确认提交携带按单位解析后的数值。
 */

class ApiError extends Error {}

function batch(overrides = {}) {
  return {
    id: "batch-1",
    lotNumber: "Lot-1",
    expiry: { value: "2027-06-30", precision: "day" },
    quantity: 10,
    unit: "box",
    confirmedUnitsPerPackage: null,
    storageLocation: null,
    openedState: "unopened",
    openedAt: null,
    afterOpeningLimit: null,
    expiryState: { state: "ok", label: "有效期正常" },
    version: 1,
    ...overrides,
  };
}

function medicine(batches) {
  return {
    id: "medicine-1",
    name: "合成药品",
    specification: null,
    manufacturer: null,
    approvalNumber: null,
    activeIngredients: [],
    purposeCategory: null,
    populationTags: [],
    purposeTags: [],
    tagSource: null,
    coverPhotoId: null,
    leaflet: {
      purposeSummary: null,
      packageUsageSummary: null,
      contraindicationsSummary: null,
      precautionsSummary: null,
      source: null,
      reviewStatus: "unverified",
    },
    batches,
    lowStockThreshold: null,
    stockStatus: { state: "ok", quantity: 10, unit: "box" },
    expiryState: { state: "ok", label: "有效期正常" },
    isArchived: false,
    version: 1,
  };
}

function loadDetailPage({ batches, openSplitBatch } = {}) {
  const splits = [];
  const toasts = [];
  const records = batches ?? [batch({ id: "ml-1", quantity: 12.5, unit: "ml" }), batch({ id: "box-1", quantity: 10, unit: "box" })];
  const mod = medicine(records);
  const api = {
    getMedicine: async () => mod,
    listDosageNotes: async () => ({ notes: [] }),
    listLeafletPhotos: async () => ({ photos: [] }),
    openSplitBatch: async (medicineId, batchId, payload) => {
      splits.push({ medicineId, batchId, payload });
      if (openSplitBatch !== undefined) return openSplitBatch(medicineId, batchId, payload);
      return {
        openedBatch: batch({ id: "opened-1", quantity: payload.openedQuantity, unit: payload.unit ?? records.find((item) => item.id === batchId)?.unit ?? "box", openedState: "opened" }),
        remainingBatch: batch({ id: batchId, quantity: 0, version: 2 }),
      };
    },
  };
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api, ApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: {
      showToast(options) { toasts.push(options.title); },
      showModal() {},
    },
  });
  const load = () => {
    const page = makePageContext(definition);
    page.data.medicineId = "medicine-1";
    return page;
  };
  return { definition, load, splits, toasts };
}

test("R08: 毫升批次拆分预览允许小数并守恒", async () => {
  const { load } = loadDetailPage();
  const page = load();
  await page.refresh();
  page.updateOpeningSplitPreview("2.5", "ml-1");
  assert.equal(page.data.openingSplitError, "", "2.5ml 不应报错");
  assert.match(page.data.openingSplitPreview, /2\.5/);
  assert.match(page.data.openingSplitPreview, /10/, "余量应为 12.5-2.5=10");
});

test("R08: 计件单位拆分预览拒绝小数", async () => {
  const { load } = loadDetailPage();
  const page = load();
  await page.refresh();
  page.updateOpeningSplitPreview("2.5", "box-1");
  assert.equal(page.data.openingSplitPreview, "");
  assert.match(page.data.openingSplitError, /整数/);
});

test("R08: 毫升拆分数量需小于当前余量", async () => {
  const { load } = loadDetailPage();
  const page = load();
  await page.refresh();
  page.updateOpeningSplitPreview("13", "ml-1");
  assert.equal(page.data.openingSplitPreview, "");
  assert.match(page.data.openingSplitError, /小于当前余量/);
});

test("R08: 确认毫升拆分携带按单位解析的小数", async () => {
  const { load, splits } = loadDetailPage();
  const page = load();
  await page.refresh();
  page.setData({
    openingSplitBatchId: "ml-1",
    openingSplitQuantity: "2.5",
    openingSplitDate: "2026-10-02",
    openingSplitMode: "none",
    openingSplitValue: "",
    openingSplitSource: "",
  });
  await page.onConfirmOpenSplit();
  assert.equal(splits.length, 1, "毫升小数拆分应可提交");
  assert.equal(splits[0].payload.openedQuantity, 2.5);
  assert.equal(splits[0].payload.confirmed, true);
});

test("R08: 确认计件单位小数拆分被拒绝且不提交", async () => {
  const { load, splits } = loadDetailPage();
  const page = load();
  await page.refresh();
  page.setData({
    openingSplitBatchId: "box-1",
    openingSplitQuantity: "2.5",
    openingSplitDate: "2026-10-02",
    openingSplitMode: "none",
    openingSplitValue: "",
    openingSplitSource: "",
  });
  await page.onConfirmOpenSplit();
  assert.equal(splits.length, 0, "计件单位小数不应提交");
  assert.match(page.data.openingSplitError, /整数/);
});
