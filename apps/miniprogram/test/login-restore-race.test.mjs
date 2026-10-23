import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext } from "./runtime.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const restore = deferred();
  const login = deferred();
  const routes = [];
  const { definition } = loadPage("pages/login/login.ts", {
    modules: {
      "../../services/api": {
        api: { getAuthMe: async () => ({ family: null }) },
        ApiError: class ApiError extends Error {},
        readToken: () => "old-token",
      },
      "../../services/auth": {
        ensureLoggedIn: () => restore.promise,
        loginWithWechat: () => login.promise,
      },
    },
    wx: { reLaunch: ({ url }) => routes.push(url) },
  });
  return { page: makePageContext(definition), restore, login, routes };
}

async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test("stale restore failure cannot show an error after the user starts WeChat login", async () => {
  const f = fixture();
  f.page.onLoad({});
  const active = f.page.onLogin();
  f.restore.reject(new Error("synthetic old restore failure"));
  await settle();
  f.login.resolve({ hasFamily: true });
  await active;
  assert.equal(f.page.data.errorMessage, "");
  assert.deepEqual(f.routes, ["/pages/index/index"]);
});

test("stale restore success cannot redirect away after a newer login succeeded", async () => {
  const f = fixture();
  f.page.onLoad({});
  const active = f.page.onLogin();
  f.login.resolve({ hasFamily: true });
  await active;
  f.restore.resolve("old-token");
  await settle();
  assert.deepEqual(f.routes, ["/pages/index/index"]);
});