"use strict";

/**
 * aiRelay：小程序 AI 文本中转云函数。
 * - 只接收小程序端的消息数组，统一校验后调用成长计划礼包文本模型；
 * - 只记录用量与长度，不保存用户原文；
 * - 上游异常返回明确错误码，不静默失败。
 */
const cloud = require("wx-server-sdk");
const { validateRequest } = require("./validate");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 60000 });

const MODEL_PROVIDER = "cloudbase";

function messageForError(code) {
  if (code === "EXCEED_CONCURRENT_REQUEST_LIMIT") return "当前使用人数较多，请稍后重试";
  if (code === "AI_CHANNEL_NOT_ALLOWED") return "当前云环境未获授权使用该模型";
  if (/MODEL.*NOT.*FOUND|MODEL_NOT_FOUND/i.test(code)) return "AI 模型暂不可用，请稍后重试";
  return "AI 服务暂时不可用，请稍后重试";
}

async function logUsage(entry) {
  // 用量日志失败不应让用户请求失败；错误只留在云函数日志里。
  try {
    await cloud.database().collection("ai_usage").add({
      data: { ...entry, createdAt: cloud.database().serverDate() },
    });
  } catch (error) {
    console.error("ai_usage write failed", error && error.message ? error.message : error);
  }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext() || {};
  const openid = wxContext.OPENID || "";
  const parsed = validateRequest(event);
  if (!parsed.ok) {
    await logUsage({ openid, model: event && event.model ? String(event.model) : "", ok: false, errorCode: parsed.code, textLength: 0 });
    return { success: false, code: parsed.code, error: parsed.error };
  }

  const startedAt = Date.now();
  try {
    const ai = cloud.ai();
    const model = ai.createModel(MODEL_PROVIDER);
    const result = await model.generateText({ model: parsed.model, messages: parsed.messages });
    const text = result && typeof result.text === "string" ? result.text.trim() : "";
    if (text === "") {
      await logUsage({ openid, model: parsed.model, ok: false, errorCode: "AI_EMPTY_RESPONSE", textLength: 0, durationMs: Date.now() - startedAt });
      return { success: false, code: "AI_EMPTY_RESPONSE", error: "AI 没有返回内容，请稍后重试" };
    }
    const usage = result && result.usage ? result.usage : null;
    await logUsage({ openid, model: parsed.model, ok: true, usage, textLength: text.length, durationMs: Date.now() - startedAt });
    return { success: true, text, usage };
  } catch (error) {
    const code = error && typeof error.code === "string" && error.code !== "" ? error.code : "AI_UPSTREAM_ERROR";
    await logUsage({ openid, model: parsed.model, ok: false, errorCode: code, textLength: 0, durationMs: Date.now() - startedAt });
    return { success: false, code, error: messageForError(code) };
  }
};