import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext, makeSessionScopeModule } from "./runtime.mjs";

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture({ sdk = false, modal = false } = {}) {
  const gate = deferred();
  const scope = makeSessionScopeModule();
  let timer = 0;
  let stops = 0;
  let calls = 0;
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    setTimeoutFn: () => ++timer,
    modules: {
      "session-scope": scope,
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/api": { ApiError: class extends Error {}, api: { findMedicineCandidates: () => { calls++; return gate.promise; } } },
    },
    wx: {
      scanCode: options => sdk ? gate.promise.then(options.success, options.fail) : options.success({ result: "6900000000012" }),
      ...(modal ? { showModal: options => gate.promise.then(options.success) } : {}),
    },
  });
  const page = makePageContext(definition); page.onLoad({});
  const originalStop = page.stopRecognitionClock;
  page.stopRecognitionClock = function () { stops++; originalStop.call(this); };
  return { page, scope, gate, calls: () => calls, stops: () => stops };
}

for (const method of ["onScanCode", "onRetryBarcodeLookup"]) {
  for (const boundary of ["unload", "family", "new intent"]) {
    for (const outcome of ["success", "failure"]) {
      test(`${method} late ${outcome} after ${boundary} cannot rewrite state or stop another clock`, async () => {
        const f = fixture(); await f.page.checkEntrySession();
        f.page.data.scannedBarcode = "6900000000012";
        const pending = f.page[method]();
        for (let i = 0; i < 12 && !f.calls(); i++) await Promise.resolve();
        assert.equal(f.calls(), 1);
        if (boundary === "unload") f.page.onUnload();
        else if (boundary === "family") f.scope.writeSessionScope({ userId: "test-user", familyId: "other-family" });
        else { f.page.recognitionToken++; f.page.startRecognitionClock("New photo intent"); }
        f.page.setData({ barcodeLookupStatus: "Current operation", candidates: [], recognitionHint: "Current hint" });
        const before = JSON.stringify(f.page.data);
        const timer = f.page.recognitionTimer;
        const stops = f.stops();
        if (outcome === "success") f.gate.resolve({ candidates: [{ name: "Obsolete candidate" }], warnings: [] });
        else f.gate.reject(new Error("Synthetic obsolete failure"));
        await pending;
        assert.equal(JSON.stringify(f.page.data), before);
        assert.equal(f.page.recognitionTimer, timer);
        assert.equal(f.stops(), stops);
      });
    }
  }
}

test("a late SDK scan result after another intent cannot populate a code or stop its clock", async () => {
  const f = fixture({ sdk: true }); await f.page.checkEntrySession();
  const pending = f.page.onScanCode();
  await Promise.resolve(); await Promise.resolve();
  f.page.recognitionToken++; f.page.startRecognitionClock("New intent");
  const before = JSON.stringify(f.page.data); const timer = f.page.recognitionTimer; const stops = f.stops();
  f.gate.resolve({ result: "6900000000012" }); await pending;
  assert.equal(f.calls(), 0);
  assert.equal(JSON.stringify(f.page.data), before);
  assert.equal(f.page.recognitionTimer, timer);
  assert.equal(f.stops(), stops);
});

for (const method of ["onScanCode", "onRetryBarcodeLookup"]) {
  test(`${method} ignores consent resolved after another operation starts`, async () => {
    const f = fixture({ modal: true }); await f.page.checkEntrySession();
    f.page.data.scannedBarcode = "6900000000012";
    const pending = f.page[method](); await Promise.resolve();
    f.page.recognitionToken++; f.page.startRecognitionClock("New intent");
    const before = JSON.stringify(f.page.data); const timer = f.page.recognitionTimer; const stops = f.stops();
    f.gate.resolve({ confirm: true }); await pending;
    assert.equal(f.calls(), 0);
    assert.equal(JSON.stringify(f.page.data), before);
    assert.equal(f.page.recognitionTimer, timer);
    assert.equal(f.stops(), stops);
  });
}

test("same-family scans waiting on one medicine load dispatch only the latest operation", async () => {
  const f = fixture(); await f.page.checkEntrySession();
  const loading = deferred(); f.page.medicineLoadPromise = loading.promise;
  const first = f.page.onScanCode();
  const second = f.page.onScanCode();
  loading.resolve();
  for (let i = 0; i < 20 && !f.calls(); i++) await Promise.resolve();
  assert.equal(f.calls(), 1);
  f.gate.resolve({ candidates: [], warnings: [] });
  await Promise.all([first, second]);
  assert.equal(f.page.data.recognizing, false);
  assert.equal(f.page.data.scannedBarcode, "6900000000012");
});
