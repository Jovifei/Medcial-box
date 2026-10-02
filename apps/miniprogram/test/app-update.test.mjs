import assert from "node:assert/strict";
import test from "node:test";
import { loadService } from "./runtime.mjs";

/**
 * R14 更新链路用例：新版本就绪后不静默重启；有未保存草稿时给出
 * 「保存并重启 / 放弃草稿并重启 / 稍后再说」三选，保存失败则延期更新。
 */

function loadUpdate({ draft = null, hasActionSheet = true } = {}) {
  const state = { cleared: 0, applied: 0, toasts: [], modals: [], actionSheet: null };
  let readyCallback = null;
  const manager = {
    onUpdateReady(callback) { readyCallback = callback; },
    onUpdateFailed() {},
    applyUpdate() { state.applied += 1; },
  };
  const draftGuard = {
    peekDirtyDraft: () => draft,
    clearDirtyDraft: () => { state.cleared += 1; },
  };
  const storage = new Map();
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => { storage.set(key, value); },
    getUpdateManager: () => manager,
    showModal(options) { state.modals.push(options); },
    showToast(options) { state.toasts.push(options.title); },
  };
  if (hasActionSheet) wx.showActionSheet = (options) => { state.actionSheet = options; };
  const service = loadService("services/app-update.ts", { modules: { "./draft-guard": draftGuard }, wx });
  return { service, state, triggerReady: () => readyCallback() };
}

test("R14：新版本就绪且无草稿时直接重启，不多问", () => {
  const { service, state, triggerReady } = loadUpdate({ draft: null });
  service.watchForUpdates();
  triggerReady();
  state.modals[0].success({ confirm: true });
  assert.equal(state.applied, 1, "无草稿时确认后直接重启");
  assert.equal(state.actionSheet, null, "无草稿不需要三选");
});

test("R14：新版本就绪先提示，用户点“稍后”不重启", () => {
  const { service, state, triggerReady } = loadUpdate({ draft: null });
  service.watchForUpdates();
  triggerReady();
  assert.match(state.modals[0].content, /未保存的草稿|重启/);
  state.modals[0].success({ confirm: false });
  assert.equal(state.applied, 0, "未确认前不重启");
});

test("R14：有脏草稿时给出三选，保存成功后清草稿并重启", async () => {
  const saved = [];
  const draft = { label: "计划修改有未保存内容。", save: async () => { saved.push(1); } };
  const { service, state, triggerReady } = loadUpdate({ draft });
  service.watchForUpdates();
  triggerReady();
  state.modals[0].success({ confirm: true });
  assert.deepEqual([...state.actionSheet.itemList], ["保存并重启", "放弃草稿并重启", "稍后再说"]);
  await state.actionSheet.success({ tapIndex: 0 });
  assert.equal(saved.length, 1, "选择保存会真正执行保存动作");
  assert.equal(state.cleared, 1);
  assert.equal(state.applied, 1);
});

test("R14：保存失败时延期更新，不重启也不清草稿", async () => {
  const draft = { label: "创建用药计划表单有未保存内容。", save: async () => { throw new Error("boom"); } };
  const { service, state, triggerReady } = loadUpdate({ draft });
  service.watchForUpdates();
  triggerReady();
  state.modals[0].success({ confirm: true });
  await state.actionSheet.success({ tapIndex: 0 });
  assert.equal(state.applied, 0, "保存失败不得重启");
  assert.equal(state.cleared, 0, "保存失败不得丢弃草稿");
  assert.ok(state.toasts.some((title) => /保存失败/.test(title)), "如实告知保存失败并延期");
});

test("R14：选择放弃草稿并重启会先清草稿", async () => {
  const draft = { label: "计划修改有未保存内容。", save: async () => { throw new Error("不应被调用"); } };
  const { service, state, triggerReady } = loadUpdate({ draft });
  service.watchForUpdates();
  triggerReady();
  state.modals[0].success({ confirm: true });
  await state.actionSheet.success({ tapIndex: 1 });
  assert.equal(state.cleared, 1, "放弃草稿时清除登记");
  assert.equal(state.applied, 1);
});

test("R14：选择稍后再说继续编辑，不重启不清草稿", async () => {
  const draft = { label: "计划修改有未保存内容。", save: async () => {} };
  const { service, state, triggerReady } = loadUpdate({ draft });
  service.watchForUpdates();
  triggerReady();
  state.modals[0].success({ confirm: true });
  await state.actionSheet.success({ tapIndex: 2 });
  assert.equal(state.applied, 0);
  assert.equal(state.cleared, 0);
});

test("R14：无 action sheet 环境退回二选，默认保护草稿", () => {
  const draft = { label: "计划修改有未保存内容。", save: async () => {} };
  const { service, state, triggerReady } = loadUpdate({ draft, hasActionSheet: false });
  service.watchForUpdates();
  triggerReady();
  state.modals[0].success({ confirm: true });
  assert.equal(state.modals.length, 2, "退回确认弹窗");
  assert.equal(state.applied, 0, "默认不重启，保护草稿");
  state.modals[1].success({ confirm: true });
  assert.equal(state.cleared, 1);
  assert.equal(state.applied, 1, "确认放弃后才重启");
});

test("R14：同一版本只提示一次重启", () => {
  const { service, state, triggerReady } = loadUpdate({ draft: null });
  service.watchForUpdates();
  triggerReady();
  state.modals[0].success({ confirm: true });
  assert.equal(state.applied, 1);
  // 第二次就绪：markPrompted 已写入本版本，readPromptedVersion 命中后直接返回。
  triggerReady();
  assert.equal(state.modals.length, 1, "同一版本不再重复弹出重启提示");
  assert.equal(state.applied, 1);
});
