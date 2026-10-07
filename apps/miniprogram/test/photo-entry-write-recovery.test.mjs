import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import { loadPage, makePageContext, makeSessionScopeModule } from "./runtime.mjs";

class ApiError extends Error {}
function setup({ open, write, close, store, sdk = "3.17.3", storage = new Map() } = {}) {
  const scope = makeSessionScopeModule({ userId: "synthetic-a", familyId: "synthetic-f" });
  const key = scope.scopedStorageKey("medicine-photo-drafts");
  const calls = { open: 0, write: 0, close: 0, unlink: 0, writeFile: 0, recognize: 0, create: 0 };
  const fs = {
    readFile: options => options.success({ data: "/9j/2Q==" }),
    open: options => { calls.open++; if (open) open(options, scope); else options.success({ fd: "synthetic-fd" }); },
    write: options => { calls.write++; if (write) write(options, scope); else options.success({ bytesWritten: options.data.byteLength }); },
    close: options => { calls.close++; if (close) close(options); else options.success({}); },
    unlink: options => { calls.unlink++; options.success({}); },
    writeFile: options => { calls.writeFile++; options.success({}); }, // Legacy trap: never used by the new product path.
  };
  const options = {
    setTimeoutFn: () => {},
    modules: {
      "session-scope": scope,
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/api": { ApiError, api: {
        recognizeMedicine: async () => { calls.recognize++; return { warnings: [], draft: {
          name: null, specification: null, manufacturer: null, approvalNumber: null, purposeCategory: null,
        } }; },
        createMedicine: async () => { calls.create++; return { id: "synthetic-medicine", batches: [] }; },
      } },
    },
    wx: {
      env: { USER_DATA_PATH: "/synthetic-owned" },
      getSystemInfoSync: () => ({ SDKVersion: sdk, statusBarHeight: 20, windowWidth: 360 }),
      base64ToArrayBuffer: () => new ArrayBuffer(4),
      chooseMedia: async () => ({ tempFiles: [{ tempFilePath: "/synthetic-temp.jpg", size: 4 }] }),
      getFileSystemManager: () => fs,
      getStorageSync: name => storage.has(name) ? JSON.parse(storage.get(name)) : undefined,
      setStorageSync: (name, value) => { store?.(name, value); storage.set(name, JSON.stringify(value)); },
      removeStorageSync: name => storage.delete(name),
    },
  };
  const page = makePageContext(loadPage("pages/medicine-edit/medicine-edit.ts", options).definition);
  page.photoScopeKey = key;
  page.draftStorageKey = scope.scopedStorageKey("medicine-edit-draft");
  page.data.name = "Synthetic medicine";
  return { page, scope, key, calls, options, storage };
}

test("product photo capture persists ownership before native write and recognizes only after ready", async () => {
  const h = setup({ write: options => {
    const record = JSON.parse(h.storage.get(h.key))[0];
    assert.equal(record.photos[0].ownedLocal.state, "reserved");
    options.success({ bytesWritten: 4 });
  } });
  await h.page.onRecognizePhoto("camera");
  assert.equal(h.calls.open, 1);
  assert.equal(h.calls.writeFile, 0);
  assert.equal(h.calls.recognize, 1);
  assert.equal(JSON.parse(h.storage.get(h.key))[0].photos[0].ownedLocal.state, "ready");
  assert.equal(h.calls.close, 1);
});

test("exclusive create failure cannot register or unlink a preexisting photo", async () => {
  const h = setup({ open: options => options.fail({ errMsg: "file already exists" }) });
  await h.page.onRecognizePhoto("camera");
  assert.equal(h.calls.write + h.calls.writeFile + h.calls.unlink + h.calls.recognize, 0);
  assert.equal(h.page.data.photoDrafts.length, 0);
});

test("durable registration failure writes no private bytes and retains an honest failure hint", async () => {
  const h = setup({ store: () => { throw new Error("storage unavailable"); } });
  await h.page.onRecognizePhoto("camera");
  assert.equal(h.calls.write + h.calls.writeFile + h.calls.recognize, 0);
  assert.equal(h.calls.close, 1);
  assert.match(h.page.data.recognitionHint, /登记失败/);
});

test("short write stays reserved and blocks medicine creation or photo upload", async () => {
  const h = setup({ write: options => options.success({ bytesWritten: 1 }) });
  await h.page.onRecognizePhoto("camera");
  assert.equal(h.calls.recognize, 0);
  assert.equal(h.page.data.photoDrafts[0].photos[0].ownedLocal.state, "reserved");
  await h.page.onSubmit();
  assert.equal(h.calls.create, 0);
});

test("close failure can be retried before cleanup, without pretending the photo was ready", async () => {
  let failClose = true;
  const h = setup({ close: options => { if (failClose) options.fail({}); else options.success({}); } });
  await h.page.onRecognizePhoto("camera");
  assert.equal(h.calls.recognize, 0);
  assert.equal(h.page.data.photoDrafts[0].photos[0].ownedLocal.state, "reserved");
  failClose = false;
  h.page.data.photoDrafts[0].status = "cleanup_pending";
  assert.equal(h.page.persistPhotoDrafts(), true);
  await h.page.cleanupPhotoDrafts();
  assert.equal(h.calls.close, 2);
  assert.equal(h.calls.unlink, 1);
  assert.equal(h.page.data.photoDrafts.length, 0);
});

test("lost ready acknowledgement rolls memory back to reserved and blocks premature submission", async () => {
  const h = setup({ store: (name, value) => {
    if (name.includes("medicine-photo-drafts") && value.some(item => item.photos.some(photo => photo.ownedLocal?.state === "ready"))) throw new Error("acknowledgement lost");
  } });
  await h.page.onRecognizePhoto("camera");
  assert.equal(h.calls.recognize, 0);
  assert.equal(h.page.data.photoDrafts[0].photos[0].ownedLocal.state, "reserved");
  assert.equal(JSON.parse(h.storage.get(h.key))[0].photos[0].ownedLocal.state, "reserved");
  await h.page.onSubmit();
  assert.equal(h.calls.create, 0);
});

test("background draft reload cannot replace the live writer's owned record", async () => {
  let finish;
  const h = setup({ write: options => { finish = () => options.success({ bytesWritten: 4 }); } });
  const saving = h.page.onRecognizePhoto("camera");
  await new Promise(resolve => setImmediate(resolve));
  const original = h.page.data.photoDrafts[0];
  h.page.loadPhotoDrafts();
  assert.equal(h.page.data.photoDrafts[0], original);
  finish();
  await saving;
  assert.equal(h.page.data.photoDrafts[0].photos[0].ownedLocal.state, "ready");
});

test("unsupported SDK does not fall back to unsafe writes; manual medicine entry stays available", async () => {
  const h = setup({ sdk: "2.16.0" });
  await h.page.onRecognizePhoto("camera");
  assert.equal(h.calls.open + h.calls.write + h.calls.writeFile + h.calls.recognize, 0);
  assert.match(h.page.data.recognitionHint, /升级微信或手动录入/);
  await h.page.onSubmit();
  assert.equal(h.calls.create, 1);
});

test("identity change during native write leaves only the original household's reserved receipt", async () => {
  const h = setup({ write: (options, scope) => {
    scope.writeSessionScope({ userId: "synthetic-b", familyId: "other-family" });
    options.success({ bytesWritten: 4 });
  } });
  await h.page.onRecognizePhoto("camera");
  assert.equal(h.calls.recognize, 0);
  assert.equal(h.calls.close, 1);
  assert.equal(JSON.parse(h.storage.get(h.key))[0].photos[0].ownedLocal.state, "reserved");
  assert.equal([...h.storage.keys()].some(key => key.includes("synthetic-b")), false);
});

test("new page treats interrupted reserved writes as failed, never as a complete photo", async () => {
  const h = setup({ write: options => options.success({ bytesWritten: 1 }) });
  await h.page.onRecognizePhoto("camera");
  const persisted = JSON.parse(h.storage.get(h.key));
  persisted[0].status = "recognizing";
  h.storage.set(h.key, JSON.stringify(persisted));
  const restored = makePageContext(loadPage("pages/medicine-edit/medicine-edit.ts", h.options).definition);
  restored.loadPhotoDrafts();
  assert.equal(restored.data.photoDrafts[0].status, "failed");
  assert.equal(restored.data.photoDrafts[0].photos[0].ownedLocal.state, "reserved");
  restored.onSelectPhotoDraft({ currentTarget: { dataset: { id: restored.data.photoDrafts[0].id } } });
  assert.match(restored.data.recognitionHint, /删除这份照片草稿后重拍/);
});
