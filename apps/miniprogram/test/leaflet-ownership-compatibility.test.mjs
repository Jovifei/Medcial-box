import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { setImmediate } from "node:timers/promises";
import { loadPage, makePageContext, makeSessionScopeModule } from "./runtime.mjs";

function fixture({ medicineId = "", choose, failUnlink = false } = {}) {
  const scope = makeSessionScopeModule({ userId: "synthetic-leaflet-user", familyId: "synthetic-leaflet-family" });
  const key = scope.scopedStorageKey("medicine-photo-drafts", medicineId);
  const storage = new Map(), calls = { open: [], write: 0, close: 0, unlink: [], recognize: [], upload: [], preview: [], fallback: 0 };
  let failCleanup = failUnlink;
  const native = {
    readFile: o => o.success({ data: "/9j/2Q==" }),
    open: o => { calls.open.push([o.filePath, o.flag]); o.success({ fd: "synthetic-fd" }); },
    write: o => { calls.write++; const receipt = storage.get(key)[0].photos[0].ownedLocal;
      assert.equal(receipt.state, "reserved"); assert.equal(receipt.scopeKey, key);
      o.success({ bytesWritten: o.data.byteLength }); },
    close: o => { calls.close++; o.success({}); },
    writeFile: () => { calls.fallback++; throw new Error("overwrite fallback forbidden"); },
    unlink: o => { calls.unlink.push(o.filePath); if (failCleanup) o.fail({ errMsg: "synthetic busy" }); else o.success({}); },
  };
  const result = loadPage("pages/medicine-edit/medicine-edit.ts", {
    setTimeoutFn: () => {}, modules: { "session-scope": scope,
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/api": { ApiError: class extends Error {}, api: {
        recognizeMedicine: async (...args) => { calls.recognize.push(args); return { warnings: [], draft: { name: null, specification: null, manufacturer: null, approvalNumber: null, purposeCategory: null } }; },
        createMedicine: async () => ({ id: "synthetic-saved", batches: [] }),
        uploadLeafletPhoto: async (...args) => { calls.upload.push(args); return { photo: { id: "synthetic-uploaded" } }; },
      } },
    }, wx: { env: { USER_DATA_PATH: "/synthetic-leaflet-owned" }, getSystemInfoSync: () => ({ SDKVersion: "3.17.3" }),
      getFileSystemManager: () => native, base64ToArrayBuffer: () => new Uint8Array([1, 2, 3, 4]).buffer,
      previewImage: value => calls.preview.push(value),
      chooseMedia: async () => choose ? choose(scope) : ({ tempFiles: [{ tempFilePath: "/synthetic-picker.jpg", size: 4 }] }),
      getStorageSync: k => storage.has(k) ? structuredClone(storage.get(k)) : undefined,
      setStorageSync: (k, v) => storage.set(k, structuredClone(v)), removeStorageSync: k => storage.delete(k),
    },
  });
  const page = makePageContext(result.definition); page.touchedFields = {};
  page.data.medicineId = medicineId; page.photoScopeKey = key; page.draftStorageKey = scope.scopedStorageKey("medicine-edit-draft", medicineId);
  page.data.name = "Synthetic leaflet medicine"; page.data.brand = "Synthetic preserved brand";
  page.data.leafletText = "Synthetic existing leaflet text";
  const capture = () => page.onRecognizePhoto({ currentTarget: { dataset: { source: "camera", purpose: "leaflet" } } });
  return { page, key, scope, storage, calls, capture, retry: () => { failCleanup = false; } };
}

test("leaflet capture retains purpose and durable ownership before exclusive byte-counted write", async () => {
  const h = fixture(); await h.capture();
  assert.equal(h.calls.open.length, 1); assert.equal(h.calls.open[0][1], "wx");
  assert.equal(h.calls.write, 1); assert.equal(h.calls.close, 1); assert.equal(h.calls.fallback, 0);
  const photo = h.storage.get(h.key)[0].photos[0];
  assert.equal(photo.purpose, "leaflet"); assert.match(photo.path, /-leaflet-\d+\.jpg$/);
  assert.equal(photo.ownedLocal.path, photo.path); assert.equal(photo.ownedLocal.state, "ready");
  assert.equal(photo.ownedLocal.byteLength, 4); assert.equal(h.calls.recognize[0][2], "leaflet");
  assert.equal(h.page.data.brand, "Synthetic preserved brand");
  assert.equal(h.page.data.leafletText, "Synthetic existing leaflet text");
});

test("leaflet upload retains purpose and cleanup removes only its acknowledged original", async () => {
  const h = fixture(); await h.capture(); const original = h.storage.get(h.key)[0].photos[0].path;
  await h.page.onSubmit();
  assert.equal(h.calls.upload.length, 1); assert.equal(h.calls.upload[0][4].purpose, "leaflet");
  assert.deepEqual(h.calls.unlink, [original]); assert.deepEqual(h.storage.get(h.key), []);
});

test("failed leaflet unlink retains cleanup receipt until an acknowledged retry", async () => {
  const h = fixture({ failUnlink: true }); await h.capture(); const entry = h.storage.get(h.key)[0];
  h.page.onDeletePhotoDraft({ currentTarget: { dataset: { id: entry.id } } }); await setImmediate();
  assert.equal(h.storage.get(h.key)[0].status, "cleanup_pending");
  assert.equal(h.storage.get(h.key)[0].photos[0].ownedLocal.path, entry.photos[0].path);
  h.retry(); await h.page.cleanupPhotoDrafts(); assert.deepEqual(h.storage.get(h.key), []);
});

test("leaflet path mismatch cannot unlink a differently owned purpose", async () => {
  const h = fixture(); await h.capture(); const entry = h.storage.get(h.key)[0];
  entry.photos[0].path = entry.photos[0].path.replace(/(photo-\d+-[a-z0-9]+)-leaflet-/, "$1-box_front-");
  entry.photos[0].ownedLocal.path = entry.photos[0].path; entry.status = "cleanup_pending";
  h.storage.set(h.key, [entry]); h.page.loadPhotoDrafts(); await setImmediate();
  assert.equal(h.calls.unlink.length, 0); assert.equal(h.storage.get(h.key).length, 1);
});

test("leaflet picker changing family cannot persist, recognize or replace original fields", async () => {
  const h = fixture({ choose: async scope => { scope.writeSessionScope({ userId: "synthetic-other", familyId: "synthetic-other-family" });
    return { tempFiles: [{ tempFilePath: "/synthetic-picker.jpg", size: 4 }] }; } });
  await h.capture(); assert.equal(h.calls.open.length, 0); assert.equal(h.calls.recognize.length, 0);
  assert.equal(h.storage.has(h.key), false); assert.equal(h.page.data.brand, "Synthetic preserved brand");
});

test("editing leaflet preserves medicine-specific photo draft storage and ownership key", async () => {
  const h = fixture({ medicineId: "synthetic-edit-id" }); await h.capture();
  assert.equal(h.calls.recognize.length, 1, JSON.stringify({calls: h.calls, hint: h.page.data.recognitionHint, key: h.key, photoKey: h.page.photoScopeKey})); assert.equal(h.storage.get(h.key)[0].photos[0].ownedLocal.scopeKey, h.key);
  assert.equal(h.storage.has(h.scope.scopedStorageKey("medicine-photo-drafts")), false);
});

test("actual date component event reaches onExpiryDateChange, truncates day and clears month", () => {
  let component;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../components/medicine-date-field/index.ts", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { Component: value => { component = value; }, Date });
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", { modules: {
    "../../services/api": { api: {}, ApiError: class extends Error {} }, "../../services/auth": {},
  } }); const page = makePageContext(definition);
  page.data.batches[0].expiryValue = "2028-02-29"; page.data.batches[0].precisionIndex = 0;
  const c = { properties: { disabled: false, allowPrecision: true, precision: "day", value: "2028-02-29" },
    triggerEvent: (name, detail) => { assert.equal(name, "change"); page.onExpiryDateChange({ currentTarget: { dataset: { index: "0" } }, detail }); } };
  component.methods.onPrecisionChange.call(c, { detail: { value: 0 } });
  assert.equal(page.data.batches[0].expiryValue, "2028-02"); assert.equal(page.data.batches[0].precisionIndex, 1);
  c.properties.precision = "month"; c.properties.value = "2028-02";
  component.methods.onPrecisionChange.call(c, { detail: { value: 1 } });
  assert.equal(page.data.batches[0].expiryValue, ""); assert.equal(page.data.batches[0].precisionIndex, 0);
});

test("family switch cannot preview the old form's leaflet path", () => {
  const h = fixture(); h.page.data.photoDrafts = [{ id: "synthetic-preview", thumbnail: "/synthetic-owned-preview.jpg", photos: [{ path: "/synthetic-owned-preview.jpg" }] }];
  h.scope.writeSessionScope({ userId: "synthetic-other", familyId: "synthetic-other-family" });
  h.page.onPreviewEntryPhoto({ currentTarget: { dataset: { id: "synthetic-preview" } } });
  assert.equal(h.calls.preview.length, 0);
});

test("legacy leaflet without ownership receipt remains recoverable and is never unlinked", async () => {
  const h = fixture(); const original = { id: "photo-123-abc", status: "saved", medicineId: "synthetic-saved", fields: {}, photos: [
    { path: "/synthetic-leaflet-owned/photo-123-abc-leaflet-456.jpg", purpose: "leaflet", mimeType: "image/jpeg", uploadedId: "synthetic-upload", batchIndex: 0 },
  ] }; h.storage.set(h.key, [structuredClone(original)]); h.page.loadPhotoDrafts(); await setImmediate();
  assert.equal(h.calls.unlink.length, 0); assert.deepEqual(h.storage.get(h.key), [original]);
});
