import type {
  LeafletInput,
  MedicineCandidate,
  MedicineCandidatesResponse,
} from "@home-medicine/contracts";

export interface MedicineCatalogQuery {
  name?: string;
  manufacturer?: string;
  approvalNumber?: string;
  barcode?: string;
  specification?: string;
  consentToShare: boolean;
}

export interface MedicineCatalogProvider {
  search(query: MedicineCatalogQuery): Promise<MedicineCandidatesResponse>;
}

export class MedicineCatalogUnavailableError extends Error {}

interface JisuSearchItem {
  medicine_id?: string | number;
  name?: string;
  manufacturer?: string;
}

interface JisuMedicineDetail {
  medicine_id?: string | number;
  name?: string;
  spec?: string;
  manufacturer?: string;
  approval_num?: string;
  barcode?: string;
  disease?: string;
  desc?: string;
  prescription?: number;
}

interface JisuEnvelope<T> {
  status?: number;
  msg?: string;
  result?: T;
}

function cleanText(value: unknown, maxLength = 300): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? null : text.slice(0, maxLength);
}

function extractSection(description: string | null, names: readonly string[]): string | null {
  if (description === null) return null;
  const heading = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = new RegExp(`(?:〖|【|\\[)?(?:${heading})(?:〗|】|\\])?\\s*[:：]?\\s*([\\s\\S]*?)(?=〖|【|\\[|$)`, "i").exec(description);
  return cleanText(match?.[1], 1000);
}

function candidateFromDetail(
  item: JisuSearchItem,
  detail: JisuMedicineDetail,
  query: MedicineCatalogQuery,
): MedicineCandidate | null {
  const name = cleanText(detail.name ?? item.name, 160);
  if (name === null) return null;
  const specification = cleanText(detail.spec, 160);
  const manufacturer = cleanText(detail.manufacturer ?? item.manufacturer, 160);
  const approvalNumber = cleanText(detail.approval_num, 100);
  const barcodeValue = cleanText(detail.barcode, 160);
  const description = cleanText(detail.desc, 6000);
  const ingredients = extractSection(description, ["主要成份", "主要成分"]);
  const usage = extractSection(description, ["用法用量"]);
  const contraindications = extractSection(description, ["禁忌"]);
  const precautions = extractSection(description, ["注意事项", "注意事项及副作用"]);
  const purpose = extractSection(description, ["功能主治/适应症", "功能主治", "适应症"]) ?? cleanText(detail.disease, 500);
  const leaflet: LeafletInput | null = description === null && purpose === null && ingredients === null && usage === null
    ? null
    : {
        purposeSummary: purpose,
        packageUsageSummary: usage,
        contraindicationsSummary: contraindications,
        precautionsSummary: precautions,
        source: "极速数据药品信息（候选资料，待对照实物核验）",
        reviewStatus: "unverified",
      };

  const matchReasons: string[] = [];
  if (query.approvalNumber && approvalNumber === query.approvalNumber.trim()) matchReasons.push("批准文号一致");
  if (query.manufacturer && manufacturer === query.manufacturer.trim()) matchReasons.push("厂家一致");
  if (query.specification && specification === query.specification.trim()) matchReasons.push("规格一致");
  if (query.barcode && cleanText(detail.barcode) === query.barcode.trim()) matchReasons.push("条码一致");
  if (matchReasons.length === 0 && query.name && name.includes(query.name.trim())) matchReasons.push("名称相似，请核对厂家和规格");

  return {
    name,
    specification,
    manufacturer,
    approvalNumber,
    barcodeValue,
    activeIngredients: ingredients === null ? [] : [ingredients],
    leaflet,
    source: "极速数据药品信息",
    sourceUpdatedAt: null,
    matchReasons,
  };
}

export class JisuMedicineCatalogProvider implements MedicineCatalogProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async search(query: MedicineCatalogQuery): Promise<MedicineCandidatesResponse> {
    if (!query.consentToShare) {
      throw new Error("请先确认允许发送药品标识到资料查询服务");
    }
    if (this.apiKey.trim() === "") {
      throw new MedicineCatalogUnavailableError("JISU_MEDICINE_API_KEY is not configured");
    }
    const identifiers = [query.name, query.manufacturer, query.approvalNumber, query.barcode]
      .map((value) => value?.trim() ?? "")
      .filter(Boolean);
    if (identifiers.length === 0) throw new Error("请先提供药品名称、厂家、批准文号或条码");

    try {
      const searchItems = await this.findItems(query);
      const selectedItems = searchItems.slice(0, 5);
      const details = await Promise.all(selectedItems.map((item) => this.fetchDetail(item)));
      const candidates = details
        .map((detail, index) => candidateFromDetail(selectedItems[index], detail, query))
        .filter((candidate): candidate is MedicineCandidate => candidate !== null)
        .sort((left, right) => right.matchReasons.length - left.matchReasons.length);
      return {
        candidates,
        warnings: [
          "联网结果仅作候选，请按批准文号、厂家和规格核对包装；保存前仍需人工确认。",
          "说明书内容可能缺失或不完整；没有返回的字段请对照实物说明书补充。",
        ],
      };
    } catch (error) {
      if (error instanceof MedicineCatalogUnavailableError) throw error;
      throw new MedicineCatalogUnavailableError("medicine catalog request failed");
    }
  }

  private async findItems(query: MedicineCatalogQuery): Promise<JisuSearchItem[]> {
    if (query.approvalNumber || query.barcode) {
      const detail = await this.fetchJson<JisuMedicineDetail>("detail", {
        ...(query.approvalNumber ? { approval_num: query.approvalNumber.trim() } : {}),
        ...(query.barcode ? { barcode: query.barcode.trim() } : {}),
      });
      return [{ medicine_id: detail.medicine_id, name: detail.name, manufacturer: detail.manufacturer }];
    }
    return this.fetchJson<{ list?: JisuSearchItem[] }>("query", {
      ...(query.name ? { name: query.name.trim() } : {}),
      ...(query.manufacturer ? { manufacturer: query.manufacturer.trim() } : {}),
    }).then((result) => Array.isArray(result.list) ? result.list : []);
  }

  private async fetchDetail(item: JisuSearchItem): Promise<JisuMedicineDetail> {
    if (item.medicine_id === undefined) throw new MedicineCatalogUnavailableError("catalog item missing id");
    return this.fetchJson<JisuMedicineDetail>("detail", { medicine_id: String(item.medicine_id) });
  }

  private async fetchJson<T>(endpoint: "query" | "detail", params: Record<string, string>): Promise<T> {
    const url = new URL(`https://api.jisuapi.com/medicine/${endpoint}`);
    url.searchParams.set("appkey", this.apiKey);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new MedicineCatalogUnavailableError(`catalog status ${response.status}`);
    const body = await response.json() as JisuEnvelope<T>;
    if (body.status !== 0 || body.result === undefined) {
      throw new MedicineCatalogUnavailableError(`catalog response ${body.status ?? "invalid"}`);
    }
    return body.result;
  }
}

export function createDefaultMedicineCatalogProvider(): MedicineCatalogProvider {
  return new JisuMedicineCatalogProvider(process.env.JISU_MEDICINE_API_KEY ?? "");
}
