import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext, makeSessionScopeModule } from "./runtime.mjs";

class ApiError extends Error {}
const owner = { userId: "owner", familyId: "family" };
function setup({ storage = new Map(), unlink, setStorage } = {}) {
  const scope = makeSessionScopeModule(owner);
  const key = scope.scopedStorageKey("medicine-photo-drafts");
  const removed = [];
  const options = {
    modules: {
      "session-scope": scope,
      "../../services/api": { ApiError, api: {} },
      "../../services/auth": { ensureLoggedIn: async () => {} },
    },
    wx: {
      env: { USER_DATA_PATH: "/owned" },
      getStorageSync: name => storage.has(name) ? JSON.parse(storage.get(name)) : undefined,
      setStorageSync: (name, value) => {
        setStorage?.(name, value);
        storage.set(name, JSON.stringify(value));
      },
      getFileSystemManager: () => ({ unlink: options => {
        removed.push(options.filePath);
        if (unlink) unlink(options, scope);
        else options.success({});
      } }),
    },
  };
  const page = makePageContext(loadPage("pages/medicine-edit/medicine-edit.ts", options).definition);
  page.photoScopeKey = key;
  return { page, key, scope, storage, removed, options };
}
function draft(key, overrides = {}) {
  const id = "photo-123-abc";
  const path = `/owned/${id}-box_front-456.jpg`;
  return { id, thumbnail: path, status: "cleanup_pending", fields: {}, medicineId: "", photos: [{
    path, mimeType: "image/jpeg", purpose: "box_front", batchIndex: 0,
    ownedLocal: { scopeKey: key, draftId: id, path },
  }], ...overrides };
}

test("exact registered photo is deleted only after cleanup intent was persisted", async () => {
  const context = setup({ unlink: options => {
    assert.equal(JSON.parse(context.storage.get(context.key))[0].status, "cleanup_pending");
    options.success({});
  } });
  context.page.data.photoDrafts = [draft(context.key)];
  context.page.persistPhotoDrafts(); // Explicit delete/save acknowledges intent before passive cleanup.
  await context.page.cleanupPhotoDrafts();
  assert.equal(context.removed.length, 1);
  assert.equal(context.page.data.photoDrafts.length, 0);
  assert.deepEqual(JSON.parse(context.storage.get(context.key)), []);
});

test("failed unlink preserves the owned record and a new page can retry", async () => {
  const first = setup({ unlink: options => options.fail({ errMsg: "unlink:fail permission denied" }) });
  first.page.data.photoDrafts = [draft(first.key)];
  first.page.persistPhotoDrafts(); // Explicit delete/save acknowledges intent before passive cleanup.
  await first.page.cleanupPhotoDrafts();
  assert.equal(first.page.data.photoDrafts.length, 1);
  assert.equal(JSON.parse(first.storage.get(first.key)).length, 1);
  const second = setup({ storage: first.storage });
  second.page.data.photoDrafts = JSON.parse(first.storage.get(first.key));
  second.page.persistPhotoDrafts(); // Explicit delete/save acknowledges intent before passive cleanup.
  await second.page.cleanupPhotoDrafts();
  assert.equal(second.removed.length, 1);
  assert.equal(second.page.data.photoDrafts.length, 0);
});

for (const kind of ["unregistered", "traversal", "different-owner", "different-draft", "different-path"]) {
  test(`ambiguous ${kind} persistent photo is preserved with its retry record`, async () => {
    const { page, key, removed, storage } = setup();
    const record = draft(key);
    const photo = record.photos[0];
    if (kind === "unregistered") delete photo.ownedLocal;
    if (kind === "traversal") { photo.path = "/owned/../other.jpg"; photo.ownedLocal.path = photo.path; }
    if (kind === "different-owner") photo.ownedLocal.scopeKey = "another-owner";
    if (kind === "different-draft") photo.ownedLocal.draftId = "photo-999-other";
    if (kind === "different-path") photo.ownedLocal.path = "/owned/other.jpg";
    page.data.photoDrafts = [record];
    page.persistPhotoDrafts(); // Explicit delete/save acknowledges intent before passive cleanup.
    await page.cleanupPhotoDrafts();
    assert.equal(removed.length, 0);
    assert.equal(page.data.photoDrafts.length, 1);
    assert.equal(JSON.parse(storage.get(key)).length, 1);
  });
}

test("failed durable cleanup registration never deletes any bytes", async () => {
  const { page, key, removed } = setup({ setStorage: () => { throw new Error("disk full"); } });
  page.data.photoDrafts = [draft(key)];
  page.persistPhotoDrafts(); // Explicit delete/save acknowledges intent before passive cleanup.
  await page.cleanupPhotoDrafts();
  assert.equal(removed.length, 0);
  assert.equal(page.data.photoDrafts.length, 1);
});

test("cleanup record is retained when clearing it fails, and ENOENT settles a later retry", async () => {
  const first = setup({ setStorage: (_name, value) => { if (!value.length) throw new Error("disk full"); } });
  first.page.data.photoDrafts = [draft(first.key)];
  first.page.persistPhotoDrafts(); // Explicit delete/save acknowledges intent before passive cleanup.
  await first.page.cleanupPhotoDrafts();
  assert.equal(first.removed.length, 1);
  assert.equal(first.page.data.photoDrafts.length, 1);
  const second = setup({ storage: first.storage, unlink: options => options.fail({ errMsg: "unlink:fail no such file or directory" }) });
  second.page.data.photoDrafts = JSON.parse(second.storage.get(second.key));
  second.page.persistPhotoDrafts(); // Explicit delete/save acknowledges intent before passive cleanup.
  await second.page.cleanupPhotoDrafts();
  assert.equal(second.page.data.photoDrafts.length, 0);
});

test("identity changing during unlink prevents the next unlink and foreign storage writes", async () => {
  const context = setup({ unlink: (options, scope) => {
    scope.writeSessionScope({ userId: "foreign", familyId: "other" });
    options.success({});
  } });
  const record = draft(context.key);
  const extra = structuredClone(record.photos[0]);
  extra.path = "/owned/photo-123-abc-box_front-789.jpg";
  extra.ownedLocal.path = extra.path;
  record.photos.push(extra);
  context.page.data.photoDrafts = [record];
  context.page.persistPhotoDrafts(); // Explicit delete/save acknowledges intent before passive cleanup.
  await context.page.cleanupPhotoDrafts();
  assert.equal(context.removed.length, 1);
  assert.equal(context.page.data.photoDrafts.length, 1);
  assert.deepEqual([...context.storage.keys()], [context.key]);
});

test("a synchronous filesystem failure remains retryable without dropping the record", async () => {
  const { page, key, storage } = setup({ unlink: () => { throw new Error("unavailable filesystem"); } });
  page.data.photoDrafts = [draft(key)];
  page.persistPhotoDrafts(); // Explicit delete/save acknowledges intent before passive cleanup.
  await page.cleanupPhotoDrafts();
  assert.equal(page.data.photoDrafts.length, 1);
  assert.equal(JSON.parse(storage.get(key)).length, 1);
  assert.equal(page.photoCleanupRunning, false);
});

test("newly persisted photos carry exact household and draft ownership evidence", async () => {
  const context = setup();
  const writes = [];
  context.options.wx.chooseMedia = async () => ({ tempFiles: [{ tempFilePath: "/temporary.jpg", size: 10 }] });
  context.options.wx.getSystemInfoSync = () => ({ SDKVersion: "3.17.3" });
  context.options.wx.base64ToArrayBuffer = () => new ArrayBuffer(4);
  context.options.wx.getFileSystemManager = () => ({
    readFile: options => options.success({ data: "/9j/2Q==" }),
    open: options => { assert.equal(options.flag, "wx"); writes.push(options.filePath); options.success({ fd: "synthetic-fd" }); },
    write: options => options.success({ bytesWritten: options.data.byteLength }),
    close: options => options.success({}),
    unlink: options => options.success({}),
  });
  context.options.modules["../../services/api"].api.recognizeMedicine = async () => ({
    warnings: [], draft: { name: null, specification: null, manufacturer: null, approvalNumber: null, purposeCategory: null },
  });
  const page = makePageContext(loadPage("pages/medicine-edit/medicine-edit.ts", context.options).definition);
  page.photoScopeKey = context.key;
  await page.onRecognizePhoto("camera");
  assert.equal(writes.length, 1);
  const record = JSON.parse(context.storage.get(context.key))[0];
  assert.deepEqual(record.photos[0].ownedLocal, { scopeKey: context.key, draftId: record.id, path: writes[0], state: "ready", byteLength: 4 });
  assert.equal(record.photos[0].path, writes[0]);
});


test("passive cleanup never registers an unpersisted page-local intent", async () => {
  const { page, key, removed, storage } = setup();
  page.data.photoDrafts = [draft(key)];
  await page.cleanupPhotoDrafts();
  assert.equal(removed.length, 0);
  assert.equal(storage.has(key), false);
  assert.equal(page.data.photoDrafts.length, 1);
});
