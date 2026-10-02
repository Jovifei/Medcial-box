import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, loadService, makePageContext } from "./runtime.mjs";

/**
 * R3-b 用药计划页用例：
 * - 今日安排：时间升序、状态只用文字、过了时间显示"未确认"而不判定漏服；
 * - 记录动作带幂等键，纠正已有记录前先确认；
 * - 暂停/恢复带版本号，版本冲突时刷新而不是覆盖；
 * - 创建计划的时间点/星期校验与首个照护对象自动创建。
 */

/** 页面在独立 vm 中运行，抛出这个类的实例才能被 `instanceof ApiError` 识别。 */
class ApiError extends Error {}

function shanghaiDate(offsetDays) {
  const shanghai = new Date(Date.now() + 8 * 3600 * 1000);
  const shifted = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function entry(overrides = {}) {
  return {
    occurrenceId: "occ-1",
    planId: "plan-1",
    careProfileId: "profile-1",
    careProfileName: "我自己",
    medicineName: "儿童退烧药",
    dosageText: "每次 5ml",
    time: "08:00",
    status: "pending",
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    id: "plan-1",
    careProfileId: "profile-1",
    careProfileName: "我自己",
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

function loadPlansPage({ api = {}, wx = {} } = {}) {
  const calls = [];
  const modals = [];
  const toasts = [];
  const navigations = [];
  const state = {
    date: shanghaiDate(0),
    entries: [] ,
    plans: [],
    careProfiles: [{ id: "profile-1", displayName: "我自己", linkedUserId: "user-1", isPrivate: true, canManage: true }],
  };
  const defaults = {
    getMedicationSchedule: async (date) => {
      calls.push(["schedule", date]);
      return { date: date ?? state.date, entries: state.entries };
    },
    listMedicationPlans: async () => { calls.push(["plans"]); return { plans: state.plans }; },
    listCareProfiles: async () => { calls.push(["profiles"]); return { careProfiles: state.careProfiles }; },
    createCareProfile: async (payload) => { calls.push(["createProfile", payload]); return { id: "profile-self", displayName: payload.displayName, linkedUserId: "user-1", isPrivate: true }; },
    // R19：本人档案由服务端绑定当前身份（幂等），替身按真实接口语义返回——
    // 不接收 linkedUserId 入参，返回值绑定当前用户且标记私有。
    ensureSelfCareProfile: async (displayName) => {
      calls.push(["ensureSelfProfile", displayName]);
      return { id: "profile-self", displayName: displayName ?? "我", linkedUserId: "user-1", isPrivate: true };
    },
    createMedicationPlan: async (payload) => { calls.push(["createPlan", payload]); return { planId: "plan-new", careProfileId: payload.careProfileId, status: "active", version: 1 }; },
    changeMedicationPlanStatus: async (planId, action, version) => { calls.push(["status", planId, action, version]); return { planId, status: action === "pause" ? "paused" : "active", version: version + 1 }; },
    getDoseReminderStatus: async () => {
      calls.push(["reminderStatus"]);
      return state.reminder ?? { available: false, reason: "服药提醒模板尚未配置", templateId: "", deliveries: [] };
    },
    subscribeToNotifications: async (ids) => { calls.push(["subscribe", ids]); return { acceptedTemplateIds: ids }; },
    confirmDoseOccurrence: async (occurrenceId, action, idempotencyKey) => {
      calls.push(["confirm", occurrenceId, action, idempotencyKey]);
      return { occurrenceId, status: action, replayed: false };
    },
  };
  const { definition } = loadPage("pages/medication-plans/medication-plans.ts", {
    modules: {
      "../../services/api": { api: { ...defaults, ...api }, ApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: {
      showModal(options) {
        modals.push(options);
        options?.success?.({ confirm: options?.__confirm ?? true });
      },
      showToast(options) { toasts.push(options.title); },
      navigateTo(options) { navigations.push(options.url); },
      ...wx,
    },
  });
  return { definition, state, calls, modals, toasts, navigations, load: () => makePageContext(definition) };
}

test("今日安排按时间升序排列，状态只用文字呈现", async () => {
  const { load, state, calls } = loadPlansPage();
  state.entries = [
    entry({ occurrenceId: "occ-2", time: "20:00", status: "taken" }),
    entry({ occurrenceId: "occ-1", time: "08:00", status: "pending" }),
    entry({ occurrenceId: "occ-3", time: "12:30", status: "skipped" }),
  ];
  const page = load();
  await page.refresh();
  const rows = [...page.data.entries];
  assert.deepEqual(rows.map((item) => item.time), ["08:00", "12:30", "20:00"]);
  assert.deepEqual(rows.map((item) => item.statusLabel), ["未确认", "本次跳过", "已服用"]);
  assert.deepEqual(rows.map((item) => item.statusClass), ["pending", "skipped", "taken"]);
  assert.equal(calls.some(([kind]) => kind === "schedule"), true);
  assert.equal(page.data.errorMessage, "");
});

test("过了时间没有记录只提示未确认，不判定漏服；未来日期不标记逾期", async () => {
  const { load, state } = loadPlansPage();
  const page = load();
  page.data.date = shanghaiDate(-1);
  state.entries = [entry({ time: "08:00", status: "pending" })];
  await page.refresh();
  assert.equal(page.data.entries[0].statusLabel, "未确认");
  assert.equal(page.data.entries[0].overdue, true);

  page.data.date = shanghaiDate(2);
  await page.refresh();
  assert.equal(page.data.entries[0].overdue, false, "未来日期不应标记逾期");
  assert.equal(page.data.entries[0].statusLabel, "未确认");
});

test("记录服用带幂等键，且同一动作不会因重试产生第二条记录", async () => {
  const { load, state, calls } = loadPlansPage();
  state.entries = [entry({ occurrenceId: "occ-9", status: "pending" })];
  const page = load();
  await page.refresh();
  await page.onConfirmDose({ currentTarget: { dataset: { id: "occ-9", action: "taken" } } });
  const confirm = calls.find(([kind]) => kind === "confirm");
  assert.ok(confirm);
  assert.equal(confirm[1], "occ-9");
  assert.equal(confirm[2], "taken");
  assert.match(confirm[3], /^dose-occ-9-\d+$/, "幂等键必须由操作本身生成");
  assert.equal(page.data.confirmingId, "", "操作结束后必须解除按钮忙状态");
});

test("纠正已有记录前先弹确认，取消则不写入", async () => {
  const { load, state, calls, modals } = loadPlansPage({
    wx: {
      showModal(options) {
        modals.push(options);
        options?.success?.({ confirm: false });
      },
    },
  });
  state.entries = [entry({ occurrenceId: "occ-7", status: "taken" })];
  const page = load();
  await page.refresh();
  await page.onConfirmDose({ currentTarget: { dataset: { id: "occ-7", action: "skipped" } } });
  assert.equal(modals.length, 1, "纠正必须二次确认");
  assert.match(modals[0].title, /纠正/);
  assert.equal(calls.some(([kind]) => kind === "confirm"), false, "取消后不应写入");
});

test("暂停与恢复携带版本号，版本冲突时刷新而不是覆盖", async () => {
  const { load, state, calls, toasts } = loadPlansPage({
    api: {
      changeMedicationPlanStatus: async (planId, action, version) => {
        calls.push(["status", planId, action, version]);
        const error = new ApiError("版本冲突");
        error.code = "VERSION_CONFLICT";
        throw error;
      },
    },
  });
  state.plans = [plan({ id: "plan-1", version: 5 })];
  const page = load();
  await page.refresh();
  await page.onTogglePlanStatus({ currentTarget: { dataset: { id: "plan-1", action: "pause" } } });
  assert.deepEqual(calls.find(([kind]) => kind === "status"), ["status", "plan-1", "pause", 5]);
  assert.equal(toasts.includes("计划已被他人修改，已刷新"), true);

  // 正常路径：恢复后版本递增并重新拉取
  const second = loadPlansPage();
  second.state.plans = [plan({ id: "plan-2", status: "paused", version: 2 })];
  const page2 = second.load();
  await page2.refresh();
  await page2.onTogglePlanStatus({ currentTarget: { dataset: { id: "plan-2", action: "resume" } } });
  assert.deepEqual(second.calls.find(([kind]) => kind === "status"), ["status", "plan-2", "resume", 2]);
});

test("计划卡片把星期与时间合并成可读文案", async () => {
  const { load, state } = loadPlansPage();
  state.plans = [
    plan({ id: "plan-a", weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }),
    plan({ id: "plan-b", weekdays: ["mon", "wed"], endDate: "2026-12-31", status: "paused" }),
  ];
  const page = load();
  await page.refresh();
  assert.equal(page.data.plans[0].weekdayText, "每天");
  assert.equal(page.data.plans[0].slotText, "08:00 / 20:00");
  assert.equal(page.data.plans[0].rangeText, "2026-10-01 起");
  assert.equal(page.data.plans[0].statusLabel, "进行中");
  assert.equal(page.data.plans[1].weekdayText, "一、三");
  assert.equal(page.data.plans[1].rangeText, "2026-10-01 至 2026-12-31");
  assert.equal(page.data.plans[1].statusLabel, "已暂停");
});

test("创建计划校验时间点格式、去重与上限", async () => {
  const { load, state, calls, toasts } = loadPlansPage();
  state.careProfiles = [{ id: "profile-1", displayName: "我自己", linkedUserId: null, isPrivate: true }];
  const page = load();
  await page.refresh();

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

  page.data.medicineName = "儿童退烧药";
  page.data.dosageText = "每次 5ml";
  await page.onSubmitPlan();
  const payload = calls.find(([kind]) => kind === "createPlan")?.[1];
  assert.ok(payload, "应提交创建请求");
  assert.equal(payload.careProfileId, "profile-1");
  assert.equal(payload.endDate, null, "未填结束日期应表示长期");
  assert.equal(payload.weekdays, undefined, "每天时不下发 weekdays");
});

test("指定星期但未选任何一天时阻止提交", async () => {
  const { load, state, calls, toasts } = loadPlansPage();
  state.careProfiles = [{ id: "profile-1", displayName: "我自己", linkedUserId: null, isPrivate: true }];
  const page = load();
  await page.refresh();
  page.setData({ medicineName: "儿童退烧药", dosageText: "每次 5ml", timeSlots: ["08:00"], everyDay: false, selectedWeekdays: [] });
  await page.onSubmitPlan();
  assert.equal(calls.some(([kind]) => kind === "createPlan"), false);
  assert.ok(toasts.includes("指定星期需至少选择一天，或改回每天"));
});

test("结束日期早于开始日期时阻止提交", async () => {
  const { load, state, calls, toasts } = loadPlansPage();
  state.careProfiles = [{ id: "profile-1", displayName: "我自己", linkedUserId: null, isPrivate: true }];
  const page = load();
  await page.refresh();
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

test("第一位使用者先自动创建“我自己”照护对象再打开表单", async () => {
  const { load, state, calls } = loadPlansPage();
  state.careProfiles = [];
  const page = load();
  await page.refresh();
  assert.equal(page.data.hasAnyProfile, false);
  await page.onOpenCreateForm();
  // R19：本人档案走服务端绑定身份的 self 接口，不再由客户端传 linkedUserId。
  const created = calls.find(([kind]) => kind === "ensureSelfProfile");
  assert.ok(created, "应调用 ensureSelfCareProfile 而非旧的 createCareProfile");
  assert.equal(created[1], "我自己");
  assert.equal(calls.some(([kind]) => kind === "createProfile"), false, "不得再走客户端猜测身份的旧接口");
  assert.equal(page.data.formVisible, true);
});

test("接口失败时展示错误卡片而不是空白页", async () => {
  const { load } = loadPlansPage({
    api: {
      getMedicationSchedule: async () => { throw new ApiError("网络异常"); },
    },
  });
  const page = load();
  await page.refresh();
  assert.equal(page.data.errorMessage, "网络异常");
  assert.equal(page.data.loading, false);
});

test("今日安排可以按照护对象筛选", async () => {
  const { load, state } = loadPlansPage();
  state.careProfiles = [
    { id: "profile-1", displayName: "我自己", linkedUserId: "user-1", isPrivate: true },
    { id: "profile-2", displayName: "孩子", linkedUserId: null, isPrivate: false },
  ];
  state.entries = [
    entry({ occurrenceId: "occ-1", careProfileId: "profile-1", careProfileName: "我自己", time: "08:00" }),
    entry({ occurrenceId: "occ-2", careProfileId: "profile-2", careProfileName: "孩子", time: "09:00" }),
  ];
  const page = load();
  await page.refresh();
  assert.equal(page.data.visibleEntries.length, 2);
  assert.deepEqual([...page.data.profileOptions].map((item) => item.displayName), ["全部", "我自己", "孩子"]);

  page.onProfileFilterChange({ currentTarget: { dataset: { id: "profile-2" } } });
  assert.deepEqual([...page.data.visibleEntries].map((item) => item.careProfileName), ["孩子"]);

  page.onProfileFilterChange({ currentTarget: { dataset: { id: "" } } });
  assert.equal(page.data.visibleEntries.length, 2);
});

test("全部计划按状态筛选，已结束的计划保留入口", async () => {
  const { load, state } = loadPlansPage();
  state.plans = [
    plan({ id: "plan-a", status: "active" }),
    plan({ id: "plan-b", status: "paused" }),
    plan({ id: "plan-c", status: "ended" }),
  ];
  const page = load();
  await page.refresh();
  assert.equal(page.data.visiblePlans.length, 3);
  page.onPlanStatusChange({ currentTarget: { dataset: { status: "active" } } });
  assert.deepEqual([...page.data.visiblePlans].map((item) => item.id), ["plan-a"]);
  page.onPlanStatusChange({ currentTarget: { dataset: { status: "ended" } } });
  assert.deepEqual([...page.data.visiblePlans].map((item) => item.id), ["plan-c"]);
  assert.equal(page.data.visiblePlans[0].statusLabel, "已结束");
});

test("点击计划卡片进入计划详情", async () => {
  const { load, state, navigations } = loadPlansPage();
  state.plans = [plan({ id: "plan-x" })];
  const page = load();
  await page.refresh();
  page.onOpenPlanDetail({ currentTarget: { dataset: { id: "plan-x" } } });
  assert.deepEqual(navigations, ["/pages/plan-detail/plan-detail?planId=plan-x"]);
  page.onOpenPlanDetail({ currentTarget: { dataset: {} } });
  assert.equal(navigations.length, 1, "缺少标识时不跳转");
});

test("模板不可用时如实说明，不承诺永久提醒", async () => {
  const { load, state } = loadPlansPage();
  state.reminder = { available: false, reason: "服药提醒模板尚未在药箱专用账号下配置", templateId: "", deliveries: [] };
  const page = load();
  await page.refresh();
  assert.equal(page.data.reminderAvailable, false);
  assert.match(page.data.reminderReason, /尚未在药箱专用账号下配置/);
  page.onSubscribeDoseReminder();
  assert.equal(page.data.reminderSubscribing, false, "模板不可用时不发起授权请求");
});

test("订阅服药提醒：用户接受后才保存模板，取消则不保存", async () => {
  const accepted = [];
  const { load, state, calls } = loadPlansPage({
    wx: {
      requestSubscribeMessage(options) {
        accepted.push(options.tmplIds);
        options.success({ [options.tmplIds[0]]: "accept" });
      },
    },
  });
  state.reminder = {
    available: true,
    reason: null,
    templateId: "dose-template-1",
    deliveries: [{ date: "2026-10-01", time: "08:00", status: "sent", statusLabel: "已发送", sentAt: "2026-10-01 08:00" }],
  };
  const page = load();
  await page.refresh();
  assert.equal(page.data.reminderAvailable, true);
  assert.deepEqual([...page.data.deliveries].map((item) => item.statusLabel), ["已发送"]);
  page.onSubscribeDoseReminder();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(accepted.length, 1);
  assert.deepEqual([...accepted[0]], ["dose-template-1"]);
  const saved = calls.find(([kind]) => kind === "subscribe");
  assert.ok(saved, "接受后必须把模板保存到服务端");
  assert.deepEqual([...saved[1]], ["dose-template-1"]);
  assert.match(page.data.reminderStatusText, /一次性授权按次数使用/);
});

test("用户取消授权时不写服务端", async () => {
  const { load, state, calls } = loadPlansPage({
    wx: {
      requestSubscribeMessage(options) {
        options.fail({ errMsg: "requestSubscribeMessage:fail cancel" });
      },
    },
  });
  state.reminder = { available: true, reason: null, templateId: "dose-template-1", deliveries: [] };
  const page = load();
  await page.refresh();
  page.onSubscribeDoseReminder();
  assert.equal(calls.some(([kind]) => kind === "subscribe"), false);
  assert.match(page.data.reminderStatusText, /取消了授权/);
});

test("提醒状态读取失败不影响计划页", async () => {
  const { load } = loadPlansPage({
    api: { getDoseReminderStatus: async () => { throw new ApiError("网络异常"); } },
  });
  const page = load();
  await page.refresh();
  assert.equal(page.data.errorMessage, "", "提醒状态失败不应让整页报错");
  assert.match(page.data.reminderReason, /暂时无法读取服药提醒状态/);
});

test("版本说明每个版本只自动展示一次，且最多三项", async () => {
  const storage = new Map();
  const modals = [];
  const service = loadService("services/app-update.ts", {
    wx: {
      getStorageSync(key) { return storage.get(key); },
      setStorageSync(key, value) { storage.set(key, value); },
      showModal(options) { modals.push(options); },
      getUpdateManager() { throw new Error("no update manager in test"); },
    },
  });
  assert.ok(service.RELEASE_NOTES.length >= 1);
  for (const note of service.RELEASE_NOTES) {
    assert.ok(note.items.length <= 3, `${note.version} 的说明最多三项`);
  }
  assert.equal(service.showReleaseNotesIfNeeded(), true, "首次进入应展示");
  assert.equal(modals.length, 1);
  assert.equal(service.showReleaseNotesIfNeeded(), false, "同一版本不再重复展示");
  assert.equal(modals.length, 1);
  // "版本与更新"页可以再次查看（标记为已读后仍能列出）
  service.markReleaseNotesSeen();
  assert.equal(service.releaseNotesSeen(), true);
  assert.equal(service.currentReleaseNote()?.version, service.APP_VERSION);
});

test("版本与更新页列出版本说明并标记已读", async () => {
  const storage = new Map();
  const { definition } = loadPage("pages/release-notes/release-notes.ts", {
    wx: {
      getStorageSync(key) { return storage.get(key); },
      setStorageSync(key, value) { storage.set(key, value); },
    },
  });
  const page = makePageContext(definition);
  page.onLoad();
  const notes = [...page.data.notes];
  assert.ok(notes.length >= 1);
  assert.equal(notes[0].isCurrent, true);
  assert.equal(page.data.appVersion, notes[0].version);
  assert.ok(storage.size >= 1, "打开本页应标记已读");
});

test("从药品详情进入时只带入药品身份，剂量与时间仍需填写", async () => {
  const { load, calls } = loadPlansPage();
  const page = load();
  page.onLoad({ medicineId: "medicine-7", medicineName: "儿童退烧药" });
  await page.refresh();
  assert.equal(page.data.formVisible, true, "直接进入创建表单");
  assert.equal(page.data.medicineId, "medicine-7");
  assert.equal(page.data.medicineName, "儿童退烧药");
  assert.equal(page.data.dosageText, "", "剂量不自动推导");
  assert.deepEqual([...page.data.timeSlots], [], "时间点不自动推导");

  page.setData({ dosageText: "每次 5ml", timeSlots: ["08:00"] });
  await page.onSubmitPlan();
  const payload = calls.find(([kind]) => kind === "createPlan")[1];
  assert.equal(payload.medicineId, "medicine-7");
});
