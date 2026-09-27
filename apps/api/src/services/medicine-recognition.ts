import type { MedicineRecognitionDraft, MedicineRecognitionResponse } from "@home-medicine/contracts";
import { parseExpiry } from "../domain/expiry.js";

export interface MedicineRecognitionProvider {
  recognize(imageBase64: string, mimeType: "image/jpeg" | "image/png"): Promise<MedicineRecognitionResponse>;
}

export class RecognitionUnavailableError extends Error {}

const OCR_PROMPT = "识别这张中国药品包装照片。只返回 JSON 对象，键为 name,specification,manufacturer,approvalNumber,purposeCategory,lotNumber,expiryValue。若照片明确印有“药品名称”，name 必须取该字段的值；不要把测试、示例或警示标题当作药名。无法看清的字段填 null。purposeCategory 仅在包装明确写出用途或适应症时填简短分类；包装上的测试、示例、勿服用或警示文字不是用途，填 null。expiryValue 仅用 YYYY-MM-DD 或 YYYY-MM，保持原有精度；不要推断未见的日期、数量、服用剂量或个人用药建议。";

const FIELDS = ["name", "specification", "manufacturer", "approvalNumber", "purposeCategory", "lotNumber"] as const;

function cleanDraft(value: unknown): MedicineRecognitionResponse {
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
  if (draft.name === null) warnings.push("未能识别药品名称，请手动填写");
  if (draft.expiryValue === null) warnings.push("未能识别有效期，可补拍包装另一面或手动填写");
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

  async recognize(imageBase64: string, mimeType: "image/jpeg" | "image/png"): Promise<MedicineRecognitionResponse> {
    if (this.apiKey === "") throw new RecognitionUnavailableError("DASHSCOPE_API_KEY is not configured");
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
              { type: "text", text: OCR_PROMPT },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            ],
          }],
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new RecognitionUnavailableError("vision provider request failed");
    }
    if (!response.ok) throw new RecognitionUnavailableError(`vision provider returned ${response.status}`);
    try {
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("missing content");
      return cleanDraft(JSON.parse(content) as unknown);
    } catch {
      throw new RecognitionUnavailableError("vision provider returned invalid JSON");
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

  async recognize(imageBase64: string, mimeType: "image/jpeg" | "image/png"): Promise<MedicineRecognitionResponse> {
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
          format: "json",
          options: { temperature: 0, num_ctx: 2048, num_batch: 128 },
          messages: [{ role: "user", content: OCR_PROMPT, images: [imageBase64] }],
        }),
        signal: AbortSignal.timeout(55_000),
      });
    } catch {
      throw new RecognitionUnavailableError("local vision provider request failed");
    }
    if (!response.ok) throw new RecognitionUnavailableError(`local vision provider returned ${response.status}`);
    try {
      const payload = await response.json() as { message?: { content?: unknown } };
      if (typeof payload.message?.content !== "string") throw new Error("missing content");
      return cleanDraft(JSON.parse(payload.message.content) as unknown);
    } catch {
      throw new RecognitionUnavailableError("local vision provider returned invalid JSON");
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
