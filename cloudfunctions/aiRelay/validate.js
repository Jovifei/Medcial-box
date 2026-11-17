"use strict";

// 云函数入参校验：不信任小程序端传入的模型、角色与长度。
// 模型白名单只包含成长计划礼包覆盖的文本模型；默认 deepseek-v4.1-flash。
const ALLOWED_MODELS = new Set([
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
  "hy3",
  "hy4",
  "hy4-preview",
]);
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);
const MAX_MESSAGES = 20;
const MAX_CHARS = 4000;
const DEFAULT_MODEL = "deepseek-v4.1-flash";

function fail(code, error) {
  return { ok: false, code, error };
}

function validateRequest(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return fail("INVALID_REQUEST", "请求格式不正确");
  }
  const model = event.model === undefined ? DEFAULT_MODEL : event.model;
  if (typeof model !== "string" || !ALLOWED_MODELS.has(model)) {
    return fail("MODEL_NOT_ALLOWED", "该 AI 模型不可用");
  }
  const messages = event.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return fail("INVALID_MESSAGES", "消息数量不合法");
  }
  const normalized = [];
  for (const message of messages) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      return fail("INVALID_MESSAGES", "消息格式不合法");
    }
    if (typeof message.role !== "string" || !ALLOWED_ROLES.has(message.role)) {
      return fail("INVALID_MESSAGES", "消息角色不合法");
    }
    if (typeof message.content !== "string") {
      return fail("INVALID_MESSAGES", "消息内容不合法");
    }
    const content = message.content.trim();
    if (content === "" || content.length > MAX_CHARS) {
      return fail("INVALID_MESSAGES", "消息内容长度不合法");
    }
    normalized.push({ role: message.role, content });
  }
  if (!normalized.some((message) => message.role === "user")) {
    return fail("INVALID_MESSAGES", "至少需要一条用户消息");
  }
  return { ok: true, model, messages: normalized };
}

module.exports = { ALLOWED_MODELS, DEFAULT_MODEL, MAX_MESSAGES, MAX_CHARS, validateRequest };