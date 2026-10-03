import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext, makeSessionScopeModule } from "./runtime.mjs";

const OWNER = { userId: "owner-a", familyId: "family-a" };
const DRAFT_KEY = "medicine-edit-draft:owner-a:family-a:new";
const choose = (page, choice) => page.onLeaveChoice({ currentTarget: { dataset: { choice } } });

function fixture({ initialScope = OWNER, wxOverrides = {} } = {}) {
  const scope = makeSessionScopeModule(initialScope);
  const storage = new Map();
  const writes = [];
  const toasts = [];
  const navigations = [];
  const warnings = [];
  let failDraftWrite = false;
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "session-scope": scope,
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/api": { api: {}, ApiError: class ApiError extends Error {} },
    },
    wx: {
      getStorageSync: key => structuredClone(storage.get(key)),
      setStorageSync(key, value) {
        if (key.startsWith("medicine-edit-draft:")) {
          writes.push(key);
          if (failDraftWrite) throw new Error("storage full");
        }
        storage.set(key, structuredClone(value));
      },
      removeStorageSync: key => storage.delete(key),
      showToast: options => toasts.push(options.title),
      navigateBack: () => navigations.push("back"),
      enableAlertBeforeUnload: () => warnings.push(true),
      disableAlertBeforeUnload: () => warnings.push(false),
      ...wxOverrides,
    },
  });
  const page = makePageContext(definition);
  page.onLoad({});
  page.onFieldInput({ currentTarget: { dataset: { field: "name" } }, detail: { value: "Unsaved medicine" } });
  return { page, definition, scope, storage, writes, toasts, navigations, warnings, failWrites: value => { failDraftWrite = value; } };
}

test("failed keep preserves the editable form and a later successful keep restores it", async () => {
  const f = fixture();
  f.failWrites(true);
  f.page.onRequestLeave();
  choose(f.page, "keep");
  assert.equal(f.page.data.isDirty, true);
  assert.equal(f.page.data.leaveSheetVisible, true);
  assert.equal(f.page.data.name, "Unsaved medicine");
  assert.equal(f.storage.has(DRAFT_KEY), false);
  assert.deepEqual(f.navigations, []);
  assert.equal(f.warnings.at(-1), true);
  assert.match(f.toasts.at(-1), /草稿保存失败/);

  f.failWrites(false);
  choose(f.page, "keep");
  assert.equal(f.page.data.isDirty, false);
  assert.equal(f.page.data.leaveSheetVisible, false);
  assert.deepEqual(f.navigations, ["back"]);
  const restored = makePageContext(f.definition);
  restored.onLoad({});
  await restored.onRestoreDraft();
  assert.equal(restored.data.name, "Unsaved medicine");
  assert.equal(restored.data.isDirty, true);
  assert.equal(restored.data.createOperationKey, f.page.data.createOperationKey);
});

test("repeated Back and failed keep remain recoverable; successful keep navigates once", () => {
  const f = fixture();
  f.failWrites(true);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    f.page.onRequestLeave();
    choose(f.page, "keep");
    assert.equal(f.page.data.isDirty, true);
    assert.equal(f.page.data.leaveSheetVisible, true);
    assert.deepEqual(f.navigations, []);
  }
  assert.equal(f.writes.length, 3);
  f.failWrites(false);
  choose(f.page, "keep");
  choose(f.page, "keep");
  f.page.onRequestLeave();
  f.page.onHide();
  f.page.onUnload();
  assert.equal(f.writes.length, 4);
  assert.deepEqual(f.navigations, ["back"]);
});

test("continue cancels a failed keep without another write or navigation", () => {
  const f = fixture();
  f.failWrites(true);
  f.page.onRequestLeave();
  choose(f.page, "keep");
  choose(f.page, "continue");
  assert.equal(f.page.data.leaveSheetVisible, false);
  assert.equal(f.page.data.isDirty, true);
  assert.equal(f.page.data.name, "Unsaved medicine");
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.navigations, []);
  choose(f.page, "keep");
  assert.equal(f.writes.length, 1, "a stale hidden-sheet choice cannot save or leave");
});

test("canceling Back before keep leaves the form and storage untouched", () => {
  const f = fixture();
  f.page.onRequestLeave();
  choose(f.page, "continue");
  assert.equal(f.page.data.isDirty, true);
  assert.equal(f.page.data.leaveSheetVisible, false);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.navigations, []);
});

test("failed Back and home fallback release the navigation guard for another attempt", () => {
  const calls = [];
  const f = fixture({ wxOverrides: {
    navigateBack(options) {
      calls.push("back");
      if (calls.length === 1) options.fail();
    },
    reLaunch(options) { calls.push("home"); options.fail(); },
  } });
  f.page.onRequestLeave();
  choose(f.page, "keep");
  assert.equal(f.storage.get(DRAFT_KEY).fields.name, "Unsaved medicine");
  f.page.onRequestLeave();
  assert.deepEqual(calls, ["back", "home", "back"]);
  assert.equal(f.writes.length, 1);
});

test("keep waits for an authenticated owner, then preserves the cold-start form", () => {
  const f = fixture({ initialScope: null });
  f.page.onRequestLeave();
  choose(f.page, "keep");
  assert.equal(f.page.data.isDirty, true);
  assert.equal(f.page.data.leaveSheetVisible, true);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.navigations, []);
  f.scope.writeSessionScope(OWNER);
  f.page.refreshDraftScope();
  choose(f.page, "keep");
  assert.equal(f.storage.get(DRAFT_KEY).fields.name, "Unsaved medicine");
  assert.deepEqual(f.navigations, ["back"]);
});

for (const [label, changedScope] of [
  ["another user", { userId: "owner-b", familyId: "family-a" }],
  ["another family", { userId: "owner-a", familyId: "family-b" }],
  ["signed out", null],
]) {
  test(`keep after ${label} cannot rebind or overwrite the draft; original owner can retry`, async () => {
    const f = fixture();
    await Promise.resolve();
    f.page.onRequestLeave();
    f.scope.writeSessionScope(changedScope);
    choose(f.page, "keep");
    f.page.refreshDraftScope();
    choose(f.page, "keep");
    f.page.onHide();
    assert.equal(f.page.data.isDirty, true);
    assert.equal(f.page.data.leaveSheetVisible, true);
    assert.equal(f.page.data.name, "Unsaved medicine");
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.navigations, []);
    f.scope.writeSessionScope(OWNER);
    f.page.refreshDraftScope();
    choose(f.page, "keep");
    const saved = f.storage.get(DRAFT_KEY);
    assert.equal(saved.fields.name, "Unsaved medicine");
    assert.equal(saved.ownerUserId, OWNER.userId);
    assert.equal(saved.ownerFamilyId, OWNER.familyId);
    assert.deepEqual(f.writes, [DRAFT_KEY]);
    assert.deepEqual(f.navigations, ["back"]);
  });
}

test("failed keep retains dirty state so hide/unload can retry local persistence", () => {
  const f = fixture();
  f.failWrites(true);
  f.page.onRequestLeave();
  choose(f.page, "keep");
  f.failWrites(false);
  f.page.onHide();
  f.page.onUnload();
  assert.equal(f.storage.get(DRAFT_KEY).fields.name, "Unsaved medicine");
  assert.deepEqual(f.navigations, []);
});
