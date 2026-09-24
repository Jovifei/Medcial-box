// 请求体校验：所有错误最终映射为 400 { error: { code: "VALIDATION_ERROR" } }。
// 校验规则与设计文档对齐：
// - 数量 quantity：null/缺省 = 未知，整数 ≥ 0；
// - 有效期：value 与 precision 必须成对且可解析，年月/日期按历法校验；
// - 盒→片换算数 confirmedUnitsPerPackage：仅可为正整数（用户确认后填写）；
// - 更新类请求必须携带整数 version（≥ 1）。
import type { ExpiryPrecision, QuantityUnit } from "@home-medicine/contracts";
import { parseExpiry } from "./domain/expiry.js";

export type LeafletReviewStatus = "unverified" | "matched" | "user_confirmed";
export type NoteVisibility = "private" | "family";

const QUANTITY_UNITS: readonly QuantityUnit[] = [
  "tablet",
  "capsule",
  "sachet",
  "bottle",
  "box",
  "other",
];

const EXPIRY_PRECISIONS: readonly ExpiryPrecision[] = ["day", "month", "unknown"];

const LEAFLET_REVIEW_STATUSES: readonly LeafletReviewStatus[] = [
  "unverified",
  "matched",
  "user_confirmed",
];

const NOTE_VISIBILITIES: readonly NoteVisibility[] = ["private", "family"];

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

class InputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, fallback: string | null = null): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new InputError(`${field} 必须是文本`);
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

function intOrNull(value: unknown, field: string, min: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new InputError(`${field} 必须是不小于 ${min} 的整数`);
  }
  return value;
}

function requireInt(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new InputError(`${field} 必须是不小于 ${min} 的整数`);
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
  storageLocation: string | null;
}

function parseBatch(raw: Record<string, unknown>): ValidatedBatchFields {
  const lotNumber = text(raw.lotNumber, "lotNumber");

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

  return {
    id: raw.id === undefined || raw.id === null ? null : text(raw.id, "id"),
    version: raw.version === undefined || raw.version === null ? null : requireInt(raw.version, "version", 1),
    lotNumber,
    expiryValue,
    expiryPrecision,
    quantity: intOrNull(raw.quantity, "quantity", 0),
    unit: oneOf(raw.unit, "unit", QUANTITY_UNITS, "other"),
    confirmedUnitsPerPackage: intOrNull(raw.confirmedUnitsPerPackage, "confirmedUnitsPerPackage", 1),
    storageLocation: text(raw.storageLocation, "storageLocation"),
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
): ValidationResult<ValidatedBatchFields & { version: number }> {
  try {
    if (!isRecord(raw)) return { ok: false, message: "请求体必须是对象" };
    const version = requireInt(raw.version, "version", 1);
    return { ok: true, value: { ...parseBatch(raw), version } };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "请求体不合法" };
  }
}

// ---------------------------------------------------------------------------
// 药品
// ---------------------------------------------------------------------------

export interface ValidatedMedicineFields {
  name: string;
  specification: string | null;
  manufacturer: string | null;
  approvalNumber: string | null;
  activeIngredients: string[];
  purposeCategory: string | null;
  leafletPurposeSummary: string | null;
  leafletPackageUsageSummary: string | null;
  leafletContraindicationsSummary: string | null;
  leafletPrecautionsSummary: string | null;
  leafletSource: string | null;
  leafletReviewStatus: LeafletReviewStatus;
  batches: ValidatedBatchFields[];
}

function parseMedicine(raw: Record<string, unknown>): ValidatedMedicineFields {
  const name = text(raw.name, "name");
  if (name === null) throw new InputError("药品名称不能为空");

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
    specification: text(raw.specification, "specification"),
    manufacturer: text(raw.manufacturer, "manufacturer"),
    approvalNumber: text(raw.approvalNumber, "approvalNumber"),
    activeIngredients,
    purposeCategory: text(raw.purposeCategory, "purposeCategory"),
    leafletPurposeSummary: text(leaflet.purposeSummary, "leaflet.purposeSummary"),
    leafletPackageUsageSummary: text(leaflet.packageUsageSummary, "leaflet.packageUsageSummary"),
    leafletContraindicationsSummary: text(leaflet.contraindicationsSummary, "leaflet.contraindicationsSummary"),
    leafletPrecautionsSummary: text(leaflet.precautionsSummary, "leaflet.precautionsSummary"),
    leafletSource: text(leaflet.source, "leaflet.source"),
    leafletReviewStatus,
    batches,
  };
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
): ValidationResult<ValidatedMedicineFields & { version: number }> {
  try {
    if (!isRecord(raw)) return { ok: false, message: "请求体必须是对象" };
    const version = requireInt(raw.version, "version", 1);
    return { ok: true, value: { ...parseMedicine(raw), version } };
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
