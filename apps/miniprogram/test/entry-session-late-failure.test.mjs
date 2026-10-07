import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, loadService, makePageContext, makeSessionScopeModule } from "./runtime.mjs";
class ApiError extends Error {
  constructor(code, message = "synthetic auth failure", statusCode = 401, invalidatedSession) {
    super(message); Object.assign(this, { code, statusCode, invalidatedSession });
  }
}
function fixture(initial = { userId: "synthetic-user", familyId: "synthetic-family" }, authOverride) {
  const scope = makeSessionScopeModule(initial); let reject;
  const calls = { navigation: [], toasts: [] };
  const identity = { token: "synthetic-empty", generation: 2 };
  let currentIdentity = identity;
  const apiModule = { ApiError, api: {}, isCurrentSession: value => value === currentIdentity };
  const page = makePageContext(loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: { "session-scope": scope, "../../services/api": apiModule,
      "../../services/auth": authOverride ?? { ensureLoggedIn: () => new Promise((_, fail) => { reject = fail; }) } },
    setTimeoutFn: () => {}, wx: { redirectTo: options => calls.navigation.push(options.url), showToast: options => calls.toasts.push(options.title) },
  }).definition);
  return { page, scope, calls, identity, reject: error => reject(error),
    advanceGeneration: () => { currentIdentity = { token: "synthetic-new-session", generation: identity.generation + 1 }; } };
}
for (const transition of ["unload", "family", "account", "logout"]) for (const error of [new ApiError("UNAUTHENTICATED"), new Error("synthetic offline")]) {
  test(`${transition}: late ${error.code ?? "generic"} failure cannot navigate or show a toast`, async () => {
    const f = fixture(); const pending = f.page.checkEntrySession();
    if (transition === "unload") f.page.onUnload();
    else if (transition === "logout") f.scope.clearSessionScope();
    else f.scope.writeSessionScope({ userId: transition === "account" ? "synthetic-other-user" : "synthetic-user", familyId: "synthetic-other-family" });
    const before = JSON.stringify(f.page.data); f.reject(error); await pending;
    assert.deepEqual(f.calls.navigation, []); assert.deepEqual(f.calls.toasts, []); assert.equal(JSON.stringify(f.page.data), before);
  });
}
for (const initial of [{ userId: "synthetic-user", familyId: "synthetic-family" }, null]) test(`current ${initial ? "owned" : "cold"} page still redirects on UNAUTHENTICATED`, async () => {
  const f = fixture(initial); const pending = f.page.checkEntrySession(); f.reject(new ApiError("UNAUTHENTICATED")); await pending;
  assert.equal(f.calls.navigation.length, 1); assert.match(f.calls.navigation[0], /^\/pages\/login\/login\?redirect=/); assert.deepEqual(f.calls.toasts, []);
});
test("current page still shows ordinary non-auth failure", async () => {
  const f = fixture(); const pending = f.page.checkEntrySession(); f.reject(new Error("synthetic offline")); await pending;
  assert.deepEqual(f.calls.navigation, []); assert.equal(f.calls.toasts.length, 1);
});
test("current request's verified own invalidation still redirects after auth clears scope", async () => {
  const f = fixture(); const pending = f.page.checkEntrySession(); f.scope.clearSessionScope();
  f.reject(new ApiError("UNAUTHENTICATED", "synthetic expiry", 401, f.identity)); await pending;
  assert.equal(f.calls.navigation.length, 1); assert.deepEqual(f.calls.toasts, []);
});
test("real auth service preserves its verified own invalidation receipt for the current page", async () => {
  const scope = makeSessionScopeModule(); const invalidated = { token: "", generation: 2 };
  const auth = loadService("services/auth.ts", { modules: { "session-scope": scope, "./api": {
    ApiError, captureSessionIdentity: () => ({ token: "synthetic-old", generation: 1 }),
    isCurrentSession: value => value === invalidated,
    api: { getAuthMe: async () => { throw new ApiError("UNAUTHORIZED", "synthetic expiry", 401, invalidated); } },
  } } });
  await assert.rejects(auth.ensureLoggedIn({ allowInteractive: false }), error => error.code === "UNAUTHENTICATED" && error.invalidatedSession === invalidated);
});

for (const code of ["UNAUTHENTICATED", "UNAUTHORIZED"]) test(`cold null-scope ${code} with stale receipt cannot interrupt a newer generation`, async () => {
  const f = fixture(null); const pending = f.page.checkEntrySession();
  const before = JSON.stringify(f.page.data);
  // Auth's receipt was current before the newer session transition; both scopes remain null.
  f.advanceGeneration(); f.reject(new ApiError(code, "synthetic old expiry", 401, f.identity)); await pending;
  assert.equal(f.scope.readSessionScope(), null);
  assert.deepEqual(f.calls.navigation, []); assert.deepEqual(f.calls.toasts, []); assert.equal(JSON.stringify(f.page.data), before);
});
test("cold null-scope current receipt still permits the normal 401 redirect", async () => {
  const f = fixture(null); const pending = f.page.checkEntrySession();
  f.reject(new ApiError("UNAUTHENTICATED", "synthetic current expiry", 401, f.identity)); await pending;
  assert.equal(f.calls.navigation.length, 1); assert.deepEqual(f.calls.toasts, []);
});
