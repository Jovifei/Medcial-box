import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext } from "./runtime.mjs";

/**
 * R3-b 计划详情页用例：历史与纠正展示、编辑只影响未来、版本冲突不覆盖、
 * 权限不足时只读。
 */

class ApiError extends Error {}

function plan(overrides = {}) {
  return {
    id: "plan-1",
    careProfileId: "profile-1",
    careProfileName: "孩子",
    medicineId: null,
    medicineName: "儿童退烧药",
    dosageText: "每次 5ml",
    weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    startDate: "2026-10-01",
    endDate: null,
    status: "active",
    version: 3,
    timeSlots: ["08:00", "20:00"],
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    occurrenceId: "occ-1",
    date: "2026-10-01",
    time: "08:00",
    status: "skipped",
    corrected: true,
    events: [
      { action: "taken", actor: "妈妈", at: "2026-10-01 08:05" },
      { action: "skipped", actor: "爸爸", at: "2026-10-01 08:40" },
    ],
    ...overrides,
  };
}

function loadPlanDetailPage({ api = {}, wx = {} } = {}) {
  const calls = [];
  const modals = [];
  const toasts = [];
  const alerts = [];
  const draftGuard = { registered: [], cleared: 0 };
  const state = {
    detail: { plan: plan(), canManage: true },
    history: { planId: "plan-1", medicineName: "儿童退烧药", history: [record()] },
  };
  const defaults = {
    getMedicationPlan: async (planId) => { calls.push(["detail", planId]); return state.detail; },
    getMedicationPlanHistory: async (planId) => { calls.push(["history", planId]); return state.history; },
    updateMedicationPlan: async (planId, payload) => {
      calls.push(["update", planId, payload]);
      return { planId, version: payload.version + 1, timeSlots: payload.timeSlots ?? [], note: "修改只影响之后的安排，已有服药记录保持不变" };
    },
    changeMedicationPlanStatus: async (planId, action, version) => {
      calls.push(["status", planId, action, version]);
      return { planId, status: action === "pause" ? "paused" : "ended", version: version + 1 };
    },
  };
  const { definition } = loadPage("pages/plan-detail/plan-detail.ts", {
    modules: {
      "../../services/api": { api: { ...defaults, ...api }, ApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/draft-guard": {
        registerDirtyDraft: (draft) => { draftGuard.registered.push(draft); },
        clearDirtyDraft: () => { draftGuard.cleared += 1; },
      },
    },
    wx: {
      showModal(options) { modals.push(options); options?.success?.({ confirm: true }); },
      showToast(options) { toasts.push(options.title); },
      navigateBack() {},
      enableAlertBeforeUnload(options) { alerts.push(["enable", options?.message]); },
      disableAlertBeforeUnload() { alerts.push(["disable"]); },
      ...wx,
    },
  });
  return { definition, state, calls, modals, toasts, alerts, draftGuard, load: () => makePageContext(definition) };
}

test("详情页展示计划摘要与纠正过的服药记录", async () => {
  const { load } = loadPlanDetailPage();
  const page = load();
  await page.onLoad({ planId: "plan-1" });
  assert.equal(page.data.plan.medicineName, "儿童退烧药");
  assert.equal(page.data.weekdayText, "每天");
  assert.equal(page.data.slotText, "08:00 / 20:00", "R17：时间点文案在 TS 预计算");
  assert.equal(page.data.rangeText, "2026-10-01 起（长期）");
  assert.equal(page.data.history.length, 1);
  assert.equal(page.data.history[0].statusLabel, "本次跳过");
  assert.equal(page.data.history[0].eventText, "已服用 · 妈妈 → 跳过 · 爸爸");
  assert.equal(page.data.history[0].corrected, true);
  assert.equal(page.data.canManage, true);
});

test("缺少计划标识时不发起请求并给出提示", async () => {
  const { load, calls } = loadPlanDetailPage();
  const page = load();
  await page.onLoad({});
  assert.equal(calls.length, 0);
  assert.match(page.data.errorMessage, /缺少计划标识/);
});

test("编辑只提交改动并提示只影响之后", async () => {
  const { load, calls, modals, toasts } = loadPlanDetailPage();
  const page = load();
  await page.onLoad({ planId: "plan-1" });
  page.onStartEdit();
  assert.equal(page.data.editing, true);
  page.data.timeInput = "21:30";
  page.onAddTimeSlot();
  assert.deepEqual([...page.data.timeSlots], ["08:00", "20:00", "21:30"]);
  await page.onSubmitEdit();
  const update = calls.find(([kind]) => kind === "update");
  assert.ok(update);
  assert.equal(update[2].version, 3, "编辑必须带当前版本号");
  assert.deepEqual([...update[2].timeSlots], ["08:00", "20:00", "21:30"]);
  assert.equal(update[2].endDate, null, "长期计划结束日期传 null");
  assert.equal(modals.length, 1);
  assert.match(modals[0].content, /只影响之后的安排/);
  assert.equal(page.data.editing, false);
  assert.ok(toasts.includes("已保存"));
});

test("版本冲突时不覆盖他人修改，改为刷新", async () => {
  const { load, toasts } = loadPlanDetailPage({
    api: {
      updateMedicationPlan: async () => {
        const error = new ApiError("版本冲突");
        error.code = "VERSION_CONFLICT";
        throw error;
      },
    },
  });
  const page = load();
  await page.onLoad({ planId: "plan-1" });
  page.onStartEdit();
  await page.onSubmitEdit();
  assert.equal(page.data.editing, false, "冲突后退出编辑态");
  assert.ok(toasts.includes("计划已被他人修改，已刷新"));
});

test("结束日期早于开始日期时阻止保存", async () => {
  const { load, calls } = loadPlanDetailPage();
  const page = load();
  await page.onLoad({ planId: "plan-1" });
  page.onStartEdit();
  page.setData({ startDate: "2026-10-10", endDate: "2026-10-01" });
  await page.onSubmitEdit();
  assert.equal(calls.some(([kind]) => kind === "update"), false);
});

test("暂停携带版本号；已结束的计划不能恢复", async () => {
  const { load, calls } = loadPlanDetailPage();
  const page = load();
  await page.onLoad({ planId: "plan-1" });
  await page.onChangeStatus({ currentTarget: { dataset: { action: "pause" } } });
  assert.deepEqual(calls.find(([kind]) => kind === "status"), ["status", "plan-1", "pause", 3]);

  const ended = loadPlanDetailPage();
  ended.state.detail = { plan: plan({ status: "ended", version: 5 }), canManage: true };
  const endedPage = ended.load();
  await endedPage.onLoad({ planId: "plan-1" });
  assert.equal(endedPage.data.statusLabel, "已结束");
  await endedPage.onChangeStatus({ currentTarget: { dataset: { action: "resume" } } });
  assert.equal(ended.calls.some(([kind]) => kind === "status"), false, "已结束的计划不能再恢复");
});

test("只有查看权限时不暴露修改入口", async () => {
  const { load, state } = loadPlanDetailPage();
  state.detail = { plan: plan(), canManage: false };
  const page = load();
  await page.onLoad({ planId: "plan-1" });
  assert.equal(page.data.canManage, false);
  page.onStartEdit();
  assert.equal(page.data.editing, false, "无管理权限不能进入编辑");
});

test("R14：编辑改动后登记草稿守卫并开启原生离开提示，保存成功后释放", async () => {
  const { load, draftGuard, alerts } = loadPlanDetailPage();
  const page = load();
  await page.onLoad({ planId: "plan-1" });
  page.onStartEdit();
  assert.equal(draftGuard.registered.length, 0, "刚进入编辑但未改动不应登记草稿");
  page.onEditInput({ currentTarget: { dataset: { field: "dosageText" } }, detail: { value: "每次 10ml" } });
  assert.equal(draftGuard.registered.length, 1, "改动后登记草稿守卫");
  assert.match(draftGuard.registered[0].label, /未保存/);
  assert.ok(alerts.some(([kind]) => kind === "enable"), "改动后开启原生离开提示");
  await page.onSubmitEdit();
  assert.ok(draftGuard.cleared >= 1, "保存成功后清除草稿守卫");
  assert.ok(alerts.some(([kind]) => kind === "disable"), "保存成功后关闭离开提示");
});

test("R14：草稿守卫的保存动作直接提交编辑，供更新重启前调用", async () => {
  const { load, calls, draftGuard } = loadPlanDetailPage();
  const page = load();
  await page.onLoad({ planId: "plan-1" });
  page.onStartEdit();
  page.onEditInput({ currentTarget: { dataset: { field: "dosageText" } }, detail: { value: "每次 10ml" } });
  const draft = draftGuard.registered.at(-1);
  assert.ok(draft, "改动后应有已登记的草稿");
  await draft.save();
  const update = calls.find(([kind]) => kind === "update");
  assert.ok(update, "草稿保存真正调用更新接口，而不是只提示");
  assert.equal(update[2].dosageText, "每次 10ml");
  assert.equal(update[2].version, 3, "草稿保存也带当前版本号");
});

test("R14：草稿保存失败时抛错，交由更新链路延期，不静默丢弃", async () => {
  const { load, draftGuard } = loadPlanDetailPage({
    api: {
      updateMedicationPlan: async () => {
        const error = new ApiError("网络异常");
        throw error;
      },
    },
  });
  const page = load();
  await page.onLoad({ planId: "plan-1" });
  page.onStartEdit();
  page.onEditInput({ currentTarget: { dataset: { field: "dosageText" } }, detail: { value: "每次 10ml" } });
  const draft = draftGuard.registered.at(-1);
  await assert.rejects(() => draft.save(), /网络异常/);
});

test("R14：取消编辑释放草稿守卫并关闭离开提示", async () => {
  const { load, draftGuard, alerts } = loadPlanDetailPage();
  const page = load();
  await page.onLoad({ planId: "plan-1" });
  page.onStartEdit();
  page.onEditInput({ currentTarget: { dataset: { field: "dosageText" } }, detail: { value: "每次 10ml" } });
  assert.equal(draftGuard.registered.length, 1);
  const clearedBefore = draftGuard.cleared;
  page.onCancelEdit();
  assert.equal(draftGuard.cleared, clearedBefore + 1, "取消编辑清除草稿守卫");
  assert.ok(alerts.some(([kind]) => kind === "disable"), "取消编辑关闭离开提示");
  assert.equal(page.data.editing, false);
});

test("R14：卸载页面时释放草稿守卫", async () => {
  const { load, draftGuard } = loadPlanDetailPage();
  const page = load();
  await page.onLoad({ planId: "plan-1" });
  page.onStartEdit();
  page.onEditInput({ currentTarget: { dataset: { field: "dosageText" } }, detail: { value: "每次 10ml" } });
  const clearedBefore = draftGuard.cleared;
  page.onUnload();
  assert.equal(draftGuard.cleared, clearedBefore + 1, "onUnload 释放草稿守卫");
});
