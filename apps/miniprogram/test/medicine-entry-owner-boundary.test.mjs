import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext, makeSessionScopeModule } from "./runtime.mjs";

class ApiError extends Error {}
function setup({ api = {}, wx = {}, ensureLoggedIn = async () => {} } = {}) {
  const scope = makeSessionScopeModule({ userId: "original-user", familyId: "original-family" });
  const calls = { writes: [], unlinks: [], navigation: 0 };
  const storage = new Map();
  const loaded = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "session-scope": scope,
      "../../services/auth": { ensureLoggedIn: () => ensureLoggedIn(scope) },
      "../../services/api": { ApiError, api },
    },
    setTimeoutFn: () => {},
    wx: {
      env: { USER_DATA_PATH: "/owned" },
      getFileSystemManager: () => ({
        readFile: options => options.success({ data: "/9j/fixture" }),
        unlink: options => { calls.unlinks.push(options.filePath); options.success?.({}); },
      }),
      getStorageSync: key => storage.has(key) ? structuredClone(storage.get(key)) : undefined,
      setStorageSync: (key, value) => { calls.writes.push([key, value]); storage.set(key, structuredClone(value)); },
      removeStorageSync: key => storage.delete(key),
      switchTab: () => calls.navigation++,
      ...wx,
    },
  });
  const page = makePageContext(loaded.definition);
  page.data.name = "Original household medicine";
  page.photoScopeKey = scope.scopedStorageKey("medicine-photo-drafts");
  page.draftStorageKey = scope.scopedStorageKey("medicine-edit-draft");
  return { page, scope, calls };
}
const changeOwner = scope => scope.writeSessionScope({ userId: "other-user", familyId: "other-family" });
function photos(page) {
  page.data.photoDrafts = [{ id: "photo-1-a", status: "review", fields: {}, medicineId: "", photos: [
    { path: "/owned/photo-1-a-box_front-2.jpg", mimeType: "image/jpeg", purpose: "box_front", batchIndex: 0,
      ownedLocal: { path: "/owned/photo-1-a-box_front-2.jpg", scopeKey: page.photoScopeKey, draftId: "photo-1-a", state: "ready", byteLength: 200 } },
    { path: "/owned/photo-1-a-expiry-3.jpg", mimeType: "image/jpeg", purpose: "expiry", batchIndex: 0,
      ownedLocal: { path: "/owned/photo-1-a-expiry-3.jpg", scopeKey: page.photoScopeKey, draftId: "photo-1-a", state: "ready", byteLength: 200 } },
  ] }];
  page.data.activePhotoDraftId = "photo-1-a";
}

test("login changing household never submits an open medicine form into the new household", async () => {
  let creates = 0;
  const { page, calls } = setup({ ensureLoggedIn: changeOwner, api: { createMedicine: async () => { creates++; } } });
  await page.onSubmit();
  assert.equal(creates, 0);
  assert.equal(calls.writes.some(([key]) => key.includes("other-user")), false);
  assert.equal(page.data.name, "Original household medicine");
});

test("an already stale open form cannot adopt a newer household before starting save", async () => {
  let creates = 0;
  const { page, scope } = setup({ api: { createMedicine: async () => { creates++; } } });
  changeOwner(scope);
  await page.onSubmit();
  assert.equal(creates, 0);
});

test("photo picker returning after a household switch does not read or send the selected image", async () => {
  let reads = 0;
  let recognizes = 0;
  let scope;
  const context = setup({
    api: { recognizeMedicine: async () => { recognizes++; } },
    wx: {
      chooseMedia: async () => { changeOwner(scope); return { tempFiles: [{ tempFilePath: "/temporary.jpg", size: 10 }] }; },
      getFileSystemManager: () => ({ readFile: options => { reads++; options.success({ data: "/9j/fixture" }); } }),
    },
  });
  scope = context.scope;
  await context.page.onRecognizePhoto("camera");
  assert.equal(reads, 0);
  assert.equal(recognizes, 0);
  assert.equal(context.page.data.photoDrafts.length, 0);
});

test("photo bytes completing after a household switch never start an upload", async () => {
  let uploads = 0;
  let scope;
  const context = setup({
    api: { createMedicine: async () => ({ id: "saved-original", batches: [{ id: "batch" }] }), uploadLeafletPhoto: async () => { uploads++; } },
    wx: { getFileSystemManager: () => ({ readFile: options => { changeOwner(scope); options.success({ data: "/9j/private" }); } }) },
  });
  scope = context.scope;
  photos(context.page);
  await context.page.onSubmit();
  assert.equal(uploads, 0);
  assert.equal(context.page.data.photoDrafts.length, 1);
});

test("late upload completion cannot start another upload, set a cover, or clean private files", async () => {
  let uploads = 0;
  let covers = 0;
  let scope;
  const context = setup({ api: {
    createMedicine: async () => ({ id: "saved-original", batches: [{ id: "batch" }] }),
    uploadLeafletPhoto: async () => { uploads++; changeOwner(scope); return { photo: { id: "uploaded" } }; },
    setMedicineCover: async () => { covers++; },
  } });
  scope = context.scope;
  photos(context.page);
  await context.page.onSubmit();
  assert.equal(uploads, 1);
  assert.equal(covers, 0);
  assert.equal(context.calls.unlinks.length, 0);
  assert.equal(context.page.data.photoDrafts.length, 1);
  assert.equal(context.calls.writes.some(([key]) => key.includes("other-user")), false);
});

test("delayed delete confirmation cannot delete a later household's draft with the same id", () => {
  let modal;
  const { page, scope, calls } = setup({ wx: { showModal: options => { modal = options; } } });
  photos(page);
  page.onDeletePhotoDraft({ currentTarget: { dataset: { id: "photo-1-a" } } });
  changeOwner(scope);
  page.photoScopeKey = scope.scopedStorageKey("medicine-photo-drafts");
  const replacement = { id: "photo-1-a", status: "review", fields: {}, photos: [{ path: "/owned/other.jpg" }] };
  page.data.photoDrafts = [replacement];
  modal.success({ confirm: true });
  assert.equal(page.data.photoDrafts[0], replacement);
  assert.equal(calls.unlinks.length, 0);
  assert.equal(calls.writes.length, 0);
});

for (const method of ["onScanCode", "onRetryBarcodeLookup"]) {
  test(`${method}: login switching household sends no barcode query`, async () => {
    let queries = 0;
    const { page } = setup({ ensureLoggedIn: changeOwner,
      api: { findMedicineCandidates: async () => { queries++; return { candidates: [], warnings: [] }; } },
      wx: { scanCode: options => options.success({ result: "SYNTHETIC-CODE" }) },
    });
    page.data.scannedBarcode = "SYNTHETIC-CODE";
    await page[method]();
    assert.equal(queries, 0);
    assert.equal(page.data.recognizing, false);
  });

  test(`${method}: late query result cannot replace another household's candidates`, async () => {
    let scope;
    const context = setup({ api: { findMedicineCandidates: async () => {
      changeOwner(scope);
      return { candidates: [{ name: "Old household candidate" }], warnings: [] };
    } }, wx: { scanCode: options => options.success({ result: "SYNTHETIC-CODE" }) } });
    scope = context.scope;
    context.page.data.scannedBarcode = "SYNTHETIC-CODE";
    await context.page[method]();
    assert.equal(context.page.data.candidates.length, 0);
    assert.equal(context.page.data.name, "Original household medicine");
  });
}

test("scan consent returning after identity change never opens the scanner", async () => {
  let scans = 0;
  let scope;
  const context = setup({ wx: {
    showModal: options => { changeOwner(scope); options.success({ confirm: true }); },
    scanCode: options => { scans++; options.success({ result: "SYNTHETIC-CODE" }); },
  } });
  scope = context.scope;
  await context.page.onScanCode();
  assert.equal(scans, 0);
});

test("medicine load cannot read an old id using the household acquired during login", async () => {
  let reads = 0;
  const { page } = setup({ ensureLoggedIn: changeOwner, api: { getMedicine: async () => { reads++; } } });
  await page.loadMedicine("old-medicine");
  assert.equal(reads, 0);
  assert.equal(page.data.name, "Original household medicine");
});

test("late medicine read cannot overwrite the current household form", async () => {
  let scope;
  const context = setup({ api: { getMedicine: async () => {
    changeOwner(scope);
    return { name: "Old private medicine", activeIngredients: [], leaflet: { reviewStatus: "unverified" }, batches: [], version: 1 };
  } } });
  scope = context.scope;
  await context.page.loadMedicine("old-medicine");
  assert.equal(context.page.data.name, "Original household medicine");
  assert.equal(context.calls.writes.length, 0);
});

test("cold unowned medicine page can bind after concurrent session setup finishes", async () => {
  let page;
  let reads = 0;
  const context = setup({ ensureLoggedIn: async scope => {
    scope.writeSessionScope({ userId: "fresh-user", familyId: "fresh-family" });
    page.refreshDraftScope();
    page.photoScopeKey = scope.scopedStorageKey("medicine-photo-drafts");
  }, api: { getMedicine: async () => {
    reads++;
    return { name: "Fresh medicine", activeIngredients: [], leaflet: { reviewStatus: "unverified" }, batches: [], version: 1 };
  } } });
  page = context.page;
  context.scope.clearSessionScope();
  page.draftStorageKey = null;
  page.photoScopeKey = null;
  await page.loadMedicine("fresh-medicine");
  assert.equal(reads, 1);
  assert.equal(page.data.name, "Fresh medicine");
});
