import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext } from "./runtime.mjs";

/**
 * R3 照护对象与共享权限用例：
 * - 关联自己账号＝本人私有；不关联＝家人共用（孩子/老人）；
 * - 授权只发给指定家人，可代记与仅查看分开；
 * - 撤销前二次确认，撤销后保留已产生的记录。
 */

class ApiError extends Error {}

function loadCareProfilesPage({ api = {}, wx = {} } = {}) {
  const calls = [];
  const modals = [];
  const toasts = [];
  const state = {
    profiles: [
      { id: "profile-self", displayName: "我自己", linkedUserId: "user-1", canManage: true, isPrivate: true },
      { id: "profile-child", displayName: "孩子", linkedUserId: null, canManage: true, isPrivate: false },
    ],
    family: {
      family: {
        id: "family-1",
        name: "测试家庭",
        role: "owner",
        members: [
          { id: "m1", userId: "user-1", role: "owner", displayName: "我", isSelf: true, joinedAt: "2026-01-01" },
          { id: "m2", userId: "user-2", role: "member", displayName: "妈妈", isSelf: false, joinedAt: "2026-01-02" },
        ],
      },
    },
    grants: [{ careProfileId: "profile-child", displayName: "孩子", grants: [{ memberUserId: "user-2", displayName: "妈妈", canView: true, canManage: false }] }],
  };
  const defaults = {
    listCareProfiles: async () => ({ careProfiles: state.profiles }),
    getCurrentFamily: async () => state.family,
    listCareGrants: async (id) => state.grants.find((item) => item.careProfileId === id) ?? { careProfileId: id, displayName: "", grants: [] },
    createCareProfile: async (payload) => { calls.push(["create", payload]); return { id: "new", displayName: payload.displayName, linkedUserId: payload.linkedUserId ?? null, isPrivate: Boolean(payload.linkedUserId) }; },
    createCareGrant: async (profileId, payload) => { calls.push(["grant", profileId, payload]); return { careProfileId: profileId, ...payload }; },
    revokeCareGrant: async (profileId, memberUserId) => { calls.push(["revoke", profileId, memberUserId]); return { careProfileId: profileId, memberUserId, removed: true }; },
  };
  const { definition } = loadPage("pages/care-profiles/care-profiles.ts", {
    modules: {
      "../../services/api": { api: { ...defaults, ...api }, ApiError },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: {
      showModal(options) { modals.push(options); options?.success?.({ confirm: true }); },
      showToast(options) { toasts.push(options.title); },
      ...wx,
    },
  });
  return { definition, state, calls, modals, toasts, load: () => makePageContext(definition) };
}

test("列表区分本人私有与家人共用，并展示已有授权", async () => {
  const { load } = loadCareProfilesPage();
  const page = load();
  await page.refresh();
  const profiles = [...page.data.profiles];
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].kindLabel, "本人私有");
  assert.equal(profiles[0].grantsText, "仅本人可见");
  assert.equal(profiles[1].kindLabel, "家人共用");
  assert.equal(profiles[1].grantsText, "妈妈（仅查看）");
  assert.equal(profiles[1].grants[0].memberUserId, "user-2");
});

test("创建时勾选关联本人账号才下发 linkedUserId", async () => {
  const { load, calls } = loadCareProfilesPage();
  const page = load();
  await page.refresh();
  page.onOpenForm();
  page.setData({ displayName: "我自己" });
  page.onLinkSelfChange({ detail: { value: true } });
  await page.onSubmit();
  const created = calls.find(([kind]) => kind === "create")[1];
  assert.equal(created.displayName, "我自己");
  assert.equal(created.linkedUserId, "user-1");

  const shared = loadCareProfilesPage();
  const sharedPage = shared.load();
  await sharedPage.refresh();
  sharedPage.onOpenForm();
  sharedPage.setData({ displayName: "奶奶" });
  await sharedPage.onSubmit();
  assert.equal(shared.calls.find(([kind]) => kind === "create")[1].linkedUserId, undefined, "孩子/老人不关联账号");
});

test("空名称阻止提交", async () => {
  const { load, calls } = loadCareProfilesPage();
  const page = load();
  await page.refresh();
  page.onOpenForm();
  page.setData({ displayName: "  " });
  await page.onSubmit();
  assert.equal(calls.some(([kind]) => kind === "create"), false);
});

test("授权给指定家人，可代记与仅查看分开", async () => {
  const { load, calls } = loadCareProfilesPage();
  const page = load();
  await page.refresh();
  page.onOpenGrant({ currentTarget: { dataset: { id: "profile-child" } } });
  assert.equal(page.data.grantProfileId, "profile-child");
  page.onGrantManageChange({ detail: { value: true } });
  await page.onSubmitGrant();
  const [kind, profileId, payload] = calls.find(([item]) => item === "grant");
  assert.equal(kind, "grant");
  assert.equal(profileId, "profile-child");
  assert.equal(payload.memberUserId, "user-2");
  assert.equal(payload.canManage, true);
});

test("撤销授权前二次确认，确认后带上成员账号", async () => {
  const { load, calls, modals } = loadCareProfilesPage();
  const page = load();
  await page.refresh();
  await page.onRevokeGrant({ currentTarget: { dataset: { profile: "profile-child", member: "user-2", name: "妈妈" } } });
  assert.equal(modals.length, 1);
  assert.match(modals[0].content, /妈妈/);
  assert.deepEqual(calls.find(([kind]) => kind === "revoke"), ["revoke", "profile-child", "user-2"]);
});

test("取消确认则不撤销", async () => {
  const { load, calls } = loadCareProfilesPage({
    wx: { showModal(options) { options?.success?.({ confirm: false }); } },
  });
  const page = load();
  await page.refresh();
  await page.onRevokeGrant({ currentTarget: { dataset: { profile: "profile-child", member: "user-2", name: "妈妈" } } });
  assert.equal(calls.some(([kind]) => kind === "revoke"), false);
});

test("R18：查看者只展示自身访问级别，不枚举他人授权", async () => {
  const grantCalls = [];
  const { load } = loadCareProfilesPage({
    api: {
      listCareProfiles: async () => ({ careProfiles: [
        { id: "p-view", displayName: "孩子", linkedUserId: null, canManage: false, isPrivate: false },
      ] }),
      listCareGrants: async (id) => { grantCalls.push(id); return { grants: [] }; },
    },
  });
  const page = load();
  await page.refresh();
  assert.equal(page.data.profiles[0].accessLabel, "仅查看");
  assert.match(page.data.profiles[0].grantsText, /仅有查看权限/);
  assert.deepEqual(grantCalls, [], "查看者不应请求授权名单");
});

test("R18：管理者读取授权名单被拒（403）时如实说明无权", async () => {
  const { load } = loadCareProfilesPage({
    api: {
      listCareProfiles: async () => ({ careProfiles: [
        { id: "p-mgr", displayName: "老人", linkedUserId: null, canManage: true, isPrivate: false },
      ] }),
      listCareGrants: async () => { const error = new ApiError("无权"); error.statusCode = 403; throw error; },
    },
  });
  const page = load();
  await page.refresh();
  assert.match(page.data.profiles[0].grantsText, /无权查看/);
});

test("R18：授权名单读取失败与确实无授权分开呈现", async () => {
  const { load } = loadCareProfilesPage({
    api: {
      listCareProfiles: async () => ({ careProfiles: [
        { id: "p-fail", displayName: "老人", linkedUserId: null, canManage: true, isPrivate: false },
        { id: "p-empty", displayName: "孩子", linkedUserId: null, canManage: true, isPrivate: false },
      ] }),
      listCareGrants: async (id) => {
        if (id === "p-fail") throw new ApiError("网络异常");
        return { grants: [] };
      },
    },
  });
  const page = load();
  await page.refresh();
  const byId = {};
  for (const profile of page.data.profiles) byId[profile.id] = profile;
  assert.match(byId["p-fail"].grantsText, /读取失败/);
  assert.equal(byId["p-empty"].grantsText, "仅创建者可见", "确实没有授权时才显示仅创建者可见");
});
