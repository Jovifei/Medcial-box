import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import { loadPage, makePageContext, makeSessionScopeModule } from "./runtime.mjs";
import { ownedPhotoFixture } from "./support/owned-photo-fixture.mjs";

class ApiError extends Error { constructor(code) { super("RAW https://private.invalid TOKEN secret"); this.code = code; } }
function setup(recognize) {
  const native = ownedPhotoFixture();
  const scope = makeSessionScopeModule({ userId: "synthetic", familyId: "family" });
  const key = scope.scopedStorageKey("medicine-photo-drafts");
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    setTimeoutFn: () => 0,
    modules: {
      "session-scope": scope,
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/api": { ApiError, api: { recognizeMedicine: recognize, findMedicineCandidates: async () => ({ candidates: [], warnings: [] }) } },
    },
    wx: { ...native, chooseMedia: async () => ({ tempFiles: [{ tempFilePath: "/synthetic.jpg", size: 4 }] }), scanCode: options => options.success({ result: "6900000000012" }) },
  });
  const open = () => { const p = makePageContext(definition); p.onLoad({}); return p; };
  return { native, scope, key, open, read: () => native.getStorageSync(key) ?? [] };
}

for (const [code, category] of [["NETWORK_ERROR", "network"], ["RECOGNITION_UNAVAILABLE", "recognition_service"], ["RAW secret", "unknown"]]) {
  test(`fixed ${category} survives scanning and explicit import, excludes raw errors and clears after success`, async () => {
    let fail = true;
    const h = setup(async () => { if (fail) throw new ApiError(code); return { draft: {}, warnings: [] }; });
    const page = h.open();
    await page.checkEntrySession();
    await page.onRecognizePhoto("camera");
    assert.equal(h.read()[0].status, "failed");
    assert.equal(h.read()[0].failureCode, category);
    await page.onScanCode();
    assert.equal(h.read()[0].failureCode, category);
    assert.doesNotMatch(JSON.stringify(h.read()), /private\.invalid|TOKEN|secret|RAW/);
    const next = h.open(); await next.checkEntrySession();
    assert.deepEqual(next.data.photoDrafts, []);
    await next.onRestoreDraft();
    assert.equal(next.data.photoDrafts[0].failureCode, category);
    next.onSelectPhotoDraft({ currentTarget: { dataset: { id: h.read()[0].id } } });
    fail = false;
    await next.onRecognizePhoto("camera");
    assert.equal(h.read()[0].status, "review");
    assert.equal(h.read()[0].failureCode, null);
  });
}

test("late photo error after family switch cannot store a failure category", async () => {
  let reject;
  const h = setup(() => new Promise((_resolve, fail) => { reject = fail; }));
  const page = h.open(); await page.checkEntrySession();
  const pending = page.onRecognizePhoto("camera");
  for (let i = 0; i < 30 && !reject; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(reject);
  const before = h.read();
  h.scope.writeSessionScope({ userId: "synthetic", familyId: "other" });
  reject(new ApiError("NETWORK_ERROR")); await pending;
  assert.deepEqual(h.read(), before);
});

test("legacy photo drafts without a failure code remain explicitly importable", async () => {
  const h = setup(async () => { throw Error("RAW secret"); });
  const page = h.open(); await page.checkEntrySession(); await page.onRecognizePhoto("camera");
  const legacy = h.read(); delete legacy[0].failureCode;
  h.native.setStorageSync(h.key, legacy);
  const next = h.open(); await next.checkEntrySession(); await next.onRestoreDraft();
  assert.equal(next.data.photoDrafts[0].status, "failed");
  assert.equal(next.data.photoDrafts[0].failureCode, null);
});

test("failed local write stores only local_storage, while a failed read before registration creates no draft", async () => {
  for (const stage of ["readFile", "write"]) {
    const h = setup(async () => assert.fail("local failure must not dispatch recognition"));
    h.native.getFileSystemManager()[stage] = options => options.fail({ errMsg: "RAW https://private.invalid TOKEN secret" });
    const page = h.open(); await page.checkEntrySession(); await page.onRecognizePhoto("camera");
    if (stage === "readFile") assert.deepEqual(h.read(), []);
    else {
      assert.equal(h.read()[0].status, "failed");
      assert.equal(h.read()[0].failureCode, "local_storage");
      assert.doesNotMatch(JSON.stringify(h.read()), /RAW|private\.invalid|TOKEN|secret/);
    }
  }
});
