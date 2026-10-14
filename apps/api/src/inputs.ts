// 请求体校验：所有错误最终映射为 400 { error: { code: "VALIDATION_ERROR" } }。
// 校验规则与设计文档对齐：
// - 数量 quantity：null/缺省 = 未知，整数 ≥ 0；
// - 有效期：value 与 precision 必须成对且可解析，年月/日期按历法校验；
// - 盒→片换算数 confirmedUnitsPerPackage：仅可为正整数（用户确认后填写）；
// - 更新类请求必须携带整数 version（≥ 1）。
import type {
  AfterOpeningLimitInput,
  ExpiryPrecision,
  PopulationTag,
  PurposeTag,
  OpenedState,
  QuantityUnit,
  RestockStatus,
  StocktakeInterval,
  StocktakeItemInput,
  TagSource,
} from "@home-medicine/contracts";
import { parseExpiry } from "./domain/expiry.js";

export type LeafletReviewStatus = "unverified" | "matched" | "user_confirmed";
export type NoteVisibility = "private" | "family";

const QUANTITY_UNITS: readonly QuantityUnit[] = [
  "tablet",
  "capsule",
  "sachet",
  "bottle",
  "tube",
  "box",
  "blister",
  "ml",
  "other",
];

/** 只有毫升允许小数（最多 3 位）；其余单位都是计件单位。 */
const MEASURED_UNITS = new Set<QuantityUnit>(["ml"]);

/** 路由层用：判断单位是否允许小数（毫升）。计件单位必须整数。 */
export function isMeasuredUnit(unit: string): boolean {
  return MEASURED_UNITS.has(unit as QuantityUnit);
}

const EXPIRY_PRECISIONS: readonly ExpiryPrecision[] = ["day", "month", "unknown"];

const LEAFLET_REVIEW_STATUSES: readonly LeafletReviewStatus[] = [
  "unverified",
  "matched",
  "user_confirmed",
];

const NOTE_VISIBILITIES: readonly NoteVisibility[] = ["private", "family"];
const OPENED_STATES: readonly OpenedState[] = ["unknown", "unopened", "opened"];
const OPENED_LIMIT_UNITS = ["day", "month"] as const;
const STOCKTAKE_INTERVALS: readonly StocktakeInterval[] = ["weekly", "monthly", "disabled"];
const STOCKTAKE_OUTCOMES = ["unchanged", "adjusted", "empty", "handled", "deferred"] as const;
const RESTOCK_STATUSES: readonly RestockStatus[] = ["needed", "purchased", "dismissed"];

const POPULATION_TAGS = ["adult", "child"] as const;
const PURPOSE_TAGS = ["fever", "cough", "throat", "nasal", "gastro", "pain", "topical", "allergy", "itch", "eye", "oral", "constipation", "diarrhea", "other"] as const;

/** 标签数组：去重、去空、白名单校验；空数组表示"未标注"。 */
function tagList<T extends string>(value: unknown, field: string, allowed: readonly T[]): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InputError(`${field} 必须是数组`);
  const seen = new Set<T>();
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      throw new InputError(`${field} 含不支持的标签`);
    }
    seen.add(item as T);
  }
  return [...seen];
}

/** 标签来源：缺省 manual（新录入）；备份恢复时保留导出的原值。 */
function parseTagSource(value: unknown): TagSource {
  if (value === undefined || value === null) return "manual";
  if (typeof value !== "string" || !["manual", "catalog", "imported"].includes(value)) {
    throw new InputError("tagSource 不合法");
  }
  return value as TagSource;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

class InputError extends Error {}
const MAX_POSTGRES_INTEGER = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, fallback: string | null = null): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new InputError(`${field} 必须是文本`);
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

/**
 * 数量校验：毫升最多 3 位小数，计件单位必须是非负整数。
 * 返回值为定点安全 number（最多 3 位小数），null 表示"数量未知"。
 */
function quantityOrNull(value: unknown, field: string, unit: QuantityUnit): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InputError(`${field} 必须是数字`);
  }
  if (value < 0) throw new InputError(`${field} 不能为负数`);
  if (MEASURED_UNITS.has(unit)) {
    const scaled = Math.round(value * 1000);
    if (Math.abs(scaled - value * 1000) > 1e-6) {
      throw new InputError(`${field} 最多支持 3 位小数`);
    }
    return scaled / 1000;
  }
  if (!Number.isInteger(value)) {
    throw new InputError(`${field} 在计件单位下必须是整数`);
  }
  if (value > MAX_POSTGRES_INTEGER) {
    throw new InputError(`${field} 超出可保存范围`);
  }
  return value;
}

function positiveQuantityOrNull(value: unknown, field: string, unit: QuantityUnit): number | null {
  const parsed = quantityOrNull(value, field, unit);
  if (parsed !== null && parsed <= 0) throw new InputError(`${field} 必须大于 0`);
  return parsed;
}

/**
 * 定点数量（非负、最多 3 位小数），单位无关。
 * 用于此刻还不知道单位的入口（盘点项、拆分、补货修改）：
 * 先做定点校验，整数性由路由层按批次/条目的真实单位复核。
 */
function fixedPointQuantity(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InputError(`${field} 必须是非负数字`);
  }
  const scaled = Math.round(value * 1000);
  if (Math.abs(scaled - value * 1000) > 1e-6) throw new InputError(`${field} 最多支持 3 位小数`);
  return scaled / 1000;
}

/** 盘点项数量：单位由批次决定，这里先做定点校验，路由层按批次单位复核整数性。 */
function stocktakeQuantityOrNull(value: unknown): number | null {
  return fixedPointQuantity(value, "quantity");
}

function requireInt(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > MAX_POSTGRES_INTEGER) {
    throw new InputError(`${field} 必须是 ${min} 到 ${MAX_POSTGRES_INTEGER} 的整数`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new InputError(`${field} 不合法`);
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// 批次
// ---------------------------------------------------------------------------

export interface ValidatedBatchFields {
  /** 已有批次的标识（药品编辑同步用）；null/缺省 = 新增批次。 */
  id: string | null;
  /** 已有批次的预期版本（乐观锁门）；新增批次为 null。 */
  version: number | null;
  lotNumber: string | null;
  expiryValue: string | null;
  expiryPrecision: ExpiryPrecision;
  quantity: number | null;
  unit: QuantityUnit;
  confirmedUnitsPerPackage: number | null;
  conversionUnit?: QuantityUnit | null;
  conversionUnitProvided?: boolean;
  storageLocation: string | null;
  openedState: OpenedState;
  openedAt: string | null;
  afterOpeningLimit: AfterOpeningLimitInput | null;
  openingFieldsProvided: boolean;
}

function calendarDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InputError(`${field} 必须是 YYYY-MM-DD 日期`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new InputError(`${field} 不是有效日期`);
  }
  return value;
}

function parseAfterOpeningLimit(value: unknown): AfterOpeningLimitInput | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new InputError("afterOpeningLimit 必须是对象");
  const source = text(value.source, "afterOpeningLimit.source");
  if (value.date !== undefined) {
    const date = calendarDate(value.date, "afterOpeningLimit.date");
    if (date === null) throw new InputError("afterOpeningLimit.date 不能为空");
    if (value.value !== undefined || value.unit !== undefined) {
      throw new InputError("afterOpeningLimit 只能填写期限或截止日期之一");
    }
    return { date, source };
  }
  const limitValue = requireInt(value.value, "afterOpeningLimit.value", 1);
  if (typeof value.unit !== "string" || !OPENED_LIMIT_UNITS.includes(value.unit as (typeof OPENED_LIMIT_UNITS)[number])) {
    throw new InputError("afterOpeningLimit.unit 不合法");
  }
  const unit = value.unit as (typeof OPENED_LIMIT_UNITS)[number];
  return { value: limitValue, unit, source };
}

function parseBatch(raw: Record<string, unknown>): ValidatedBatchFields {
  const lotNumber = text(raw.lotNumber, "lotNumber");
  const unit = oneOf(raw.unit, "unit", QUANTITY_UNITS, "other");
  const conversionUnit = raw.conversionUnit == null || raw.conversionUnit === ""
    ? null : oneOf(raw.conversionUnit, "conversionUnit", QUANTITY_UNITS, "other");
  const targets: Partial<Record<QuantityUnit, readonly QuantityUnit[]>> = {
    box: ["tablet", "capsule", "sachet", "blister", "bottle", "tube"],
    blister: ["tablet", "capsule"], bottle: ["ml"],
  };
  if (conversionUnit !== null && !targets[unit]?.includes(conversionUnit)) {
    throw new InputError("conversionUnit 不是该包装允许的换算目标");
  }

  let expiryValue: string | null = null;
  let expiryPrecision: ExpiryPrecision = "unknown";
  if (raw.expiry !== undefined && raw.expiry !== null) {
    if (!isRecord(raw.expiry)) throw new InputError("expiry 必须是对象");
    expiryValue = text(raw.expiry.value, "expiry.value");
    const claimed = oneOf(raw.expiry.precision, "expiry.precision", EXPIRY_PRECISIONS, "unknown");
    if (expiryValue === null) {
      expiryPrecision = "unknown";
    } else {
      const parsed = parseExpiry(expiryValue);
      // value 与 precision 必须成对：声称的精度必须与可解析出的精度一致。
      if (parsed.precision !== claimed) {
        throw new InputError("expiry.value 与 expiry.precision 不匹配");
      }
      expiryPrecision = parsed.precision;
    }
  }

  const openedState = oneOf(raw.openedState, "openedState", OPENED_STATES, "unknown");
  const openedAt = calendarDate(raw.openedAt, "openedAt");
  const afterOpeningLimit = parseAfterOpeningLimit(raw.afterOpeningLimit);
  if (openedAt !== null && openedState !== "opened") {
    throw new InputError("openedAt 只能用于已开封批次");
  }
  if (afterOpeningLimit !== null && openedState !== "opened") {
    throw new InputError("开封后有效期只能用于已开封批次");
  }

  return {
    id: raw.id === undefined || raw.id === null ? null : text(raw.id, "id"),
    version: raw.version === undefined || raw.version === null ? null : requireInt(raw.version, "version", 1),
    lotNumber,
    expiryValue,
    expiryPrecision,
    quantity: quantityOrNull(raw.quantity, "quantity", unit),
    unit,
    confirmedUnitsPerPackage: positiveQuantityOrNull(raw.confirmedUnitsPerPackage, "confirmedUnitsPerPackage", conversionUnit ?? unit),
    conversionUnit,
    conversionUnitProvided: raw.conversionUnit !== undefined,
    storageLocation: text(raw.storageLocation, "storageLocation"),
    openedState,
    openedAt,
    afterOpeningLimit,
    openingFieldsProvided:
      raw.openedState !== undefined ||
      raw.openedAt !== undefined ||
      raw.afterOpeningLimit !== undefined,
  };
}

export function validateBatchInput(raw: unknown): ValidationResult<ValidatedBatchFields> {
  try {
    if (!isRecord(raw)) return { ok: false, message: "请求体必须是对象" };
    return { ok: true, value: parseBatch(raw) };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

export function validateBatchUpdateInput(
  raw: unknown,
  existing?: { unit: string; conversion_unit?: string | null },
): ValidationResult<ValidatedBatchFields & { version: number }> {
  try {
    if (!isRecord(raw)) return { ok: false, message: "请求体必须是对象" };
    const version = requireInt(raw.version, "version", 1);
    const merged = existing !== undefined && raw.conversionUnit === undefined && raw.unit === existing.unit && existing.conversion_unit != null
      ? { ...raw, conversionUnit: existing.conversion_unit } : raw;
    return { ok: true, value: { ...parseBatch(merged), version } };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

export interface ValidatedBatchSplitFields {
  version: number;
  openedQuantity: number;
  openedAt: string;
  afterOpeningLimit: AfterOpeningLimitInput | null;
  confirmed: true;
}

export function validateBatchSplitInput(raw: unknown): ValidationResult<ValidatedBatchSplitFields> {
  try {
    if (!isRecord(raw)) throw new InputError("请求体必须是对象");
    const allowedFields = new Set(["version", "openedQuantity", "openedAt", "afterOpeningLimit", "confirmed"]);
    if (Object.keys(raw).some((key) => !allowedFields.has(key))) {
      throw new InputError("请求体包含不支持的字段");
    }
    if (raw.confirmed !== true) throw new InputError("拆分前必须确认数量分配");
    const version = requireInt(raw.version, "version", 1);
    // 开封数量先做定点校验（>0）；计件单位必须整数由路由层按批次单位复核，
    // 毫升批次允许小数（如拆分 2.5ml）。
    const openedQuantity = fixedPointQuantity(raw.openedQuantity, "openedQuantity");
    if (openedQuantity === null || openedQuantity <= 0) {
      throw new InputError("openedQuantity 必须大于 0");
    }
    const openedAt = calendarDate(raw.openedAt, "openedAt");
    if (openedAt === null) throw new InputError("拆分批次需要填写开封日期");
    if (isRecord(raw.afterOpeningLimit)) {
      const allowedLimitFields = new Set(["date", "value", "unit", "source"]);
      if (Object.keys(raw.afterOpeningLimit).some((key) => !allowedLimitFields.has(key))) {
        throw new InputError("afterOpeningLimit 包含不支持的字段");
      }
    }
    return {
      ok: true,
      value: {
        version,
        openedQuantity,
        openedAt,
        afterOpeningLimit: parseAfterOpeningLimit(raw.afterOpeningLimit),
        confirmed: true,
      },
    };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

/** Quantity-only edit: never interpret omitted metadata as replacements. */
export function validateBatchQuantityChange(
  raw: unknown,
  unit: QuantityUnit,
): ValidationResult<{ quantity: number | null; version: number }> {
  try {
    if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "quantity" && key !== "version") ||
        !Object.prototype.hasOwnProperty.call(raw, "quantity")) {
      throw new InputError("只允许修改 quantity 和 version，数量不能为空缺省");
    }
    return { ok: true, value: {
      quantity: quantityOrNull(raw.quantity, "quantity", unit),
      version: requireInt(raw.version, "version", 1),
    } };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

// ---------------------------------------------------------------------------
// 药品
// ---------------------------------------------------------------------------

export interface ValidatedMedicineFields {
  name: string;
  /** 人群整理标签；空数组 = 未标注。 */
  populationTags: PopulationTag[];
  /** 用途整理标签。 */
  purposeTags: PurposeTag[];
  /** 标签来源（备份恢复时保留原值；常规创建默认 manual）。 */
  tagSource: TagSource;
  specification: string | null;
  brand: string | null;
  brandProvided: boolean;
  manufacturer: string | null;
  approvalNumber: string | null;
  barcodeValue: string | null;
  activeIngredients: string[];
  purposeCategory: string | null;
  leafletPurposeSummary: string | null;
  leafletPackageUsageSummary: string | null;
  leafletContraindicationsSummary: string | null;
  leafletPrecautionsSummary: string | null;
  leafletSource: string | null;
  leafletReviewStatus: LeafletReviewStatus;
  lowStockThreshold: { quantity: number; unit: QuantityUnit } | null;
  lowStockThresholdProvided: boolean;
  batches: ValidatedBatchFields[];
}

function parseLowStockThreshold(value: unknown): { quantity: number; unit: QuantityUnit } | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new InputError("lowStockThreshold 必须是对象或 null");
  if (typeof value.unit !== "string" || !QUANTITY_UNITS.includes(value.unit as QuantityUnit)) {
    throw new InputError("lowStockThreshold.unit 不合法");
  }
  const unit = value.unit as QuantityUnit;
  const quantity = quantityOrNull(value.quantity, "lowStockThreshold.quantity", unit);
  if (quantity === null) throw new InputError("lowStockThreshold.quantity 不能为空");
  return { quantity, unit };
}

function parseMedicine(raw: Record<string, unknown>): ValidatedMedicineFields {
  const name = text(raw.name, "name");
  if (name === null) throw new InputError("药品名称不能为空");
  const barcodeValue = text(raw.barcodeValue, "barcodeValue");
  if (barcodeValue !== null && barcodeValue.length > 160) throw new InputError("barcodeValue 不能超过 160 个字符");

  const activeIngredients: string[] = [];
  if (raw.activeIngredients !== undefined && raw.activeIngredients !== null) {
    if (!Array.isArray(raw.activeIngredients)) {
      throw new InputError("activeIngredients 必须是字符串数组");
    }
    for (const item of raw.activeIngredients) {
      if (typeof item !== "string") throw new InputError("activeIngredients 必须是字符串数组");
      const trimmed = item.trim();
      if (trimmed !== "") activeIngredients.push(trimmed);
    }
  }

  const leaflet = isRecord(raw.leaflet) ? raw.leaflet : {};
  const leafletReviewStatus = oneOf(
    leaflet.reviewStatus,
    "leaflet.reviewStatus",
    LEAFLET_REVIEW_STATUSES,
    "unverified",
  );

  const batches: ValidatedBatchFields[] = [];
  if (raw.batches !== undefined && raw.batches !== null) {
    if (!Array.isArray(raw.batches)) throw new InputError("batches 必须是数组");
    for (const item of raw.batches) {
      if (!isRecord(item)) throw new InputError("批次必须是对象");
      batches.push(parseBatch(item));
    }
  }

  return {
    name,
    populationTags: tagList(raw.populationTags, "populationTags", POPULATION_TAGS),
    purposeTags: tagList(raw.purposeTags, "purposeTags", PURPOSE_TAGS),
    tagSource: parseTagSource(raw.tagSource),
    specification: text(raw.specification, "specification"),
    brand: text(raw.brand, "brand"),
    brandProvided: Object.prototype.hasOwnProperty.call(raw, "brand"),
    manufacturer: text(raw.manufacturer, "manufacturer"),
    approvalNumber: text(raw.approvalNumber, "approvalNumber"),
    barcodeValue,
    activeIngredients,
    purposeCategory: text(raw.purposeCategory, "purposeCategory"),
    leafletPurposeSummary: text(leaflet.purposeSummary, "leaflet.purposeSummary"),
    leafletPackageUsageSummary: text(leaflet.packageUsageSummary, "leaflet.packageUsageSummary"),
    leafletContraindicationsSummary: text(leaflet.contraindicationsSummary, "leaflet.contraindicationsSummary"),
    leafletPrecautionsSummary: text(leaflet.precautionsSummary, "leaflet.precautionsSummary"),
    leafletSource: text(leaflet.source, "leaflet.source"),
    leafletReviewStatus,
    lowStockThreshold: parseLowStockThreshold(raw.lowStockThreshold),
    lowStockThresholdProvided: raw.lowStockThreshold !== undefined,
    batches,
  };
}

/** Threshold-only edit never enters whole-medicine batch synchronization. */
export function validateMedicineThresholdChange(
  raw: unknown,
): ValidationResult<{ lowStockThreshold: ValidatedMedicineFields["lowStockThreshold"]; version: number }> {
  try {
    if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "lowStockThreshold" && key !== "version") ||
        !Object.prototype.hasOwnProperty.call(raw, "lowStockThreshold")) {
      throw new InputError("只允许修改 lowStockThreshold 和 version");
    }
    return { ok: true, value: {
      lowStockThreshold: parseLowStockThreshold(raw.lowStockThreshold),
      version: requireInt(raw.version, "version", 1),
    } };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

export function validateMedicineInput(raw: unknown): ValidationResult<ValidatedMedicineFields> {
  try {
    if (!isRecord(raw)) return { ok: false, message: "请求体必须是对象" };
    return { ok: true, value: parseMedicine(raw) };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

export function validateMedicineUpdateInput(
  raw: unknown,
  existingBatches: readonly { id: string; unit: string; conversion_unit?: string | null }[] = [],
): ValidationResult<ValidatedMedicineFields & { version: number }> {
  try {
    if (!isRecord(raw)) return { ok: false, message: "请求体必须是对象" };
    const version = requireInt(raw.version, "version", 1);
    const merged = Array.isArray(raw.batches) ? { ...raw, batches: raw.batches.map((batch: unknown) => {
      if (!isRecord(batch)) return batch;
      const existing = existingBatches.find((row) => row.id === batch.id);
      return existing !== undefined && batch.conversionUnit === undefined && batch.unit === existing.unit && existing.conversion_unit != null
        ? { ...batch, conversionUnit: existing.conversion_unit } : batch;
    }) } : raw;
    return { ok: true, value: { ...parseMedicine(merged), version } };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

// ---------------------------------------------------------------------------
// 个人剂量备注
// ---------------------------------------------------------------------------

export interface ValidatedNoteFields {
  content: string;
  visibility: NoteVisibility;
}

function parseNoteContent(value: unknown, field: string): string {
  const content = text(value, field);
  if (content === null) throw new InputError(`${field} 不能为空`);
  return content;
}

function parseNoteVisibility(value: unknown): NoteVisibility {
  return oneOf(value, "visibility", NOTE_VISIBILITIES, "private");
}

export function validateNoteInput(raw: unknown): ValidationResult<ValidatedNoteFields> {
  try {
    if (!isRecord(raw)) return { ok: false, message: "请求体必须是对象" };
    return {
      ok: true,
      value: {
        content: parseNoteContent(raw.content, "content"),
        visibility: parseNoteVisibility(raw.visibility),
      },
    };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

export interface ValidatedNoteUpdateFields {
  /** null = 不修改内容，仅调整可见性。 */
  content: string | null;
  visibility: NoteVisibility;
  version: number;
}

export function validateNoteUpdateInput(
  raw: unknown,
): ValidationResult<ValidatedNoteUpdateFields> {
  try {
    if (!isRecord(raw)) return { ok: false, message: "请求体必须是对象" };
    const version = requireInt(raw.version, "version", 1);
    const content =
      raw.content === undefined || raw.content === null
        ? null
        : parseNoteContent(raw.content, "content");
    return {
      ok: true,
      value: { content, visibility: parseNoteVisibility(raw.visibility), version },
    };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

export interface ValidatedFamilyInventorySettings {
  stocktakeInterval: StocktakeInterval;
}

export function validateFamilyInventorySettingsInput(
  raw: unknown,
): ValidationResult<ValidatedFamilyInventorySettings> {
  try {
    if (!isRecord(raw)) return { ok: false, message: "请求体必须是对象" };
    return {
      ok: true,
      value: {
        stocktakeInterval: (() => {
          if (typeof raw.stocktakeInterval !== "string" || !STOCKTAKE_INTERVALS.includes(raw.stocktakeInterval as StocktakeInterval)) {
            throw new InputError("stocktakeInterval 不合法");
          }
          return raw.stocktakeInterval as StocktakeInterval;
        })(),
      },
    };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

export function validateStocktakeItemsInput(
  raw: unknown,
): ValidationResult<{ items: StocktakeItemInput[] }> {
  try {
    if (!isRecord(raw) || !Array.isArray(raw.items)) {
      throw new InputError("items 必须是数组");
    }
    if (raw.items.length > 500) throw new InputError("一次盘点最多处理 500 个批次");
    const seen = new Set<string>();
    const items = raw.items.map((entry) => {
      if (!isRecord(entry)) throw new InputError("盘点项必须是对象");
      const batchId = text(entry.batchId, "batchId");
      if (batchId === null) throw new InputError("batchId 不能为空");
      if (seen.has(batchId)) throw new InputError("batchId 不能重复");
      seen.add(batchId);
      if (typeof entry.outcome !== "string" || !STOCKTAKE_OUTCOMES.includes(entry.outcome as (typeof STOCKTAKE_OUTCOMES)[number])) {
        throw new InputError("outcome 不合法");
      }
      const outcome = entry.outcome as (typeof STOCKTAKE_OUTCOMES)[number];
      const quantity = stocktakeQuantityOrNull(entry.quantity);
      if (outcome === "adjusted" && quantity === null) {
        throw new InputError("adjusted 必须提供非负整数 quantity");
      }
      if (outcome !== "adjusted" && quantity !== null) {
        throw new InputError("只有 adjusted 可以提供 quantity");
      }
      return {
        batchId,
        version: requireInt(entry.version, "version", 1),
        outcome,
        ...(outcome === "adjusted" ? { quantity } : {}),
      } satisfies StocktakeItemInput;
    });
    return { ok: true, value: { items } };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

export interface ValidatedRestockInput {
  medicineId: string;
  desiredQuantity: number | null;
  unit: QuantityUnit;
  status: RestockStatus;
}

export function validateRestockInput(raw: unknown): ValidationResult<ValidatedRestockInput> {
  try {
    if (!isRecord(raw)) return { ok: false, message: "请求体必须是对象" };
    const medicineId = text(raw.medicineId, "medicineId");
    if (medicineId === null) throw new InputError("medicineId 不能为空");
    if (typeof raw.unit !== "string" || !QUANTITY_UNITS.includes(raw.unit as QuantityUnit)) {
      throw new InputError("unit 不合法");
    }
    return {
      ok: true,
      value: {
        medicineId,
        desiredQuantity: quantityOrNull(raw.desiredQuantity, "desiredQuantity", raw.unit as QuantityUnit),
        unit: raw.unit as QuantityUnit,
        status: oneOf(raw.status, "status", RESTOCK_STATUSES, "needed"),
      },
    };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

export interface ValidatedRestockUpdateInput {
  desiredQuantity: number | null | undefined;
  unit: QuantityUnit | undefined;
  status: RestockStatus | undefined;
  version: number;
}

export function validateRestockUpdateInput(raw: unknown): ValidationResult<ValidatedRestockUpdateInput> {
  try {
    if (!isRecord(raw)) return { ok: false, message: "请求体必须是对象" };
    if (raw.desiredQuantity === undefined && raw.unit === undefined && raw.status === undefined) {
      throw new InputError("至少需要提供一个要更新的字段");
    }
    return {
      ok: true,
      value: {
        // 定点校验；计件单位整数性由路由层按最终单位（新值或既有条目单位）复核。
        desiredQuantity: raw.desiredQuantity === undefined ? undefined : fixedPointQuantity(raw.desiredQuantity, "desiredQuantity"),
        unit: raw.unit === undefined ? undefined : oneOf(raw.unit, "unit", QUANTITY_UNITS, "other"),
        status: raw.status === undefined ? undefined : oneOf(raw.status, "status", RESTOCK_STATUSES, "needed"),
        version: requireInt(raw.version, "version", 1),
      },
    };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}
