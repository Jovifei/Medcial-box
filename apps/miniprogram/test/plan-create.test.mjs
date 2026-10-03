import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext } from "./runtime.mjs";

/**
 * R12 独立创建用药计划页用例：
 * - 用药计划是 tabBar 页，navigateTo 打不开也不能带参；创建流程独立成非 tab 页；
 * - 从药品详情只带入药品身份，剂量与时间仍手填；
 * - 第一位使用者自动创建“我自己”照护对象；
 * - 保存成功后用 switchTab 回到底部导航页，而不是 navigateTo。
 */

class ApiError extends Error {}

const TAB_BAR_PAGES = new Set([
  "/pages/index/index",
  "/pages/medication-plans/medication-plans",
  "/pages/pending/pending",
  "/pages/mine/mine",
]);

function shanghaiDate(offsetDays) {
  const shanghai = new Date(Date.now() + 8 * 3600 * 1000);
  const shifted = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function loadCreatePage({ api = {}, wx = {} } = {}) {
  const calls = [];
  const toasts = [];
  const switchTabs = [];
  const navigations = [];
  const alerts = [];
  const draftGuard = { registered: [], cleared: 0 };
  const state = {
    careProfiles: [{ id: "profile-1", displayName: "我自己", linkedUserId: "user-1", isPrivate: true, canManage: true }],
  };
  const defaults = {
    listCareProfiles: async () => { calls.push(["profiles"]); return { careProfiles: state.careProfiles }; },
    ensureSelfCareProfile: async (displayName) => {
      calls.push(["ensureSelfProfile", displayName]);
      const profile = { id: "profile-self", displayName: displayName ?? "我", linkedUserId: "user-1", isPrivate: true };
      state.careProfiles = [profile];
      return profile;
    },
    createCareProfile: async (payload) => { calls.push(["createProfile", payload]); return { id: "profile-x", displayName: payload.displayName }; },
    createMedicationPlan: async (payload) => { calls.push(["createPlan", payload]); return { planId: "plan-new", careProfileId: payload.careProfileId, status: "active", version: 1 }; },
  };
  const { definition } = loadPage("pages/plan-create/plan-create.ts", {
    modules: {
      "../../services/api": { api: { ...defaults, ...api }, ApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/draft-guard": {
        registerDirtyDraft: (draft) => { draftGuard.registered.push(draft); },
        clearDirtyDraft: () => { draftGuard.cleared += 1; },
      },
    },
    wx: {
      showToast(options) { toasts.push(options.title); },
      switchTab(options) { switchTabs.push(options.url); options?.success?.({}); },
      // 遵守真实限制：navigateTo 到 tabBar 页会失败，用来抓回归。
      navigateTo(options) {
        const blocked = TAB_BAR_PAGES.has((options?.url ?? "").split("?")[0]);
        navigations.push({ url: options?.url, blocked });
        if (blocked) { options?.fail?.({ errMsg: "navigateTo:fail can not navigate to a tabbar page" }); return; }
        options?.success?.({});
      },
      navigateBack(options) { options?.success?.({}); },
      enableAlertBeforeUnload(options) { alerts.push(["enable", options?.message]); },
      disableAlertBeforeUnload() { alerts.push(["disable"]); },
      ...wx,
    },
  });
  return { definition, state, calls, toasts, switchTabs, navigations, alerts, draftGuard, load: () => makePageContext(definition) };
}

test("从药品详情只带入药品身份，剂量与时间仍需手填", async () => {
  const { load, calls } = loadCreatePage();
  const page = load();
  page.onLoad({ medicineId: "medicine-7", medicineName: "儿童退烧药" });
  assert.equal(page.data.medicineId, "medicine-7");
  assert.equal(page.data.medicineName, "儿童退烧药");
  assert.equal(page.data.dosageText, "", "剂量不自动推导");
  assert.deepEqual([...page.data.timeSlots], [], "时间点不自动推导");

  await page.bootstrap();
  page.setData({ dosageText: "每次 5ml", timeSlots: ["08:00"] });
  await page.onSubmitPlan();
  const payload = calls.find(([kind]) => kind === "createPlan")[1];
  assert.equal(payload.medicineId, "medicine-7");
});

test("创建时间点校验格式、去重与上限", async () => {
  const { load, toasts } = loadCreatePage();
  const page = load();
  await page.bootstrap();

  page.data.timeInput = "8:5";
  page.onAddTimeSlot();
  assert.equal(page.data.timeSlots.length, 0, "非法时间不入库");

  page.data.timeInput = "08:00";
  page.onAddTimeSlot();
  page.data.timeInput = "08:00";
  page.onAddTimeSlot();
  assert.deepEqual([...page.data.timeSlots], ["08:00"], "重复时间点不入库");

  for (const time of ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"]) {
    page.data.timeInput = time;
    page.onAddTimeSlot();
  }
  assert.equal(page.data.timeSlots.length, 6, "每日最多 6 个时间点");
  assert.ok(toasts.includes("每日最多 6 个时间点"));
});

test("指定星期但未选任何一天时阻止提交", async () => {
  const { load, calls, toasts } = loadCreatePage();
  const page = load();
  await page.bootstrap();
  page.setData({ medicineName: "儿童退烧药", dosageText: "每次 5ml", timeSlots: ["08:00"], everyDay: false, selectedWeekdays: [] });
  await page.onSubmitPlan();
  assert.equal(calls.some(([kind]) => kind === "createPlan"), false);
  assert.ok(toasts.includes("指定星期需至少选择一天，或改回每天"));
});

test("结束日期早于开始日期时阻止提交", async () => {
  const { load, calls, toasts } = loadCreatePage();
  const page = load();
  await page.bootstrap();
  page.setData({
    medicineName: "儿童退烧药",
    dosageText: "每次 5ml",
    timeSlots: ["08:00"],
    startDate: "2026-10-10",
    endDate: "2026-10-01",
  });
  await page.onSubmitPlan();
  assert.equal(calls.some(([kind]) => kind === "createPlan"), false);
  assert.ok(toasts.includes("结束日期不能早于开始日期"));
});

test("第一位使用者自动创建“我自己”照护对象", async () => {
  const { load, state, calls } = loadCreatePage();
  state.careProfiles = [];
  const page = load();
  await page.bootstrap();
  const created = calls.find(([kind]) => kind === "ensureSelfProfile");
  assert.ok(created, "应调用 ensureSelfCareProfile 而非旧的 createCareProfile");
  assert.equal(created[1], "我自己");
  assert.equal(calls.some(([kind]) => kind === "createProfile"), false, "不得走客户端猜测身份的旧接口");
  assert.equal(page.data.careProfiles.length, 1);
  assert.equal(page.data.careProfileIndex, 0);
});

test("保存成功后用 switchTab 回到用药计划页，绝不 navigateTo 底部导航页", async () => {
  const { load, switchTabs, navigations } = loadCreatePage();
  const page = load();
  await page.bootstrap();
  page.setData({ medicineName: "儿童退烧药", dosageText: "每次 5ml", timeSlots: ["08:00"] });
  await page.onSubmitPlan();
  assert.deepEqual([...switchTabs], ["/pages/medication-plans/medication-plans"], "tabBar 页只能用 switchTab 到达");
  assert.equal(navigations.some((item) => item.blocked), false, "不得出现 navigateTo 底部导航页");
});

test("照护对象加载失败时如实报错，不静默空白", async () => {
  const { load } = loadCreatePage({
    api: { listCareProfiles: async () => { throw new ApiError("网络异常"); } },
  });
  const page = load();
  await page.bootstrap();
  assert.equal(page.data.errorMessage, "网络异常");
  assert.equal(page.data.loading, false);
});

test("起始日期默认为今天", () => {
  const { load } = loadCreatePage();
  const page = load();
  assert.equal(page.data.startDate, shanghaiDate(0));
});

test("R14：带入药品名或手填内容后登记草稿守卫并开启离开提示", () => {
  const { load, draftGuard, alerts } = loadCreatePage();
  const page = load();
  page.onLoad({ medicineName: "儿童退烧药" });
  assert.equal(draftGuard.registered.length, 1, "带入药品名即视为有未保存内容");
  assert.match(draftGuard.registered[0].label, /未保存/);
  assert.ok(alerts.some(([kind]) => kind === "enable"), "开启原生返回确认");
});

test("R14：空表单进入不登记草稿、不拦截返回", () => {
  const { load, draftGuard, alerts } = loadCreatePage();
  const page = load();
  page.onLoad({});
  assert.equal(draftGuard.registered.length, 0, "没有任何输入时不应登记草稿");
  assert.equal(alerts.some(([kind]) => kind === "enable"), false);
});

test("R14：保存成功后清除草稿守卫并关闭离开提示", async () => {
  const { load, draftGuard, alerts } = loadCreatePage();
  const page = load();
  await page.bootstrap();
  page.onFormInput({ currentTarget: { dataset: { field: "medicineName" } }, detail: { value: "儿童退烧药" } });
  page.onFormInput({ currentTarget: { dataset: { field: "dosageText" } }, detail: { value: "每次 5ml" } });
  page.data.timeInput = "08:00";
  page.onAddTimeSlot();
  assert.ok(draftGuard.registered.length >= 1);
  await page.onSubmitPlan();
  assert.ok(draftGuard.cleared >= 1, "保存成功后清除草稿守卫");
  assert.ok(alerts.some(([kind]) => kind === "disable"), "保存成功后关闭离开提示");
});

test("R14：草稿守卫的保存动作直接创建计划，供更新重启前调用", async () => {
  const { load, calls, draftGuard } = loadCreatePage();
  const page = load();
  await page.bootstrap();
  page.onFormInput({ currentTarget: { dataset: { field: "medicineName" } }, detail: { value: "儿童退烧药" } });
  page.onFormInput({ currentTarget: { dataset: { field: "dosageText" } }, detail: { value: "每次 5ml" } });
  page.data.timeInput = "08:00";
  page.onAddTimeSlot();
  const draft = draftGuard.registered.at(-1);
  assert.ok(draft, "应有已登记的草稿");
  await draft.save();
  assert.ok(calls.some(([kind]) => kind === "createPlan"), "草稿保存真正调用创建接口");
});

test("R14：保存失败时不清除草稿，延期到用户处理", async () => {
  const { load, draftGuard, toasts } = loadCreatePage({
    api: { createMedicationPlan: async () => { throw new ApiError("网络异常"); } },
  });
  const page = load();
  await page.bootstrap();
  page.onFormInput({ currentTarget: { dataset: { field: "medicineName" } }, detail: { value: "儿童退烧药" } });
  page.onFormInput({ currentTarget: { dataset: { field: "dosageText" } }, detail: { value: "每次 5ml" } });
  page.data.timeInput = "08:00";
  page.onAddTimeSlot();
  const clearedBefore = draftGuard.cleared;
  await page.onSubmitPlan();
  assert.equal(draftGuard.cleared, clearedBefore, "保存失败不得清除草稿");
  // 注入的 ApiError 来自测试 realm，页面 vm 里 instanceof Error 不成立，
  // 会回落到通用失败文案；R14 关注的是"失败不清草稿"，故只断言给出了失败提示。
  assert.ok(toasts.some((title) => /失败|网络异常/.test(title)), "保存失败要如实提示");
});

test("R14：草稿保存失败时抛错，交由更新链路延期", async () => {
  const { load, draftGuard } = loadCreatePage({
    api: { createMedicationPlan: async () => { throw new ApiError("网络异常"); } },
  });
  const page = load();
  await page.bootstrap();
  page.onFormInput({ currentTarget: { dataset: { field: "medicineName" } }, detail: { value: "儿童退烧药" } });
  page.onFormInput({ currentTarget: { dataset: { field: "dosageText" } }, detail: { value: "每次 5ml" } });
  page.data.timeInput = "08:00";
  page.onAddTimeSlot();
  const draft = draftGuard.registered.at(-1);
  await assert.rejects(() => draft.save(), /网络异常/);
});

test("R14：取消或卸载页面时释放草稿守卫", () => {
  const cancel = loadCreatePage();
  const cancelPage = cancel.load();
  cancelPage.onLoad({ medicineName: "儿童退烧药" });
  cancelPage.onCancel();
  assert.equal(cancelPage.data.leaveSheetVisible, true);
  cancelPage.onLeaveChoice({ currentTarget: { dataset: { choice: "discard" } } });
  assert.ok(cancel.draftGuard.cleared >= 1, "取消离开清除草稿守卫");
  assert.ok(cancel.alerts.some(([kind]) => kind === "disable"));

  const unload = loadCreatePage();
  const unloadPage = unload.load();
  unloadPage.onLoad({ medicineName: "儿童退烧药" });
  unloadPage.onUnload();
  assert.ok(unload.draftGuard.cleared >= 1, "onUnload 释放草稿守卫");
});
