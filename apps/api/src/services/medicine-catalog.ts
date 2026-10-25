import { LocalMedicineCatalogProvider } from "./local-medicine-catalog.js";
import type {
  LeafletInput,
  MedicineCandidate,
  MedicineCandidatesResponse,
  PurposeTag,
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
  readonly kind?: "local" | "external";
  search(query: MedicineCatalogQuery): Promise<MedicineCandidatesResponse>;
}

export class MedicineCatalogUnavailableError extends Error {
  constructor(message: string, readonly reason: "not_configured" | "unavailable" = "unavailable") {
    super(message);
  }
}

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

const LEAFLET_HEADINGS = [
  "功能主治/适应症", "功能主治", "适应症", "主要成份", "主要成分", "成份", "成分",
  "用法用量", "禁忌", "注意事项及副作用", "注意事项", "不良反应", "副作用",
  "药物相互作用", "孕妇及哺乳期妇女用药", "儿童用药", "老年用药", "药理毒理",
  "药理作用", "药代动力学", "药品名称", "性状", "规格", "贮藏", "储藏", "包装",
  "有效期", "执行标准", "批准文号", "生产企业",
];

function headingPattern(names: readonly string[]): string {
  return [...names].sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

function extractSection(description: string | null, names: readonly string[]): string | null {
  if (description === null) return null;
  const heading = headingPattern(names);
  // 无括号标题必须有冒号；标题按最长优先匹配，避免把“及副作用”误当正文。
  const start = `(?:[〖【\\[](?:${heading})[〗】\\]]\\s*[:：]?|(?:^|[\\s。；;])(?:${heading})\\s*[:：])`;
  const end = `(?=[〖【\\[]|(?:${headingPattern(LEAFLET_HEADINGS)})\\s*[:：]|$)`;
  const match = new RegExp(`${start}\\s*([\\s\\S]*?)${end}`, "i").exec(description);
  return cleanText(match?.[1], 1000);
}

/**
 * 功能主治文本 → 用途标签的保守映射（值域与 B02 枚举同源）：
 * 只收录明确指向单一用途的词，不含"感冒"这类多用途泛词；
 * 命中按枚举顺序去重，最多 3 个。结果仅作为候选草稿供用户核对，不自动保存。
 */
const PURPOSE_KEYWORDS: ReadonlyArray<readonly [PurposeTag, RegExp]> = [
  ["fever", /发热|发烧|退热|解热/],
  ["pain", /疼痛|头痛|偏头痛|止痛|镇痛|牙痛|痛经/],
  ["cough", /咳嗽|止咳|祛痰/],
  ["throat", /咽喉|利咽|咽炎/],
  ["nasal", /鼻塞|流涕|打喷嚏|鼻炎/],
  ["gastro", /胃酸|烧心|反酸|消化不良|胃肠(?!道手术)/],
  ["diarrhea", /腹泻|止泻/],
  ["constipation", /便秘|通便/],
  ["allergy", /过敏|荨麻疹/],
  // 消炎/抗感染类：刻意不含"抗炎"——布洛芬等解热镇痛药的"抗炎"不是抗生素。
  ["antiinfective", /消炎|抗感染|抗菌|抗生素|细菌感染|敏感菌/],
  ["itch", /瘙痒|止痒/],
  ["eye", /结膜炎|眼疲劳|干眼/],
  ["oral", /口腔溃疡|口疮|牙龈(炎|肿痛)/],
];

function derivePurposeTags(purposeText: string | null): PurposeTag[] {
  if (purposeText === null) return [];
  // 对否定、禁慎用或无效描述不推断用途。混合肯否定的同一句也保守放弃；
  // 不拆逗号，以免“不得用于发热，咳嗽等”后半句重新进入候选。
  const affirmativeText = purposeText.split(/[。；;！？!?]/)
    .filter((sentence) => !/不(?:适用|适于|宜|可|能|应|得|用|推荐|建议|具|属于|是|治疗|缓解)|[勿禁慎忌]|避免|无效|无.{0,20}(?:疗效|作用)|未.{0,8}(?:证明|证实|推荐)|非(?:适应症|用于)|不良反应|副作用/.test(sentence))
    .join("。");
  const tags: PurposeTag[] = [];
  for (const [tag, pattern] of PURPOSE_KEYWORDS) {
    if (tags.length >= 3) break;
    if (pattern.test(affirmativeText)) tags.push(tag);
  }
  return tags;
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
    purposeTags: derivePurposeTags(purpose),
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
      throw new MedicineCatalogUnavailableError("medicine catalog is not configured", "not_configured");
    }
    const identifiers = [query.name, query.manufacturer, query.approvalNumber, query.barcode]
      .map((value) => value?.trim() ?? "")
      .filter(Boolean);
    if (identifiers.length === 0) throw new Error("请先提供药品名称、厂家、批准文号或条码");

    try {
      let selectedItems: JisuSearchItem[] = [];
      let details: Array<JisuMedicineDetail | null> = [];
      if (query.approvalNumber || query.barcode) {
        const detail = await this.fetchJson<JisuMedicineDetail>("detail", {
          ...(query.approvalNumber ? { approval_num: query.approvalNumber.trim() } : {}),
          ...(query.barcode ? { barcode: query.barcode.trim() } : {}),
        });
        if (detail) {
          selectedItems = [detail];
          details = [detail];
        }
      } else {
        selectedItems = (await this.findItems(query)).slice(0, 5);
        details = await Promise.all(selectedItems.map((item) => this.fetchDetail(item)));
      }
      const candidates = details
        .map((detail, index) => detail ? candidateFromDetail(selectedItems[index], detail, query) : null)
        .filter((candidate): candidate is MedicineCandidate => candidate !== null)
        .sort((left, right) => right.matchReasons.length - left.matchReasons.length);
      return {
        candidates,
        warnings: candidates.length > 0 ? [
          "联网结果仅作候选，请按批准文号、厂家和规格核对包装；保存前仍需人工确认。",
          "说明书内容可能缺失或不完整；没有返回的字段请对照实物说明书补充。",
        ] : [
          "全网资料库未收录该条码资料，可拍药盒识别或手动录入。",
        ],
      };
    } catch (error) {
      if (error instanceof MedicineCatalogUnavailableError) throw error;
      throw new MedicineCatalogUnavailableError("medicine catalog request failed");
    }
  }

  private async findItems(query: MedicineCatalogQuery): Promise<JisuSearchItem[]> {
    const result = await this.fetchJson<{ list?: JisuSearchItem[] }>("query", {
      ...(query.name ? { name: query.name.trim() } : {}),
      ...(query.manufacturer ? { manufacturer: query.manufacturer.trim() } : {}),
    });
    return Array.isArray(result?.list) ? result.list : [];
  }

  private async fetchDetail(item: JisuSearchItem): Promise<JisuMedicineDetail | null> {
    if (item.medicine_id === undefined) return null;
    return this.fetchJson<JisuMedicineDetail>("detail", { medicine_id: String(item.medicine_id) });
  }

  private async fetchJson<T>(endpoint: "query" | "detail", params: Record<string, string>): Promise<T | null> {
    const url = new URL(`https://api.jisuapi.com/medicine/${endpoint}`);
    url.searchParams.set("appkey", this.apiKey);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new MedicineCatalogUnavailableError(`catalog status ${response.status}`);
    const body = await response.json() as JisuEnvelope<T>;
    if (
      body.status === 201 ||
      body.status === 202 ||
      body.status === 203 ||
      body.status === 204 ||
      body.status === 205 ||
      (typeof body.msg === "string" && body.msg.includes("没有信息"))
    ) {
      return null;
    }
    if (body.status !== 0 || body.result === undefined) {
      throw new MedicineCatalogUnavailableError(`catalog response ${body.status ?? "invalid"}`);
    }
    return body.result;
  }
}

export class CompositeMedicineCatalogProvider implements MedicineCatalogProvider {
  readonly kind = "local" as const;
  constructor(
    private readonly localProvider?: MedicineCatalogProvider & { readonly kind: "local" },
    private readonly externalProvider?: MedicineCatalogProvider,
  ) {}

  async search(query: MedicineCatalogQuery): Promise<MedicineCandidatesResponse> {
    let failure: MedicineCatalogUnavailableError | undefined;
    let searched = false;
    const warnings: string[] = [];
    if (this.localProvider) {
      try {
        const localResult = await this.localProvider.search(query);
        searched = true;
        if (localResult.candidates.length > 0) {
          return localResult;
        }
        warnings.push(...localResult.warnings);
      } catch (error) {
        failure = error instanceof MedicineCatalogUnavailableError
          ? error : new MedicineCatalogUnavailableError("local catalog request failed");
      }
    }

    // The composite allows local queries without consent; its external branch
    // must enforce consent itself, including for providers without a kind.
    if (this.externalProvider && query.consentToShare) {
      try {
        const extResult = await this.externalProvider.search(query);
        searched = true;
        if (extResult.candidates.length > 0) {
          return extResult;
        }
        warnings.push(...extResult.warnings);
      } catch (error) {
        const externalFailure = error instanceof MedicineCatalogUnavailableError
          ? error : new MedicineCatalogUnavailableError("external catalog request failed");
        if (!failure || externalFailure.reason === "unavailable") failure = externalFailure;
      }
    }

    if (failure) throw failure;
    if (!searched) {
      throw new MedicineCatalogUnavailableError("medicine catalog is not configured for this query", "not_configured");
    }
    return {
      candidates: [],
      warnings: [
        ...warnings,
        "未检索到匹配的药品资料，请核对包装手动填写，或使用拍照识别后核验。",
        ...(!query.consentToShare && this.externalProvider ? ["未进行外部资料查询；联网查询需要先确认允许发送药品标识。"] : []),
      ],
    };
  }
}

export function createDefaultMedicineCatalogProvider(): MedicineCatalogProvider {
  if (process.env.MEDICINE_CATALOG_PROVIDER === "local") return new LocalMedicineCatalogProvider(process.env.MEDICINE_CATALOG_LOCAL_FILE ?? "");
  const localFile = process.env.MEDICINE_CATALOG_LOCAL_FILE?.trim();
  const local = localFile ? new LocalMedicineCatalogProvider(localFile) : undefined;
  const jisuKey = process.env.JISU_MEDICINE_API_KEY ?? "";
  const external = jisuKey.trim() ? new JisuMedicineCatalogProvider(jisuKey) : undefined;
  return new CompositeMedicineCatalogProvider(local, external);
}
