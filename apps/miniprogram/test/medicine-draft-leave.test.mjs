import { setImmediate } from 'node:timers';
import { ownedPhotoFixture } from "./support/owned-photo-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext, makeSessionScopeModule } from "./runtime.mjs";

const OWNER = { userId: "owner-a", familyId: "family-a" };
const DRAFT_KEY = "medicine-edit-draft:owner-a:family-a:new";
const choose = (page, choice) => page.onLeaveChoice({ currentTarget: { dataset: { choice } } });

function fixture({ initialScope = OWNER, wxOverrides = {}, api = {} } = {}) {
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
      "../../services/api": { api, ApiError: class ApiError extends Error {} },
    },
    wx: {
      ...ownedPhotoFixture(),
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

const PHOTO_KEY = "medicine-photo-drafts:owner-a:family-a:new";
function photoDraft(page, id = "current") {
  return { id, thumbnail: "/photo.jpg", status: "review", fields: {}, medicineId: "", photos: [] };
}

test("a fresh entry hides completed photo drafts but keeps older unfinished work", async () => {
  const f = fixture();
  f.storage.set(PHOTO_KEY, [
    { ...photoDraft(f.page, "done"), status: "saved" },
    photoDraft(f.page, "unfinished"),
  ]);
  f.page.loadPhotoDrafts();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.page.data.photoDrafts.map(item => item.id), ["unfinished"]);
  assert.equal(f.storage.get(PHOTO_KEY).length, 1, "completed metadata is removed; unfinished work stays recoverable");
});

test("next medicine cannot reset an unsaved current form or start a parallel photo draft", () => {
  const f = fixture();
  const before = structuredClone(f.page.data);
  f.page.onNewPhotoDraft();
  assert.equal(JSON.stringify(f.page.data), JSON.stringify(before));
  assert.match(f.toasts.at(-1), /先保存当前药品/);
});

test("successful save removes only the current photo draft and cannot recreate form draft on leave", async () => {
  const f = fixture({ api: { createMedicine: async () => ({ id: "saved", batches: [] }) },
    wxOverrides: { switchTab() {} } });
  await f.page.checkEntrySession();
  f.page.setData({ photoDrafts: [photoDraft(f.page), photoDraft(f.page, "older")], activePhotoDraftId: "current" });
  await f.page.onSubmit();
  assert.equal(f.storage.has(DRAFT_KEY), false);
  assert.deepEqual(f.storage.get(PHOTO_KEY).map(item => item.id), ["older"]);
  assert.equal(f.page.data.activePhotoDraftId, "");
  f.page.onHide(); f.page.onUnload();
  assert.equal(f.storage.has(DRAFT_KEY), false);
});

test("failed medicine save preserves current form and photo retry identity", async () => {
  const f = fixture({ api: { createMedicine: async () => { throw new Error("lost response"); } } });
  await f.page.checkEntrySession();
  f.page.setData({ photoDrafts: [photoDraft(f.page)], activePhotoDraftId: "current" });
  await f.page.onSubmit();
  assert.equal(f.storage.get(DRAFT_KEY).fields.name, "Unsaved medicine");
  assert.equal(f.storage.get(PHOTO_KEY)[0].id, "current");
  assert.equal(f.page.data.isDirty, true);
});

test("failed photo upload retains the saved medicine id and retries without creating another medicine", async () => {
  let creates = 0;
  let uploads = 0;
  const saved = { id: "saved", batches: [{ id: "batch" }] };
  const f = fixture({ api: {
    createMedicine: async () => { creates++; return saved; },
    getMedicine: async () => saved,
    uploadLeafletPhoto: async () => { uploads++; if (uploads === 1) throw new Error("upload failed"); return { photo: { id: "photo" } }; },
  }, wxOverrides: { getFileSystemManager: () => ({ readFile: options => options.success({ data: "/9j/data" }) }), switchTab() {} } });
  const current = photoDraft(f.page);
  current.photos = [{ path: "/photo.jpg", mimeType: "image/jpeg", purpose: "box_front", batchIndex: 0,
    ownedLocal: { path: "/photo.jpg", scopeKey: PHOTO_KEY, draftId: current.id, state: "ready", byteLength: 200 } }];
  await f.page.checkEntrySession();
  f.page.setData({ photoDrafts: [current], activePhotoDraftId: "current", usePhotoAsCover: false });
  await f.page.onSubmit();
  assert.equal(f.storage.get(PHOTO_KEY)[0].status, "photo_pending");
  assert.equal(f.storage.get(PHOTO_KEY)[0].medicineId, "saved");
  assert.equal(f.storage.has(DRAFT_KEY), true);
  await f.page.onSubmit();
  assert.equal(creates, 1);
  assert.equal(uploads, 2);
  assert.equal(f.storage.get(PHOTO_KEY).length, 0);
  assert.equal(f.storage.has(DRAFT_KEY), false);
});

test("editing an existing medicine cannot show another new-medicine photo draft", () => {
  const f = fixture();
  f.storage.set(PHOTO_KEY, [photoDraft(f.page, "new-work")]);
  f.page.setData({ medicineId: "existing", isEdit: true });
  f.page.loadPhotoDrafts();
  assert.equal(f.page.data.photoDrafts.length, 0);
  assert.equal(f.storage.get(PHOTO_KEY)[0].id, "new-work");
});
