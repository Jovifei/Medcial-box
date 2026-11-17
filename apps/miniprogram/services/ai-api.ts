/**
 * 小程序侧 AI 封装：页面只通过 aiApi 调云函数 aiRelay，不直接接触模型与额度。
 * - 云开发不可用或未初始化时抛出明确错误，不阻塞非 AI 功能；
 * - 入参在客户端先做一次与云函数一致的基本校验，避免明显非法请求。
 */
export const AI_CLOUD_ENV = "yaoxiagn-d2goac4i31a1c8485";
export const AI_DEFAULT_MODEL = "deepseek-v4.1-flash";
export const AI_ALLOWED_MODELS = ["deepseek-v4.1-flash", "deepseek-v4.1-flash-1017", "hy3", "hy4", "hy4-preview"] as const;
export type AiModel = (typeof AI_ALLOWED_MODELS)[number];
export type AiRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface AiTextResult {
  text: string;
  usage?: unknown;
}

const MAX_MESSAGES = 20;
const MAX_CHARS = 4000;

export class AiApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AiApiError";
    this.code = code;
  }
}

let cloudInitialized = false;

/** 在 App.onLaunch 调用；环境不支持云开发时静默跳过，AI 入口按需报错。 */
export function initAiCloud(): void {
  if (cloudInitialized) return;
  const cloud = typeof wx !== "undefined" ? (wx as unknown as { cloud?: { init?: (options: { env: string; traceUser?: boolean }) => void } }).cloud : undefined;
  if (!cloud || typeof cloud.init !== "function") return;
  try {
    cloud.init({ env: AI_CLOUD_ENV, traceUser: true });
    cloudInitialized = true;
  } catch {
    // 云开发初始化失败只影响 AI 功能；下次调用会再次尝试。
  }
}

function normalizeMessages(messages: AiMessage[]): AiMessage[] {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    throw new AiApiError("INVALID_MESSAGES", "消息数量不合法");
  }
  return messages.map((message) => {
    if (message === null || typeof message !== "object" || typeof message.role !== "string" ||
        !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new AiApiError("INVALID_MESSAGES", "消息格式不合法");
    }
    const content = message.content.trim();
    if (content === "" || content.length > MAX_CHARS) {
      throw new AiApiError("INVALID_MESSAGES", "消息内容长度不合法");
    }
    return { role: message.role as AiRole, content };
  });
}

export async function generateAiText(messages: AiMessage[], options: { model?: AiModel } = {}): Promise<AiTextResult> {
  const cloud = typeof wx !== "undefined" ? (wx as unknown as {
    cloud?: { callFunction?: (options: { name: string; data: unknown }) => Promise<{ result?: unknown }> };
  }).cloud : undefined;
  if (!cloud || typeof cloud.callFunction !== "function") {
    throw new AiApiError("CLOUD_UNAVAILABLE", "当前环境不支持 AI 功能");
  }
  const normalized = normalizeMessages(messages);
  const model = options.model ?? AI_DEFAULT_MODEL;
  if (!(AI_ALLOWED_MODELS as readonly string[]).includes(model)) {
    throw new AiApiError("MODEL_NOT_ALLOWED", "该 AI 模型不可用");
  }

  let response: { result?: unknown };
  try {
    response = await cloud.callFunction({ name: "aiRelay", data: { model, messages: normalized } });
  } catch {
    throw new AiApiError("AI_REQUEST_FAILED", "AI 服务暂时不可用，请稍后重试");
  }

  const result = response?.result as { success?: boolean; text?: unknown; usage?: unknown; code?: unknown; error?: unknown } | undefined;
  if (!result || result.success !== true || typeof result.text !== "string" || result.text.trim() === "") {
    throw new AiApiError(
      typeof result?.code === "string" && result.code !== "" ? result.code : "AI_REQUEST_FAILED",
      typeof result?.error === "string" && result.error !== "" ? result.error : "AI 服务暂时不可用，请稍后重试",
    );
  }
  return { text: result.text.trim(), usage: result.usage };
}

export const aiApi = {
  init: initAiCloud,
  generateText: generateAiText,
};