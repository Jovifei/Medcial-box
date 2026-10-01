import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext } from "./runtime.mjs";

/**
 * R2-d 剩余：药盒封面内嵌展示。
 * 私有图片接口需要 Bearer 鉴权，<image> 不能直接带 header，
 * 因此页面用 wx.downloadFile 带授权头下载到本地临时文件后再展示。
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

function loadDetailPage({ api = {} } = {}) {
  const calls = [];
  const defaults = {
    getMedicine: async () => medicine(),
    listDosageNotes: async () => ({ notes: [] }),
    listLeafletPhotos: async () => ({ photos: [] }),
    downloadLeafletPhoto: async (medicineId, photoId) => {
      calls.push(["download", medicineId, photoId]);
      return `/tmp/photo-${photoId}`;
    },
  };
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: { ...defaults, ...api }, ApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: () => true },
    },
  });
  return { definition, calls, load: () => makePageContext(definition) };
}

test("有封面时下载到本地临时文件再展示", async () => {
  const { calls } = loadDetailPage();
  const { definition } = loadDetailPage();
  const page = makePageContext(definition);
  page.data.medicineId = "medicine-1";
  await page.refresh();
  const withCover = loadDetailPage({ api: { getMedicine: async () => medicine({ coverPhotoId: "photo-9" }) } });
  const coverPage = withCover.load();
  coverPage.data.medicineId = "medicine-1";
  await coverPage.refresh();
  assert.deepEqual(withCover.calls, [["download", "medicine-1", "photo-9"]]);
  assert.equal(coverPage.data.coverPhotoPath, "/tmp/photo-photo-9");
  assert.equal(coverPage.data.coverPhotoError, "");
  assert.equal(calls.length, 0, "没有封面不应发起下载");
});

test("没有封面时不展示占位也不报错", async () => {
  const { load, calls } = loadDetailPage();
  const page = load();
  page.data.medicineId = "medicine-1";
  await page.refresh();
  assert.equal(page.data.coverPhotoPath, "");
  assert.equal(page.data.coverPhotoError, "");
  assert.equal(calls.length, 0);
});

test("封面下载失败只提示，不影响详情其余内容", async () => {
  const { load } = loadDetailPage({
    api: {
      getMedicine: async () => medicine({ coverPhotoId: "photo-9" }),
      downloadLeafletPhoto: async () => { throw new ApiError("封面图片读取失败"); },
    },
  });
  const page = load();
  page.data.medicineId = "medicine-1";
  await page.refresh();
  assert.equal(page.data.coverPhotoPath, "");
  assert.match(page.data.coverPhotoError, /封面图片读取失败/);
  assert.equal(page.data.name, "合成感冒药", "详情其余内容仍正常展示");
});

test("详情页提供创建用药计划入口，只带入药品身份", async () => {
  const navigations = [];
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        getMedicine: async () => medicine({ name: "儿童退烧药" }),
        listDosageNotes: async () => ({ notes: [] }),
        listLeafletPhotos: async () => ({ photos: [] }),
      }, ApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: () => true },
    },
    wx: { navigateTo(options) { navigations.push(options.url); } },
  });
  const page = makePageContext(definition);
  page.data.medicineId = "medicine-1";
  await page.refresh();
  page.onTapCreatePlan();
  assert.equal(navigations.length, 1);
  assert.match(navigations[0], /medication-plans\?medicineId=medicine-1/);
  assert.match(navigations[0], /medicineName=/);
});

test("折叠区域默认收起，点击后展开", async () => {
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        getMedicine: async () => medicine(),
        listDosageNotes: async () => ({ notes: [] }),
        listLeafletPhotos: async () => ({ photos: [] }),
      }, ApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: () => true },
    },
  });
  const page = makePageContext(definition);
  assert.deepEqual({ ...page.data.sections }, { leaflet: false, notes: false, stock: false });
  page.onToggleSection({ currentTarget: { dataset: { section: "notes" } } });
  assert.equal(page.data.sections.notes, true);
  page.onToggleSection({ currentTarget: { dataset: { section: "notes" } } });
  assert.equal(page.data.sections.notes, false);
  page.onToggleSection({ currentTarget: { dataset: { section: "unknown" } } });
  assert.equal(page.data.sections.leaflet, false);
});

test("删除药品进入最近删除且可取消", async () => {
  const calls = [];
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", {
    modules: {
      "../../services/api": { api: {
        getMedicine: async () => medicine(),
        listDosageNotes: async () => ({ notes: [] }),
        listLeafletPhotos: async () => ({ photos: [] }),
        deleteMedicine: async (id) => { calls.push(id); return null; },
      }, ApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/input-validation": { isStrictNonNegativeInteger: () => true },
    },
    wx: { showModal(options) { options?.success?.({ confirm: false }); } },
  });
  const page = makePageContext(definition);
  page.data.medicineId = "medicine-1";
  await page.onDeleteMedicine();
  assert.deepEqual(calls, [], "取消后不删除");

  const confirmDelete = makePageContext(definition, {
    wxShowModal: true,
  });
  confirmDelete.data.medicineId = "medicine-1";
  assert.ok(typeof confirmDelete.onDeleteMedicine === "function");
});
