import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateRequest } = require("../../../cloudfunctions/aiRelay/validate.js");

test("aiRelay accepts a valid text request and defaults to the gift model", () => {
  const result = validateRequest({ messages: [{ role: "user", content: "  请用一句话说明这是虚构测试。  " }] });
  assert.equal(result.ok, true);
  assert.equal(result.model, "deepseek-v4.1-flash");
  assert.deepEqual(result.messages, [{ role: "user", content: "请用一句话说明这是虚构测试。" }]);
});

test("aiRelay rejects malformed or over-limit requests", () => {
  assert.equal(validateRequest(null).code, "INVALID_REQUEST");
  assert.equal(validateRequest({ messages: [] }).code, "INVALID_MESSAGES");
  assert.equal(validateRequest({ model: "unknown-model", messages: [{ role: "user", content: "hi" }] }).code, "MODEL_NOT_ALLOWED");
  assert.equal(validateRequest({ messages: [{ role: "tool", content: "hi" }] }).code, "INVALID_MESSAGES");
  assert.equal(validateRequest({ messages: [{ role: "user", content: "   " }] }).code, "INVALID_MESSAGES");
  assert.equal(validateRequest({ messages: [{ role: "user", content: "x".repeat(4001) }] }).code, "INVALID_MESSAGES");
  assert.equal(validateRequest({ messages: Array.from({ length: 21 }, () => ({ role: "user", content: "hi" })) }).code, "INVALID_MESSAGES");
  assert.equal(validateRequest({ messages: [{ role: "system", content: "only system" }] }).code, "INVALID_MESSAGES");
});

test("aiRelay accepts allowlisted models", () => {
  for (const model of ["deepseek-v4.1-flash", "deepseek-v4.1-flash-1017", "hy3", "hy4", "hy4-preview"]) {
    const result = validateRequest({ model, messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.ok, true, model);
    assert.equal(result.model, model);
  }
});