import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext } from "./runtime.mjs";

/**
 * R07：药品详情"库存提醒阈值"入口必须复用共享单位/精度表。
 * 复现的缺陷：10ml 阈值被回读成 index0“片”，直接保存变 10 tablet；
 * 小数阈值仍按整数校验被拒。这里验证毫升/板正确回读、按单位解析、
 * 切单位需确认、零与未知分开。
 */

class ApiError extends Error {}

function medicine(overrides = {}) {
  return {
    id: "medicine-1",
    name: "合成感冒药",
    specification: "10片",
    manufacturer: "示例制药厂",
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
    batches: [],
    lowStockThreshold: null,
    stockStatus: { state: "ok", quantity: 2, unit: "box" },
    expiryState: { state: "ok", label: "有效期正常" },
    isArchived: false,
    version: 1,
    ...overrides,
  };
}

function loadDetailPage({ api = {}, wx = {} } = {}) {
  const updates = [];
  const toasts = [];
  const modals = [];
  const defaults = {
    getMedicine: async () => medicine(),
    listDosageNotes: async () => ({ notes: [] }),
    listLeafletPhotos: async () => ({ photos: [] }),
    updateLowStockThreshold: async (id, payload) => { updates.push([id, payload]); return medicine({ version: 2 }); },
  };
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: { ...defaults, ...api }, ApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: {
      showToast(options) { toasts.push(options.title); },
      showModal(options) { modals.push(options); },
      ...wx,
    },
  });
  const load = () => {
    const page = makePageContext(definition);
    page.data.medicineId = "medicine-1";
    return page;
  };
  return { definition, load, updates, toasts, modals };
}

test("R07: 10ml 阈值回读为毫升而不是片", async () => {
  const { load } = loadDetailPage({
    api: { getMedicine: async () => medicine({ lowStockThreshold: { quantity: 10, unit: "ml" } }) },
  });
  const page = load();
  await page.refresh();
  assert.equal(page.data.thresholdEnabled, true);
  assert.equal(page.data.thresholdQuantity, "10");
  const mlIndex = page.data.thresholdUnitValues.indexOf("ml");
  assert.equal(page.data.thresholdUnitIndex, mlIndex, "ml 必须落在共享单位表的 ml 位置");
  assert.equal(page.data.thresholdUnitLabels[page.data.thresholdUnitIndex], "毫升");
});

test("R07: 板(blister)阈值正确回读为板", async () => {
  const { load } = loadDetailPage({
    api: { getMedicine: async () => medicine({ lowStockThreshold: { quantity: 2, unit: "blister" } }) },
  });
  const page = load();
  await page.refresh();
  const blisterIndex = page.data.thresholdUnitValues.indexOf("blister");
  assert.equal(page.data.thresholdUnitIndex, blisterIndex);
  assert.equal(page.data.thresholdUnitLabels[page.data.thresholdUnitIndex], "板");
});

test("R07: 保存 10.5 毫升阈值按单位解析为小数", async () => {
  const { load, updates } = loadDetailPage();
  const page = load();
  await page.refresh();
  page.setData({
    thresholdEnabled: true,
    thresholdQuantity: "10.5",
    thresholdUnitIndex: page.data.thresholdUnitValues.indexOf("ml"),
  });
  await page.onSaveThreshold();
  assert.equal(updates.length, 1, "毫升小数阈值应可提交");
  // 对象在页面 vm 中创建，跨 realm 原型不同，按字段断言而不是 deepEqual。
  assert.equal(updates[0][1].lowStockThreshold.quantity, 10.5);
  assert.equal(updates[0][1].lowStockThreshold.unit, "ml");
});

test("R07: 计件单位阈值拒绝小数并提示整数", async () => {
  const { load, updates, toasts } = loadDetailPage();
  const page = load();
  await page.refresh();
  page.setData({
    thresholdEnabled: true,
    thresholdQuantity: "10.5",
    thresholdUnitIndex: page.data.thresholdUnitValues.indexOf("tablet"),
  });
  await page.onSaveThreshold();
  assert.equal(updates.length, 0, "片不允许小数");
  assert.match(toasts[0], /整数/);
});

test("R07: 关闭阈值＝未知(null)，开启填 0＝阈值 0，两者分开", async () => {
  const { load, updates } = loadDetailPage();
  const page = load();
  await page.refresh();

  page.setData({ thresholdEnabled: false });
  await page.onSaveThreshold();
  assert.equal(updates[0][1].lowStockThreshold, null, "关闭＝未知");

  updates.length = 0;
  page.setData({
    thresholdEnabled: true,
    thresholdQuantity: "0",
    thresholdUnitIndex: page.data.thresholdUnitValues.indexOf("tablet"),
  });
  await page.onSaveThreshold();
  assert.equal(updates[0][1].lowStockThreshold.quantity, 0, "开启填 0＝阈值 0");
  assert.equal(updates[0][1].lowStockThreshold.unit, "tablet");
});

test("R07: 已有数值时切换单位需确认，取消保持原单位", async () => {
  const { load, modals } = loadDetailPage();
  const page = load();
  await page.refresh();
  const mlIndex = page.data.thresholdUnitValues.indexOf("ml");
  const tabletIndex = page.data.thresholdUnitValues.indexOf("tablet");
  page.setData({ thresholdQuantity: "10", thresholdUnitIndex: mlIndex });

  page.onThresholdUnitChange({ detail: { value: tabletIndex } });
  assert.equal(modals.length, 1, "已填数值切单位应弹确认");
  assert.equal(page.data.thresholdUnitIndex, mlIndex, "确认前不切换");

  modals[0].success({ confirm: true });
  assert.equal(page.data.thresholdUnitIndex, tabletIndex, "确认后切换");
});

test("R07: 数值为空时切换单位不弹确认直接生效", async () => {
  const { load, modals } = loadDetailPage();
  const page = load();
  await page.refresh();
  const mlIndex = page.data.thresholdUnitValues.indexOf("ml");
  const tabletIndex = page.data.thresholdUnitValues.indexOf("tablet");
  page.setData({ thresholdQuantity: "", thresholdUnitIndex: mlIndex });

  page.onThresholdUnitChange({ detail: { value: tabletIndex } });
  assert.equal(modals.length, 0, "空值切单位无需确认");
  assert.equal(page.data.thresholdUnitIndex, tabletIndex);
});

test("R07: 选择单位不变时不弹确认", async () => {
  const { load, modals } = loadDetailPage();
  const page = load();
  await page.refresh();
  const mlIndex = page.data.thresholdUnitValues.indexOf("ml");
  page.setData({ thresholdQuantity: "10", thresholdUnitIndex: mlIndex });
  page.onThresholdUnitChange({ detail: { value: mlIndex } });
  assert.equal(modals.length, 0);
  assert.equal(page.data.thresholdUnitIndex, mlIndex);
});
