import test from "node:test";
import assert from "node:assert/strict";
import { loadApi } from "./runtime.mjs";

test("mobile request failures retain a safe specific cause, not user secrets", () => {
 const api = loadApi({wx:{getStorageSync:()=>null,setStorageSync:()=>{},removeStorageSync:()=>{}}});
 for (const [raw, expected] of [["request:fail url not in domain list", "微信域名校验拒绝"], ["request:fail ssl handshake error", "HTTPS证书"], ["request:fail ssl certificate domain mismatch", "HTTPS证书"], ["request:fail domain resolution ERR_NAME_NOT_RESOLVED", "ERR_NAME_NOT_RESOLVED"], ["request:fail timeout", "连接超时"], ["request:fail net::ERR_ADDRESS_INVALID token=private", "ERR_ADDRESS_INVALID"]]) {
  const error = api.networkFailureError({errMsg:raw});
  assert.equal(error.code,"NETWORK_ERROR"); assert.equal(error.statusCode,0);
  assert.ok(error.message.includes(expected)); assert.ok(!error.message.includes("private"));
 }
});
