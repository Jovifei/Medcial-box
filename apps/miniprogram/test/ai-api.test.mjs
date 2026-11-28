import assert from "node:assert/strict";
import test from "node:test";
import { loadService } from "./runtime.mjs";

function fakeWx(calls, response) {
  return {
    cloud: {
      init(options) { calls.push({ kind: "init", options }); },
      async callFunction(options) { calls.push({ kind: "call", options }); return response; },
    },
  };
}

test("ai api initializes the configured cloud environment once", () => {
  const calls = [];
  const service = loadService("services/ai-api.ts", { wx: fakeWx(calls, { result: { success: true, text: "ok" } }) });
  service.initAiCloud();
  service.initAiCloud();
  assert.equal(calls.filter((call) => call.kind === "init").length, 1);
  assert.equal(calls[0].options.env, "yaoxiagn-d2goac4i31a1c8485");
});

test("ai api calls aiRelay with trimmed messages and returns text", async () => {
  const calls = [];
  const service = loadService("services/ai-api.ts", {
    wx: fakeWx(calls, { result: { success: true, text: " 合成摘要 ", usage: { total_tokens: 12 } } }),
  });
  const result = await service.generateAiText([{ role: "user", content: " 请总结：测试药品甲 " }]);
  assert.equal(result.text, "合成摘要");
  assert.deepEqual(result.usage, { total_tokens: 12 });
  const call = calls.find((entry) => entry.kind === "call");
  assert.equal(call.options.name, "aiRelay");
  assert.equal(call.options.data.model, "deepseek-v4.1-flash");
  assert.equal(JSON.stringify(call.options.data.messages), JSON.stringify([{ role: "user", content: "请总结：测试药品甲" }]));
});

test("ai api rejects invalid messages before calling the cloud function", async () => {
  const calls = [];
  const service = loadService("services/ai-api.ts", { wx: fakeWx(calls, { result: { success: true, text: "ok" } }) });
  await assert.rejects(() => service.generateAiText([]), (error) => error.code === "INVALID_MESSAGES");
  await assert.rejects(() => service.generateAiText([{ role: "user", content: "   " }]), (error) => error.code === "INVALID_MESSAGES");
  await assert.rejects(() => service.generateAiText([{ role: "user", content: "x".repeat(4001) }]), (error) => error.code === "INVALID_MESSAGES");
  assert.equal(calls.filter((entry) => entry.kind === "call").length, 0);
});

test("ai api reports a clear error when cloud development is unavailable", async () => {
  const service = loadService("services/ai-api.ts", { wx: {} });
  await assert.rejects(() => service.generateAiText([{ role: "user", content: "你好" }]), (error) => error.code === "CLOUD_UNAVAILABLE");
});

test("ai api maps upstream failures to clear client errors", async () => {
  const service = loadService("services/ai-api.ts", {
    wx: fakeWx([], { result: { success: false, code: "EXCEED_CONCURRENT_REQUEST_LIMIT", error: "当前使用人数较多，请稍后重试" } }),
  });
  await assert.rejects(
    () => service.generateAiText([{ role: "user", content: "你好" }]),
    (error) => error.code === "EXCEED_CONCURRENT_REQUEST_LIMIT" && error.message === "当前使用人数较多，请稍后重试",
  );
});