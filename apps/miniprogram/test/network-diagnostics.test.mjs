import test from "node:test";
import assert from "node:assert/strict";
import { loadApi } from "./runtime.mjs";

test("network failures use friendly copy and only bounded diagnostics without secrets", (t) => {
  const logs = [];
  t.mock.method(console, "warn", (...args) => logs.push(args.join(" ")));
  const api = loadApi({ wx: { getStorageSync: () => null, setStorageSync() {}, removeStorageSync() {} } });
  for (const [raw, expected] of [
    ["request:fail url not in domain list", "微信域名校验拒绝"],
    ["request:fail ssl handshake error", "HTTPS证书或TLS校验失败"],
    ["request:fail ssl certificate domain mismatch", "HTTPS证书或TLS校验失败"],
    ["request:fail domain resolution ERR_NAME_NOT_RESOLVED", "ERR_NAME_NOT_RESOLVED"],
    ["request:fail timeout", "连接超时"],
    ["request:fail net::ERR_ADDRESS_INVALID token=private", "ERR_ADDRESS_INVALID"],
    ["request:fail https://private.invalid/?token=private ERR_PRIVATE_SECRET", "连接失败"],
  ]) {
    const error = api.networkFailureError({ errMsg: raw });
    assert.equal(error.code, "NETWORK_ERROR");
    assert.equal(error.statusCode, 0);
    assert.equal(error.message, "无法连接药箱服务，请检查网络后重试。");
    assert.equal(logs.at(-1), `[medbox] network failure: ${expected}`);
  }
  assert.doesNotMatch(logs.join("\n"), /private|token=|https:/i);
});
