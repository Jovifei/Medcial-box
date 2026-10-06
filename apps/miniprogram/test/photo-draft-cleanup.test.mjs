import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { loadPage, makePageContext, makeSessionScopeModule } from "./runtime.mjs";

test("confirmed deletion attempts only acknowledged generated originals and retains cleanup failures", async () => {
  const deleted = [], storage = new Map();
  const scope = makeSessionScopeModule({ userId: "synthetic-cleanup-user", familyId: "synthetic-cleanup-family" });
  const key = scope.scopedStorageKey("medicine-photo-drafts"), id = "photo-123-abc";
  const owned = "wxfile://usr/photo-123-abc-box_front-456.jpg";
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", { modules: {
    "session-scope": scope, "../../services/api": { api: {}, ApiError: class extends Error {} }, "../../services/auth": {},
  }, wx: { env: { USER_DATA_PATH: "wxfile://usr" }, showModal: ({ success }) => success({ confirm: true }),
    getStorageSync: k => structuredClone(storage.get(k)), setStorageSync: (k, value) => storage.set(k, structuredClone(value)),
    getFileSystemManager: () => ({ unlink: ({ filePath }) => { deleted.push(filePath); throw Error("synthetic disk unavailable"); } }),
  } }); const page = makePageContext(definition); page.photoScopeKey = key; page.draftStorageKey = scope.scopedStorageKey("medicine-edit-draft");
  const photos = [owned, "wxfile://usr/../photo-123-abc-box_front-456.jpg", "wxfile://usr/original.jpg", "/external/photo-123-abc-box_front-456.jpg"].map(path =>
    ({ path, purpose: "box_front", mimeType: "image/jpeg", batchIndex: 0, ...(path === owned ? { ownedLocal: { path, draftId: id, scopeKey: key, state: "ready" } } : {}) }));
  storage.set(key, [{ id, status: "review", fields: {}, medicineId: "", photos }]);
  page.setData({ photoDrafts: storage.get(key), activePhotoDraftId: id });
  page.onDeletePhotoDraft({ currentTarget: { dataset: { id } } }); await setImmediate();
  assert.deepEqual(deleted, [owned]);
  assert.equal(storage.get(key).length, 1, "failed cleanup must retain its durable receipt");
  assert.equal(storage.get(key)[0].status, "cleanup_pending");
  assert.equal(page.data.photoDrafts.length, 1);
});
