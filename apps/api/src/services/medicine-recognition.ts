import type { MedicineRecognitionDraft, MedicineRecognitionResponse, PurposeTag } from "@home-medicine/contracts";
import { parseExpiry } from "../domain/expiry.js";

export interface MedicineRecognitionProvider {
  recognize(imageBase64: string, mimeType: "image/jpeg" | "image/png", purpose?: "box_front" | "leaflet"): Promise<MedicineRecognitionResponse>;
}

export type RecognitionFailureReason = "image_decode" | "model_missing" | "context_limit" | "model_memory" | "provider_unavailable" | "invalid_request" | "invalid_json" | "timeout" | "unknown";
export class RecognitionUnavailableError extends Error {
  constructor(message: string, readonly reason: RecognitionFailureReason = "unknown", readonly upstreamStatus?: number) { super(message); }
}
export const recognitionFailureMessages: Record<RecognitionFailureReason, string> = {
  image_decode: "识别服务无法读取这张照片，请重拍或选择清晰的 JPEG/PNG 照片。",
  model_missing: "识别模型尚未就绪，请联系服务维护者检查模型配置，或先手动录入。",
  context_limit: "照片或说明书内容超出识别范围，请分开拍摄、缩小单张内容后重试。",
  model_memory: "识别模型当前资源不足，请稍后重试，或先手动录入。",
  provider_unavailable: "识别服务暂时无法连接，请稍后重试，或先手动录入。",
  invalid_request: "识别服务未接受这次请求，请重拍后重试；仍失败请联系服务维护者。",
  invalid_json: "识别结果格式不完整，请重试，或先手动录入。",
  timeout: "识别等待超时，请稍后重试或分开拍摄；当前照片草稿仍保留。",
  unknown: "识别服务未能处理这张照片，请重拍后重试；仍失败请联系服务维护者诊断，或先手动录入。",
};
/** Bound provider JSON and diagnostic responses before allocating their full text. */
async function readRecognitionResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new RecognitionUnavailableError("vision provider body exceeded safe size", "invalid_json");
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof RecognitionUnavailableError) throw error;
    throw requestFailure(error);
  } finally {
    reader.releaseLock();
  }
}

async function upstreamFailure(response: Response): Promise<RecognitionUnavailableError> {
  let diagnostic = "";
  try {
    const payload = JSON.parse(await readRecognitionResponse(response, 8192)) as { error?: unknown };
    const detail = payload?.error;
    if (typeof detail === "string") diagnostic = detail;
    else if (typeof detail === "object" && detail !== null && "message" in detail && typeof detail.message === "string") diagnostic = detail.message;
  } catch { /* An unreadable error response is classified by status only. */ }
  let reason: RecognitionFailureReason = "unknown";
  if (/out of memory|not enough (?:system )?memory|unable to allocate|cuda.*memory/i.test(diagnostic)) reason = "model_memory";
  else if (/model.*(?:not found|does not exist)|pull.*model/i.test(diagnostic)) reason = "model_missing";
  else if (/(?:decode|invalid|unsupported|corrupt).*(?:image|jpeg|png)|(?:image|jpeg|png).*(?:decode|invalid|unsupported|corrupt)/i.test(diagnostic)) reason = "image_decode";
  else if (/context.*(?:limit|exceed|length)|too many tokens|token.*limit/i.test(diagnostic)) reason = "context_limit";
  else if (/invalid (?:request|parameter)|missing required|malformed request/i.test(diagnostic)) reason = "invalid_request";
  else if (response.status === 408 || response.status === 504) reason = "timeout";
  else if (response.status === 429 || response.status >= 500) reason = "provider_unavailable";
  return new RecognitionUnavailableError(`vision provider returned ${response.status}`, reason, response.status);
}
function requestFailure(error: unknown): RecognitionUnavailableError {
  // AbortError alone does not prove the configured wall-clock timeout elapsed.
  const timedOut = error instanceof Error && error.name === "TimeoutError";
  return new RecognitionUnavailableError("vision provider request failed", timedOut ? "timeout" : "provider_unavailable");
}

const OCR_PROMPT = "识别这张中国药品包装照片。只返回 JSON 对象，键为 name,brand,specification,manufacturer,approvalNumber,purposeCategory,purposeTags,populationTags,lotNumber,expiryValue。purposeTags 根据包装明确的用途或适应症选择以下库存分类：fever发热、cough咳嗽、throat咽喉、nasal鼻部、gastro胃肠、pain疼痛、topical外用、allergy过敏、itch止痒、eye眼部、oral口腔、constipation便秘、diarrhea腹泻、other其他；未看清用途时返回空数组，不推断成人儿童适用或推荐服用。若照片明确印有“药品名称”，name 必须取该字段的值；不要把测试、示例或警示标题当作药名。无法看清的字段填 null。brand为可见商标，manufacturer为可见厂家，两者不得混用。specification仅记录明确包装规格，如20粒装；12小时、24小时是持续时间，不能当粒数。populationTags仅根据明确的成人或儿童适用文字填写adult或child，不凭药名推断。purposeCategory 仅在包装明确写出用途或适应症时填简短分类；包装上的测试、示例、勿服用或警示文字不是用途，填 null。expiryValue 仅用 YYYY-MM-DD 或 YYYY-MM，保持原有精度；不要推断未见的日期、数量、服用剂量或个人用药建议。";

const LEAFLET_PROMPT = "逐字识别这张说明书照片，只返回JSON对象。键name,brand,manufacturer,purposeTags,populationTags,leaflet。leaflet的键text,purposeSummary,packageUsageSummary,contraindicationsSummary,precautionsSummary，分别保留原文、用途、用法用量、禁忌、注意事项。不可见内容填null，不补充医学建议，不推断包装数量或有效期。品牌与厂家分开。populationTags只按明确成人/儿童文字填写adult/child，否则[]。purposeTags只按可见用途选择fever发热,cough咳嗽,throat咽喉,nasal鼻部,gastro胃肠,pain疼痛,topical外用,allergy过敏,itch止痒,eye眼部,oral口腔,constipation便秘,diarrhea腹泻,other其他，否则[]。";

const FIELDS = ["brand", "name", "specification", "manufacturer", "approvalNumber", "purposeCategory", "lotNumber"] as const;

function cleanDraft(value: unknown, purpose: "box_front" | "leaflet"): MedicineRecognitionResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecognitionUnavailableError("recognition response is not an object");
  }
  const source = value as Record<string, unknown>;
  const draft = {} as MedicineRecognitionDraft;
  const warnings: string[] = [];
  for (const field of FIELDS) {
    const raw = source[field];
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      warnings.push(`${field} 识别结果格式异常，请手动填写`);
    }
    draft[field] = typeof raw === "string" && raw.trim() !== "" ? raw.trim().slice(0, 200) : null;
  }
  if (draft.specification && /(?:小时|hours?|\bh\b)/i.test(draft.specification) && !/\d\s*(?:粒|片|袋|支|瓶|盒|毫升|[mM][lL]|[mM][gG]|克)/.test(draft.specification)) {
    draft.specification = null;
    warnings.push("持续时间不是包装数量，请核对包装规格");
  }
  if (Array.isArray(source.populationTags)) {
    draft.populationTags = [...new Set(source.populationTags.filter((tag): tag is "adult" | "child" => tag === "adult" || tag === "child"))];
  }
  if (typeof source.leaflet === "object" && source.leaflet !== null && !Array.isArray(source.leaflet)) {
    const leaflet = source.leaflet as Record<string, unknown>;
    const text = (key: string): string | null => {
      const value = typeof leaflet[key] === "string" ? leaflet[key].trim() : "";
      const limit = key === "text" ? 20_000 : 4000;
      if (value.length > limit) warnings.push("说明书文字较长，识别草稿已截短，请查看原图补充");
      return value ? value.slice(0, limit) : null;
    };
    draft.leaflet = { text: text("text"), purposeSummary: text("purposeSummary"), packageUsageSummary: text("packageUsageSummary"), contraindicationsSummary: text("contraindicationsSummary"), precautionsSummary: text("precautionsSummary") };
    warnings.push("说明书识别仅作草稿，请对照原图核对文字和用法用量");
  }
  const rawExpiry = source.expiryValue;
  if (typeof rawExpiry === "string" && rawExpiry.trim() !== "") {
    const expiry = parseExpiry(rawExpiry.trim());
    draft.expiryValue = expiry.value;
    draft.expiryPrecision = expiry.precision;
    if (expiry.precision === "unknown") warnings.push("有效期无法确认，请核对原包装");
  } else {
    draft.expiryValue = null;
    draft.expiryPrecision = null;
  }
  if (Array.isArray(source.purposeTags)) {
    const allowed = new Set<unknown>(["fever", "cough", "throat", "nasal", "gastro", "pain", "topical", "allergy", "itch", "eye", "oral", "constipation", "diarrhea", "other"]);
    draft.purposeTags = [...new Set(source.purposeTags.filter((tag: unknown): tag is PurposeTag => allowed.has(tag)))];
    if (draft.purposeTags.length) warnings.push("AI 用途标签仅作整理草稿，请对照包装或说明书核对");
  }
  if (purpose !== "leaflet" && draft.name === null) warnings.push("未能识别药品名称，请手动填写");
  if (purpose !== "leaflet" && draft.expiryValue === null) warnings.push("未能识别有效期，可补拍包装另一面或手动填写");
  return { draft, warnings, requiresConfirmation: true };
}

/** Server-side DashScope OpenAI-compatible vision request. The image is never stored. */
export class DashscopeMedicineRecognitionProvider implements MedicineRecognitionProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model = "qwen-vl-plus",
    private readonly baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async recognize(imageBase64: string, mimeType: "image/jpeg" | "image/png", purpose: "box_front" | "leaflet" = "box_front"): Promise<MedicineRecognitionResponse> {
    if (this.apiKey === "") throw new RecognitionUnavailableError("vision provider is not configured", "provider_unavailable");
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: purpose === "leaflet" ? LEAFLET_PROMPT : OCR_PROMPT },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            ],
          }],
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch (error) {
      throw requestFailure(error);
    }
    if (!response.ok) throw await upstreamFailure(response);
    try {
      const payload = JSON.parse(await readRecognitionResponse(response, 512 * 1024)) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("missing content");
      return cleanDraft(JSON.parse(content) as unknown, purpose);
    } catch (error) {
      if (error instanceof RecognitionUnavailableError) throw error;
      throw new RecognitionUnavailableError("vision provider returned invalid JSON", "invalid_json");
    }
  }
}

/** Local Ollama vision request. The image is passed in memory and never persisted. */
export class OllamaMedicineRecognitionProvider implements MedicineRecognitionProvider {
  constructor(
    private readonly model = "qwen3.5:0.8b",
    private readonly baseUrl = "http://host.docker.internal:11434",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async recognize(imageBase64: string, mimeType: "image/jpeg" | "image/png", purpose: "box_front" | "leaflet" = "box_front"): Promise<MedicineRecognitionResponse> {
    if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
      throw new RecognitionUnavailableError("unsupported image type");
    }
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          format: "json",
          options: { temperature: 0, num_ctx: 2048, num_batch: 128 },
          messages: [{ role: "user", content: purpose === "leaflet" ? LEAFLET_PROMPT : OCR_PROMPT, images: [imageBase64] }],
        }),
        signal: AbortSignal.timeout(55_000),
      });
    } catch (error) {
      throw requestFailure(error);
    }
    if (!response.ok) throw await upstreamFailure(response);
    try {
      const payload = JSON.parse(await readRecognitionResponse(response, 512 * 1024)) as { message?: { content?: unknown } };
      if (typeof payload.message?.content !== "string") throw new Error("missing content");
      return cleanDraft(JSON.parse(payload.message.content) as unknown, purpose);
    } catch (error) {
      if (error instanceof RecognitionUnavailableError) throw error;
      throw new RecognitionUnavailableError("vision provider returned invalid JSON", "invalid_json");
    }
  }
}

export function createDefaultMedicineRecognitionProvider(): MedicineRecognitionProvider {
  if (process.env.MEDICINE_RECOGNITION_PROVIDER === "ollama") {
    return new OllamaMedicineRecognitionProvider(
      process.env.OLLAMA_MODEL ?? "qwen3.5:0.8b",
      process.env.OLLAMA_BASE_URL ?? "http://host.docker.internal:11434",
    );
  }
  return new DashscopeMedicineRecognitionProvider(
    process.env.DASHSCOPE_API_KEY ?? "",
    process.env.DASHSCOPE_MODEL ?? "qwen-vl-plus",
    process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
}
