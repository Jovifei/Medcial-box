import { api, ApiError, captureSessionIdentity, isCurrentSession } from "../../services/api";
import { registerDirtyDraft, clearDirtyDraft } from "../../services/draft-guard";
import type { DirtyDraft } from "../../services/draft-guard";
import { ensureLoggedIn } from "../../services/auth";
import { closeOwnedPhotoFile, PhotoFileWriteError, writeOwnedPhotoFile } from "../../services/photo-file-lifecycle";
import type { OwnedPhotoFile } from "../../services/photo-file-lifecycle";
import { readSessionScope, scopedStorageKey, subscribeSessionChanges } from "../../services/session-scope";
import { confirmIngredientOverlap, findVerifiedIngredientMatches } from "../../services/ingredient-matches";
import {
  UNIT_VALUES,
  UNIT_LABELS,
  parseQuantityByUnit,
  parseConfirmedUnitsByUnit,
  unitAllowsDecimals,
  isValidExpiryValue,
  expiryValueForPrecision,
} from "../../services/input-validation";
import { parseMedicineBarcode } from "../../services/barcode-parser";
import { POPULATION_TAG_OPTIONS, PURPOSE_TAG_OPTIONS } from "../../services/medicine-tags";
import { REVIEW_LABELS, evidenceField, formField, photoCandidates, recognitionFields } from "../../services/recognition-review";
import { mergeRecognitionEvidence } from "../../services/recognition-evidence-merge";
import { getPendingRecognitionEvidence, queueRecognitionEvidence, retryRecognitionEvidence } from "../../services/recognition-evidence-sync";
import type { FieldSource, PhotoReview, ReviewChoice, ReviewConflict, ReviewField, ReviewValue } from "../../services/recognition-review";
import type {
  ExpiryPrecision,
  MedicineCandidate,
  MedicationSummary,
  MedicinePayload,
  RecognitionEvidence,
  RecognitionEvidenceBatchSource,
  RecognitionEvidenceSave,
} from "../../services/api-types";

const PRECISION_VALUES: ExpiryPrecision[] = ["day", "month", "unknown"];
const PRECISION_LABELS = ["年、月、日", "仅年、月", "未知"];
const PURPOSE_OPTIONS = ["未分类", "解热镇痛", "感冒咳嗽", "胃肠消化", "过敏", "外用", "其他"];

/**
 * 从规格/品名文本按最后一个非"盒"的包装单位关键词预填批次单位（Jovi 2026-10-25）：
 * "3克×10袋"→袋、"0.3g×20粒"→粒、"10ml×6支"→支；识别不到保持默认"盒"。
 */
function unitIndexFromText(text: string | null | undefined): number | null {
  const value = typeof text === "string" ? text : "";
  if (value === "") return null;
  const keywords: Array<[string, number]> = [
    ["片", 0], ["粒", 1], ["袋", 2], ["条", 2], ["瓶", 3], ["板", 5], ["毫升", 6], ["ml", 6], ["mL", 6], ["支", 8],
  ];
  let hit: number | null = null;
  for (const [keyword, unitIndex] of keywords) {
    const at = value.lastIndexOf(keyword);
    if (at >= 0) hit = unitIndex;
  }
  return hit;
}

interface BatchForm {
  /** 已有批次标识（编辑时从详情带入，保存时随 payload 回传）；null = 新增。 */
  id: string | null;
  /** Stable identity for an unsaved batch; never sent in the API payload. */
  draftKey?: string;
  /** 已有批次版本（后端乐观锁门）。 */
  version: number | null;
  lotNumber: string;
  expiryValue: string;
  precisionIndex: number;
  quantity: string;
  quantityUnknown: boolean;
  unitIndex: number;
  conversionUnitIndex: number;
  confirmedUnits: string;
  storageLocation: string;
  openedState: "unknown" | "unopened" | "opened";
  openedAt: string;
  openingLimitMode: "none" | "day" | "month" | "date";
  openingLimitValue: string;
  openingLimitSource: string;
  openedStateIndex: number;
  openingLimitModeIndex: number;
  openingExpanded: boolean;
}

interface MedicineEditPageData {
  createOperationKey: string;
  attemptedPayload: MedicinePayload | null;
  isEdit: boolean;
  medicineId: string;
  version: number;
  medicineLoading: boolean;
  scopeInvalidated: boolean;
  submitting: boolean;
  recognizing: boolean;
  recognitionSeconds: number;
  recognitionSubject: string;
  storageExpanded: boolean;
  isDirty: boolean;
  leaveSheetVisible: boolean;
  draftAvailable: boolean;
  /** 本机存在属于其他账号/家庭（或旧版本无归属）的草稿：保留但不自动恢复。 */
  draftForeign: boolean;
  statusBarHeight: number;
  navBarHeight: number;
  navRightGap: number;
  classificationExpanded: boolean;
  photoDrafts: PhotoEntryDraft[];
  usePhotoAsCover: boolean;
  activePhotoDraftId: string;
  optionalExpanded: boolean;
  conversionExpanded: boolean;
  recognitionHint: string;
  scannedBarcode: string;
  barcodeLookupStatus: string;
  canRetryBarcode: boolean;
  name: string;
  brand: string;
  specification: string;
  manufacturer: string;
  approvalNumber: string;
  barcodeValue: string;
  ingredients: string;
  purposeCategory: string;
  /** 人群/用途整理标签（kind 值）；编辑页可增删，保存时随 payload 写回（B02）。 */
  populationTags: string[];
  purposeTags: string[];
  /** Explicit manual edits, including cleared fields, are scoped to this draft. */
  manualEdits: Record<string, boolean>;
  fieldSources: Partial<Record<ReviewField, FieldSource>>;
  batchSources: LocalBatchSource[];
  resolvedConflictPhotoIds: Record<string, string[]>;
  photoReviewItems: PhotoReviewItem[];
  photoReviewExpanded: boolean;
  selectedReviewPhotoId: string;
  selectedReviewPhoto: PhotoReviewItem | null;
  reviewConflicts: ReviewConflict[];
  sourceLabels: Partial<Record<ReviewField, string>>;
  batchSourceLabels: Record<string, string>;
  /** 明确增删（含全取消）随本份草稿保存，不影响其它草稿的候选填充。 */
  purposeTagsTouched: boolean;
  /** WXML 不执行方法表达式（B24）：chip 的 selected 由 TS 预计算。 */
  populationChips: Array<{ kind: string; label: string; selected: boolean }>;
  purposeChips: Array<{ kind: string; label: string; selected: boolean }>;
  leafletPurpose: string;
  leafletUsage: string;
  leafletContraindications: string;
  leafletPrecautions: string;
  leafletSource: string;
  leafletText: string;
  verified: boolean;
  batches: BatchForm[];
  unitLabels: string[];
  precisionLabels: string[];
  purposeOptions: string[];
  purposeIndex: number;
  captureSource: "" | "camera" | "album";
  candidate: MedicineCandidate | null;
  candidates: MedicineCandidate[];
  candidateWarnings: string[];
  openedStateLabels: string[];
  openingLimitModeLabels: string[];
  openedStateIndex: number;
  openingLimitModeIndex: number;
}

type MedicineDraftValues = Pick<MedicineEditPageData,
  "createOperationKey" | "attemptedPayload" | "usePhotoAsCover" | "name" | "brand" | "specification" | "manufacturer" | "approvalNumber" | "barcodeValue" |
  "ingredients" | "purposeCategory" | "populationTags" | "purposeTags" | "purposeTagsTouched" | "manualEdits" | "fieldSources" | "batchSources" | "resolvedConflictPhotoIds" |
  "leafletPurpose" | "leafletUsage" |
  "leafletContraindications" | "leafletPrecautions" | "leafletSource" | "verified" |
  "batches" | "purposeIndex" | "scannedBarcode" | "leafletText">;

interface StoredMedicineDraft {
  schemaVersion: 1;
  medicineId: string;
  savedAt: string;
  fields: MedicineDraftValues;
  /** 缺失即代表旧版本草稿：不属于任何已知账号，不得自动迁移。 */
  ownerUserId?: string;
  ownerFamilyId?: string;
}

interface PhotoEntryDraft {
  id: string;
  thumbnail: string;
  status: "review" | "recognizing" | "failed" | "saved" | "photo_pending" | "cleanup_pending";
  failureCode?: "local_read" | "local_storage" | "network" | "recognition_service" | "unknown" | null;
  fields: MedicineDraftValues;
  medicineId: string;
  nextPhotoSequence?: number;
  batchReceipts?: Array<{ batchKey: string; id: string }>;
  coverIntent?: { photoId: string; expectedVersion: number; completedVersion?: number };
  savedMedicinePayload?: string;
  savedMedicineVersion?: number;
  evidenceIntent?: RecognitionEvidenceSave;
  photos: Array<{
    path: string; mimeType: "image/jpeg" | "image/png"; purpose: "box_front" | "expiry" | "leaflet";
    batchIndex: number; uploadedId?: string; uploadIntentKey?: string;
    clientPhotoId?: string; sequence?: number; review?: PhotoReview; removed?: boolean; batchKey?: string;
    ownedLocal?: OwnedPhotoFile;
    localFileRemoved?: boolean;
  }>;
}

interface LocalBatchSource extends FieldSource { batchKey: string; field: "expiry" | "lotNumber" }

class PhotoSaveDeferred extends Error {}

interface PhotoReviewItem {
  clientPhotoId: string;
  sequence: number;
  numberLabel: string;
  path: string;
  kindLabel: string;
  statusLabel: string;
  batchLabel?: string;
  fields: Array<{ field: ReviewField; label: string; value: string }>;
}

/** Assign identifiers only within the owning draft; never renumber remaining photos. */
function assignPhotoIdentities(draft: PhotoEntryDraft): void {
  let next = Math.max(draft.nextPhotoSequence ?? 0, ...draft.photos.map(photo => photo.sequence ?? 0), 0);
  const usedNumbers = new Set<number>();
  const usedIds = new Set<string>();
  for (const photo of draft.photos) {
    if (!Number.isSafeInteger(photo.sequence) || (photo.sequence ?? 0) <= 0 || usedNumbers.has(photo.sequence!)) {
      photo.sequence = ++next;
    }
    usedNumbers.add(photo.sequence!);
    if (!photo.clientPhotoId || usedIds.has(photo.clientPhotoId)) photo.clientPhotoId = `${draft.id}-${photo.sequence}`;
    usedIds.add(photo.clientPhotoId);
  }
  draft.nextPhotoSequence = next;
}

function displayReviewValue(field: ReviewField, value: ReviewValue): string {
  if (!Array.isArray(value)) return value ?? "";
  const options = field === "populationTags" ? POPULATION_TAG_OPTIONS : field === "purposeTags" ? PURPOSE_TAG_OPTIONS : [];
  return value.map(item => options.find(option => option.kind === item)?.label ?? item).join("、");
}

function batchKey(batch: BatchForm | undefined): string {
  if (!batch) return "";
  return batch.id ? `saved:${batch.id}` : batch.draftKey ? `draft:${batch.draftKey}` : "";
}

function photoBatchKey(photo: PhotoEntryDraft["photos"][number], draft: PhotoEntryDraft, current: BatchForm[]): string {
  if (photo.batchKey) return photo.batchKey;
  const saved = batchKey(draft.fields?.batches?.[photo.batchIndex]);
  // Old drafts may lack stable keys. Only a sole batch can be identified without guessing.
  return saved || (current.length === 1 && photo.batchIndex === 0 ? batchKey(current[0]) : "");
}

function reviewFormField(field: ReviewField, ownerBatchKey: string | undefined, batches: BatchForm[]): string | null {
  if (field !== "expiryValue" && field !== "lotNumber") return formField(field);
  const index = batches.findIndex(batch => batchKey(batch) === ownerBatchKey);
  return index < 0 ? null : `batches[${index}].${field}`;
}

const snapshot = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
/** Apply this page's changes to a fresh durable snapshot, never a stale whole queue. */
function rebasePhotoValue(current: unknown, baseline: unknown, latest: unknown, field = ""): unknown {
  if (JSON.stringify(current) === JSON.stringify(latest)) return snapshot(latest);
  if (JSON.stringify(current) === JSON.stringify(baseline)) return snapshot(latest);
  if (JSON.stringify(latest) === JSON.stringify(baseline)) return snapshot(current);
  if (Array.isArray(current) && Array.isArray(baseline) && Array.isArray(latest)) {
    if (field === "photos") {
      const result = snapshot(latest) as PhotoEntryDraft["photos"];
      for (const photo of current as PhotoEntryDraft["photos"]) {
        const before = (baseline as PhotoEntryDraft["photos"]).find((item) => item.path === photo.path);
        const index = result.findIndex((item) => item.path === photo.path);
        if (index < 0) { if (!before) result.push(snapshot(photo)); }
        else result[index] = rebasePhotoValue(photo, before, result[index]) as PhotoEntryDraft["photos"][number];
      }
      return result;
    }
    if (field === "batches") {
      const identities = (items: BatchForm[]): Array<string | null> => items.map((item) =>
        item.id !== null ? `saved:${item.id}` : item.draftKey ? `draft:${item.draftKey}` : null);
      const before = identities(baseline);
      if (before.includes(null) || new Set(before).size !== before.length ||
          JSON.stringify(identities(current)) !== JSON.stringify(before) ||
          JSON.stringify(identities(latest)) !== JSON.stringify(before)) {
        throw new Error("Concurrent photo-draft batch structure changed");
      }
      return current.map((item, index) => rebasePhotoValue(item, baseline[index], latest[index]));
    }
  }
  if (current && baseline && latest && typeof current === "object" && typeof baseline === "object" &&
      typeof latest === "object" && !Array.isArray(current) && !Array.isArray(baseline) && !Array.isArray(latest)) {
    const local = current as Record<string, unknown>, before = baseline as Record<string, unknown>, stored = latest as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(local), ...Object.keys(before), ...Object.keys(stored)])) {
      const value = rebasePhotoValue(local[key], before[key], stored[key], key);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  // An explicitly changed scalar/selection belongs to the current user action.
  return snapshot(current);
}

const MEDICINE_DRAFT_SCHEMA_VERSION = 1;
const NATIVE_LEAVE_WARNING = "此表单有未保存修改。离开后会保留本机草稿；如要放弃修改，请使用页面左上角返回按钮。";
const PHOTO_DRAFT_LIMIT_HINT = "本机已有10份未完成照片草稿，请通过“导入草稿”管理旧草稿后再拍照；原照片和文字仍保留。";
function nativeFailureKind(error: unknown): "cancel" | "permission" | "other" {
  const message = typeof error === "object" && error !== null && "errMsg" in error ? String(error.errMsg) : "";
  if (/cancel/i.test(message)) return "cancel";
  if (/auth\s*(?:deny|denied)|permission|authorize.*fail|权限/i.test(message)) return "permission";
  return "other";
}

function catalogLookupFailureMessage(error: unknown): string {
  switch (error instanceof ApiError ? error.code : "") {
    case "MEDICINE_CATALOG_NOT_CONFIGURED": return "商品码已扫到；药品资料服务尚未配置，请拍药盒识别或手动核对。";
    case "MEDICINE_CATALOG_UNAVAILABLE": return "商品码已扫到；资料服务暂不可用，可稍后重试。";
    case "NETWORK_ERROR": return "查询失败：网络连接失败；商品码已保留，请检查网络后重试。";
    case "UNAUTHORIZED": case "UNAUTHENTICATED": case "SESSION_EXPIRED": return "查询失败：登录已失效，请重新登录；商品码已保留。";
    default: return "条码已保留，查询失败；可重试或手动录入。";
  }
}

/**
 * 草稿键必须绑定当前 userId + familyId；没有可用身份时返回 null，
 * 由调用方禁用草稿读写（绝不退回全局键，否则就是跨账号共享数据）。
 */
function draftStorageKey(medicineId: string): string | null {
  return scopedStorageKey("medicine-edit-draft", medicineId || "new");
}

/** 旧版本草稿键：没有身份命名空间，永不被读取，仅用于提示"本机存在旧草稿"。 */
function legacyDraftKey(medicineId: string): string {
  return `medicine-edit-draft:${medicineId || "new"}`;
}

/** 草稿归属：用于识别"属于其他账号/家庭"或"旧版本无归属"的草稿。 */
interface DraftOwnership {
  ownerUserId?: string;
  ownerFamilyId?: string;
}

function currentOwnership(): DraftOwnership {
  const scope = readSessionScope();
  return scope === null ? {} : { ownerUserId: scope.userId, ownerFamilyId: scope.familyId };
}

function draftBelongsToCurrentSession(stored: DraftOwnership): boolean {
  const scope = readSessionScope();
  if (scope === null) return false;
  // 旧版本草稿没有归属字段：一律视为不属于当前账号，不自动迁移也不擅自删除。
  if (typeof stored.ownerUserId !== "string" || typeof stored.ownerFamilyId !== "string") return false;
  return stored.ownerUserId === scope.userId && stored.ownerFamilyId === scope.familyId;
}

function draftValues(data: MedicineEditPageData): MedicineDraftValues {
  return {
    createOperationKey: data.createOperationKey,
    attemptedPayload: data.attemptedPayload,
    usePhotoAsCover: data.usePhotoAsCover === true,
    name: data.name,
    brand: data.brand,
    specification: data.specification,
    manufacturer: data.manufacturer,
    approvalNumber: data.approvalNumber,
    barcodeValue: data.barcodeValue,
    ingredients: data.ingredients,
    purposeCategory: data.purposeCategory,
    populationTags: [...data.populationTags],
    purposeTags: [...data.purposeTags],
    purposeTagsTouched: data.purposeTagsTouched === true,
    manualEdits: { ...data.manualEdits },
    fieldSources: snapshot(data.fieldSources ?? {}),
    batchSources: snapshot(data.batchSources ?? []),
    resolvedConflictPhotoIds: snapshot(data.resolvedConflictPhotoIds ?? {}),
    leafletPurpose: data.leafletPurpose,
    leafletUsage: data.leafletUsage,
    leafletContraindications: data.leafletContraindications,
    leafletPrecautions: data.leafletPrecautions,
    leafletSource: data.leafletSource,
    leafletText: data.leafletText,
    verified: data.verified,
    batches: data.batches.map((batch) => ({ ...batch })),
    purposeIndex: data.purposeIndex,
    scannedBarcode: data.scannedBarcode,
  };
}

/** B24：WXML 不执行 indexOf，chip 的 selected 在 TS 侧预计算。 */
function buildPopulationChips(selected: string[]): Array<{ kind: string; label: string; selected: boolean }> {
  return POPULATION_TAG_OPTIONS.map((option) => ({
    kind: option.kind, label: option.label, selected: selected.includes(option.kind),
  }));
}

function buildPurposeChips(selected: string[]): Array<{ kind: string; label: string; selected: boolean }> {
  return PURPOSE_TAG_OPTIONS.map((option) => ({
    kind: option.kind, label: option.label, selected: selected.includes(option.kind),
  }));
}

function formFingerprint(data: MedicineEditPageData): string {  const fields = draftValues(data);
  return JSON.stringify({
    ...fields,
    batches: fields.batches.map((batch) => {
      const comparable: Partial<BatchForm> = { ...batch };
      delete comparable.openingExpanded;
      return comparable;
    }),
  });
}

let localBatchSequence = 0;
function emptyBatch(): BatchForm {
  return {
    id: null,
    draftKey: `batch-${Date.now()}-${++localBatchSequence}-${Math.random().toString(36).slice(2, 8)}`,
    version: null,
    lotNumber: "",
    expiryValue: "",
    precisionIndex: 2,
    quantity: "",
    quantityUnknown: true,
    unitIndex: 4,
    conversionUnitIndex: 0,
    confirmedUnits: "",
    storageLocation: "",
    openedState: "unknown",
    openedAt: "",
    openingLimitMode: "none",
    openingLimitValue: "",
    openingLimitSource: "",
    openedStateIndex: 0,
    openingLimitModeIndex: 0,
    openingExpanded: false,
  };
}

function batchFromSummary(summary: MedicationSummary): BatchForm[] {
  return summary.batches.map((batch) => ({
    id: batch.id,
    version: batch.version,
    lotNumber: batch.lotNumber ?? "",
    expiryValue: batch.expiry.value ?? "",
    precisionIndex: Math.max(0, PRECISION_VALUES.indexOf(batch.expiry.precision)),
    quantity: batch.quantity === null ? "" : String(batch.quantity),
    quantityUnknown: batch.quantity === null,
    unitIndex: Math.max(0, UNIT_VALUES.indexOf(batch.unit)),
    conversionUnitIndex: Math.max(0, UNIT_VALUES.indexOf(batch.conversionUnit ?? "tablet")),
    confirmedUnits:
      batch.confirmedUnitsPerPackage === null ? "" : String(batch.confirmedUnitsPerPackage),
    storageLocation: batch.storageLocation ?? "",
    openedState: batch.openedState ?? "unknown",
    openedAt: batch.openedAt ?? "",
    openingLimitMode: batch.afterOpeningLimit === null || batch.afterOpeningLimit === undefined
      ? "none"
      : "date" in batch.afterOpeningLimit ? "date" : batch.afterOpeningLimit.unit,
    openingLimitValue: batch.afterOpeningLimit === null || batch.afterOpeningLimit === undefined
      ? ""
      : "date" in batch.afterOpeningLimit ? batch.afterOpeningLimit.date : String(batch.afterOpeningLimit.value),
    openingLimitSource: batch.afterOpeningLimit?.source ?? "",
    openingExpanded: batch.openedState === "opened" || batch.afterOpeningLimit !== null && batch.afterOpeningLimit !== undefined,
    openedStateIndex: Math.max(0, ["unknown", "unopened", "opened"].indexOf(batch.openedState ?? "unknown")),
    openingLimitModeIndex: Math.max(0, ["none", "day", "month", "date"].indexOf(
      batch.afterOpeningLimit === null || batch.afterOpeningLimit === undefined
        ? "none"
        : "date" in batch.afterOpeningLimit ? "date" : batch.afterOpeningLimit.unit,
    )),
  }));
}

function buildBatchPayloads(batches: BatchForm[]): { payloads: object[]; error: string | null } {
  const payloads: object[] = [];
  for (const batch of batches) {
    const openedAt = typeof batch.openedAt === "string" ? batch.openedAt.trim() : "";
    const openingLimitMode = batch.openingLimitMode ?? "none";
    const openingLimitValue = typeof batch.openingLimitValue === "string" ? batch.openingLimitValue.trim() : "";
    const openingLimitSource = typeof batch.openingLimitSource === "string" ? batch.openingLimitSource.trim() : "";
    const precision = PRECISION_VALUES[batch.precisionIndex] ?? "unknown";
    let expiryValue: string | null = batch.expiryValue.trim();
    if (precision === "day" && expiryValue !== "" && !isValidExpiryValue(expiryValue, precision)) {
      return { payloads: [], error: "按日有效期需为真实日期 YYYY-MM-DD" };
    }
    if (precision === "month" && expiryValue !== "" && !isValidExpiryValue(expiryValue, precision)) {
      return { payloads: [], error: "按月有效期需为真实月份 YYYY-MM" };
    }
    if (precision === "unknown" || expiryValue === "") expiryValue = null;

    if (openedAt !== "" && !isValidExpiryValue(openedAt, "day")) {
      return { payloads: [], error: "开封日期需为真实日期 YYYY-MM-DD" };
    }
    let afterOpeningLimit: object | null = null;
    if (batch.openedState === "opened") {
      const source = openingLimitSource === "" ? null : openingLimitSource;
      if (openingLimitMode === "day" || openingLimitMode === "month") {
        const value = openingLimitValue;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
          return { payloads: [], error: "开封后期限需为正整数；不知道时可保持不记录" };
        }
        afterOpeningLimit = { value: Number(value), unit: openingLimitMode, source };
      } else if (openingLimitMode === "date") {
        if (!isValidExpiryValue(openingLimitValue, "day")) {
          return { payloads: [], error: "开封后截止日期需为真实日期 YYYY-MM-DD" };
        }
        afterOpeningLimit = { date: openingLimitValue, source };
      }
    }

    let quantity: number | null = null;
    if (batch.quantity.trim() !== "") {
      const unit = UNIT_VALUES[batch.unitIndex] ?? "other";
      const parsed = parseQuantityByUnit(batch.quantity, unit);
      if (parsed === null) {
        return {
          payloads: [],
          error: unitAllowsDecimals(unit)
            ? "毫升数量需为不小于 0 的数字，最多 3 位小数，或留空表示未知"
            : "数量需为不小于 0 的整数，或留空表示未知",
        };
      }
      quantity = parsed;
    }

    let confirmedUnits: number | null = null;
    if (batch.confirmedUnits.trim() !== "") {
      const unit = UNIT_VALUES[batch.conversionUnitIndex] ?? "tablet";
      const parsedUnits = parseConfirmedUnitsByUnit(batch.confirmedUnits, unit);
      if (parsedUnits === null) {
        return {
          payloads: [],
          error: unitAllowsDecimals(unit)
            ? "每瓶毫升数需为大于 0 的数字（仅在本人确认后填写）"
            : "每包装换算数需为正整数（仅在本人确认后填写）",
        };
      }
      confirmedUnits = parsedUnits;
    }

    payloads.push({
      // 已有批次携带 id/version（后端按版本乐观锁同步）；新增批次缺省即插入。
      ...(batch.id !== null ? { id: batch.id, version: batch.version } : {}),
      lotNumber: batch.lotNumber.trim() === "" ? null : batch.lotNumber.trim(),
      expiry: expiryValue === null ? null : { value: expiryValue, precision },
      quantity,
      unit: UNIT_VALUES[batch.unitIndex] ?? "other",
      confirmedUnitsPerPackage: confirmedUnits,
      conversionUnit: confirmedUnits === null ? null : UNIT_VALUES[batch.conversionUnitIndex] ?? "tablet",
      storageLocation: batch.storageLocation.trim() === "" ? null : batch.storageLocation.trim(),
      openedState: batch.openedState,
      openedAt: batch.openedState === "opened" && openedAt !== "" ? openedAt : null,
      afterOpeningLimit,
    });
  }
  return { payloads, error: null };
}

function showError(error: unknown): void {
  const message = error instanceof ApiError ? error.message : "操作失败，请稍后重试";
  wx.showToast({ title: message, icon: "none", duration: 2800 });
}

/** Only recorded, exact generated originals may be unlinked. Ambiguous files stay put. */
async function removePhotoDraftFiles(
  draft: PhotoEntryDraft, scopeKey: string, isCurrent: () => boolean,
): Promise<boolean> {
  const root = wx.env?.USER_DATA_PATH?.replace(/\/+$/, "");
  if (!root || !Array.isArray(draft.photos)) return false;
  const fs = wx.getFileSystemManager();
  let complete = true;
  for (const photo of draft.photos) {
    if (!isCurrent()) return false;
    if (photo.localFileRemoved) continue;
    // Picker/cache files outside the persistent directory are not owned by us.
    if (typeof photo.path !== "string") { complete = false; continue; }
    if (!photo.path.startsWith(`${root}/`)) continue;
    const owned = photo.ownedLocal;
    const relative = photo.path.slice(root.length + 1);
    const extension = photo.mimeType === "image/png" ? "png" : "jpg";
    const expectedPrefix = `${draft.id}-${photo.purpose}-`;
    if (!owned || owned.scopeKey !== scopeKey || owned.draftId !== draft.id || owned.path !== photo.path ||
        !/^photo-\d+-[a-z0-9]{1,6}$/.test(draft.id) ||
        !["box_front", "expiry", "leaflet"].includes(photo.purpose) ||
        !relative.startsWith(expectedPrefix) ||
        !new RegExp(`^\\d+\\.${extension}$`).test(relative.slice(expectedPrefix.length))) {
      complete = false;
      continue;
    }
    if (!(await closeOwnedPhotoFile(owned)) || !isCurrent()) { complete = false; continue; }
    const removed = await new Promise<boolean>((resolve) => {
      try {
        fs.unlink({
          filePath: photo.path,
          success: () => resolve(true),
          // The previous removal may have succeeded before storage acknowledged it.
          fail: (error) => resolve(/(?:ENOENT|no such file or directory)/i.test(error.errMsg ?? "")),
        });
      } catch { resolve(false); }
    });
    if (!isCurrent()) return false;
    if (removed) photo.localFileRemoved = true;
    else complete = false;
  }
  return complete;
}

Page({
  data: {
    createOperationKey: "",
    attemptedPayload: null as MedicinePayload | null,
    isEdit: false,
    medicineId: "",
    version: 1,
    medicineLoading: false,
    scopeInvalidated: false,
    submitting: false,
    recognizing: false,
    recognitionSeconds: 0,
    recognitionSubject: "药品",
    storageExpanded: false,
    isDirty: false,
    leaveSheetVisible: false,
    draftAvailable: false,
    draftForeign: false,
    statusBarHeight: 20,
    navBarHeight: 64,
    navRightGap: 48,
    classificationExpanded: false,
    photoDrafts: [] as PhotoEntryDraft[],
    usePhotoAsCover: false,
    activePhotoDraftId: "",
    optionalExpanded: false,
    conversionExpanded: false,
    recognitionHint: "",
    scannedBarcode: "",
    barcodeLookupStatus: "",
    canRetryBarcode: false,
    name: "",
    brand: "",
    specification: "",
    manufacturer: "",
    approvalNumber: "",
    barcodeValue: "",
    ingredients: "",
    purposeCategory: "",
    populationTags: [] as string[],
    purposeTags: [] as string[],
    manualEdits: {} as Record<string, boolean>,
    fieldSources: {} as Partial<Record<ReviewField, FieldSource>>,
    batchSources: [] as LocalBatchSource[],
    resolvedConflictPhotoIds: {} as Record<string, string[]>,
    batchSourceLabels: {} as Record<string, string>,
    photoReviewItems: [] as PhotoReviewItem[],
    photoReviewExpanded: false,
    selectedReviewPhotoId: "",
    selectedReviewPhoto: null as PhotoReviewItem | null,
    reviewConflicts: [] as ReviewConflict[],
    sourceLabels: {} as Partial<Record<ReviewField, string>>,
    purposeTagsTouched: false,
    populationChips: buildPopulationChips([]),
    purposeChips: buildPurposeChips([]),
    leafletPurpose: "",
    leafletUsage: "",
    leafletContraindications: "",
    leafletPrecautions: "",
    leafletSource: "",
    leafletText: "",
    verified: false,
    batches: [emptyBatch()],
    unitLabels: UNIT_LABELS,
    precisionLabels: PRECISION_LABELS,
    purposeOptions: PURPOSE_OPTIONS,
    purposeIndex: 0,
    captureSource: "",
    candidate: null as MedicineCandidate | null,
    candidates: [] as MedicineCandidate[],
    candidateWarnings: [] as string[],
    openedStateLabels: ["未记录", "未开封", "已开封"],
    openingLimitModeLabels: ["不记录", "开封后天数", "开封后月数", "指定截止日期"],
    openedStateIndex: 0,
    openingLimitModeIndex: 0,
  },

  /** 编辑已有药品时，识别必须等待资料加载完成，避免后返回的请求覆盖识别草稿。 */
  medicineLoadPromise: null as Promise<void> | null,
  /**
   * 字段修改版本：用户显式改过（含清空为 ""）的字段，晚到的识别/候选响应不得覆盖。
   * 键为 setData 路径（"name"、"batches[0].expiryValue"…）。
   */
  touchedFields: {} as Record<string, number>,
  /** 识别请求代次：只接受最新一次请求的响应，旧响应直接丢弃。 */
  recognitionToken: 0,
  recognitionTimer: null as ReturnType<typeof setTimeout> | null,
  draftStorageKey: null as string | null,
  photoScopeKey: null as string | null,
  photoDraftStorageWarningShown: false,
  photoQueueBaseline: null as PhotoEntryDraft[] | null,
  photoFormBaseline: null as { id: string; fields: MedicineDraftValues } | null,
  photoCleanupRunning: false,
  entryDisposed: false,
  initialDraftSnapshot: "",
  pendingStoredDraft: null as MedicineDraftValues | null,
  discardingDraft: false,
  leaveNavigationPending: false,
  isolateNewEntry: false,
  photoDraftsImported: false,
  entryIdentity: null as ReturnType<typeof captureSessionIdentity> | null,
  unsubscribeSession: null as (() => void) | null,

  onLoad(options: { id?: string; capture?: string; scan?: string }): void {
    this.entryDisposed = false;
    const identity = captureSessionIdentity();
    this.entryIdentity = identity.token && readSessionScope() ? identity : null;
    this.unsubscribeSession?.();
    this.unsubscribeSession = subscribeSessionChanges(() => this.hideInvalidatedEntry());
    this.photoQueueBaseline = null;
    this.photoFormBaseline = null;
    const medicineId = options.id ?? "";
    this.isolateNewEntry = medicineId === "";
    this.photoDraftsImported = false;
    this.setData({ createOperationKey: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 12)}` });
    this.draftStorageKey = draftStorageKey(medicineId);
    try {
      const systemInfo = wx.getSystemInfoSync();
      const statusBarHeight = systemInfo.statusBarHeight ?? 20;
      let navRightGap = 48;
      try {
        const menuButton = wx.getMenuButtonBoundingClientRect();
        navRightGap = Math.max(navRightGap, systemInfo.windowWidth - menuButton.left + 8);
      } catch { /* retain the balanced fallback on older bases */ }
      this.setData({ statusBarHeight, navBarHeight: statusBarHeight + 44, navRightGap });
    } catch {
      this.setData({ statusBarHeight: 20, navBarHeight: 64 });
    }
    if (medicineId !== "") this.setData({ isEdit: true, medicineId });
    this.captureInitialSnapshot();
    this.loadStoredDraft();
    this.loadPhotoDrafts();
    void this.checkEntrySession();

    const captureSource = options.capture === "camera" || options.capture === "album" ? options.capture : "";
    if (options.scan === "1" || options.capture === "scan") {
      setTimeout(() => this.onScanCode(), 260);
    }
    if (captureSource !== "") {
      this.setData({ captureSource });
      setTimeout(() => this.onRecognizePhoto(captureSource), 260);
    }
    if (medicineId !== "") {
      this.setData({ medicineLoading: true });
      this.medicineLoadPromise = this.loadMedicine(medicineId);
    }
  },

  onShow(): void {
    this.hideInvalidatedEntry();
    if (this.data.scopeInvalidated) return;
    this.loadPhotoDrafts();
  },

  hideInvalidatedEntry(): void {
    if (this.entryDisposed || !this.entryIdentity ||
        (!this.photoScopeKey && !this.draftStorageKey)) return;
    const familyScope = scopedStorageKey("medicine-photo-drafts");
    if (this.data.scopeInvalidated) {
      const photoScope = this.data.medicineId ? scopedStorageKey("medicine-photo-drafts", this.data.medicineId) : familyScope;
      if (isCurrentSession(this.entryIdentity) && familyScope !== null &&
          (!this.photoScopeKey || this.photoScopeKey === photoScope) &&
          (!this.draftStorageKey || this.draftStorageKey === draftStorageKey(this.data.medicineId))) {
        this.setData({ scopeInvalidated: false });
      }
      return;
    }
    if (isCurrentSession(this.entryIdentity) && this.entryScopeIsCurrent(familyScope)) return;
    // A transition is signalled before the old family scope is cleared. Save an
    // unsaved manual form there only when its original scoped key still matches.
    if (this.data.isDirty && this.draftStorageKey === draftStorageKey(this.data.medicineId)) this.persistCurrentDraft(false);
    this.recognitionToken += 1;
    this.stopRecognitionClock();
    this.setData({ scopeInvalidated: true, recognizing: false, leaveSheetVisible: false });
  },

  onHide(): void {
    const data = this.data as MedicineEditPageData;
    if (data.isDirty && !this.discardingDraft) this.persistCurrentDraft(false);
  },

  onUnload(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.entryDisposed = true;
    this.recognitionToken += 1;
    this.stopRecognitionClock();
    const data = this.data as MedicineEditPageData;
    if (data.isDirty && !this.discardingDraft) this.persistCurrentDraft(false);
    this.setNativeLeaveWarning(false);
  },

  async loadMedicine(medicineId: string): Promise<void> {
    let originalScope = scopedStorageKey("medicine-photo-drafts");
    const originalMedicineId = this.data.medicineId;
    const initiallyUnowned = originalScope === null && this.draftStorageKey === null && this.photoScopeKey === null;
    const stillCurrent = (): boolean => this.entryScopeIsCurrent(originalScope) &&
      this.data.medicineId === originalMedicineId;
    try {
      // Cold start may bind an empty, as-yet-unowned page after login exactly once.
      if (originalScope !== null && !stillCurrent()) return;
      await ensureLoggedIn();
      if (initiallyUnowned) {
        originalScope = scopedStorageKey("medicine-photo-drafts");
      }
      if (!stillCurrent()) return;
      const medicine = await api.getMedicine(medicineId);
      if (!stillCurrent()) return;
      this.setData({
        name: medicine.name,
        brand: medicine.brand ?? "",
        specification: medicine.specification ?? "",
        manufacturer: medicine.manufacturer ?? "",
        approvalNumber: medicine.approvalNumber ?? "",
        barcodeValue: medicine.barcodeValue ?? "",
        ingredients: medicine.activeIngredients.join("、"),
        purposeCategory: medicine.purposeCategory ?? "",
        purposeIndex: Math.max(0, PURPOSE_OPTIONS.indexOf(medicine.purposeCategory ?? "")),
        populationTags: medicine.populationTags ?? [],
        purposeTags: medicine.purposeTags ?? [],
        populationChips: buildPopulationChips(medicine.populationTags ?? []),
        purposeChips: buildPurposeChips(medicine.purposeTags ?? []),
        leafletPurpose: medicine.leaflet.purposeSummary ?? "",
        leafletUsage: medicine.leaflet.packageUsageSummary ?? "",
        leafletContraindications: medicine.leaflet.contraindicationsSummary ?? "",
        leafletPrecautions: medicine.leaflet.precautionsSummary ?? "",
        leafletSource: medicine.leaflet.source ?? "",
        verified: medicine.leaflet.reviewStatus === "user_confirmed",
        batches: batchFromSummary(medicine).length > 0 ? batchFromSummary(medicine) : [emptyBatch()],
        openedStateIndex: 0,
        version: medicine.version,
      });
      this.captureInitialSnapshot();
      // ensureLoggedIn 固化了 userId/familyId：此刻重新定位草稿命名空间，
      // 冷启动时（storage 尚无身份）才能读到属于当前账号的草稿。
      this.refreshDraftScope();
    } catch (error) {
      if (stillCurrent()) showError(error);
    } finally {
      this.setData({ medicineLoading: false });
    }
  },

  navigationDraftGuard: null as DirtyDraft | null,

  captureInitialSnapshot(): void {
    this.initialDraftSnapshot = formFingerprint(this.data as MedicineEditPageData);
  },

  updateDirtyState(): void {
    const changed = this.initialDraftSnapshot !== formFingerprint(this.data as MedicineEditPageData);
    this.setData({ isDirty: changed });
    if (changed) {
      if (this.navigationDraftGuard === null) this.navigationDraftGuard = {
        label: "药品录入草稿",
        save: async () => {
          if (this.data.submitting || this.data.recognizing || this.data.medicineLoading) throw new Error("操作尚未完成");
          if (!this.persistCurrentDraft()) throw new Error("草稿保存失败");
          if (this.data.photoDrafts.length > 0 && !this.persistPhotoDrafts()) throw new Error("照片草稿保存失败");
        },
      };
      registerDirtyDraft(this.navigationDraftGuard);
    }
    this.setNativeLeaveWarning(changed);
    this.persistPhotoDrafts();
    this.refreshPhotoReview();
  },

  setNativeLeaveWarning(enabled: boolean): void {
    if (!enabled && this.navigationDraftGuard !== null) {
      clearDirtyDraft(this.navigationDraftGuard);
      this.navigationDraftGuard = null;
    }
    try {
      if (enabled) wx.enableAlertBeforeUnload({ message: NATIVE_LEAVE_WARNING });
      else wx.disableAlertBeforeUnload();
    } catch {
      // Older WeChat bases can lack this native prompt; the custom back button still offers all three choices.
    }
  },

  /** 身份就绪后重新定位草稿键并重读；绝不把上一个账号的草稿带过来。 */
  refreshDraftScope(): void {
    const key = draftStorageKey(this.data.medicineId as string);
    if (key === this.draftStorageKey) return;
    // 身份首次就绪可绑定；已打开的表单不得随换账号/家庭迁移到新归属。
    if (this.draftStorageKey !== null) {
      this.pendingStoredDraft = null;
      this.setData({ draftAvailable: false, draftForeign: false });
      return;
    }
    this.draftStorageKey = key;
    this.loadStoredDraft();
  },

  /** 只探测旧草稿的存在，绝不读取其内容——读即等于迁移到当前账号。 */
  hasLegacyDraft(): boolean {
    try {
      const raw = wx.getStorageSync(legacyDraftKey(this.data.medicineId as string));
      return raw !== undefined && raw !== null && raw !== "";
    } catch {
      return false;
    }
  },

  loadStoredDraft(): void {
    const key = this.draftStorageKey;
    if (key === null) {
      // 未固化身份（尚未完成登录）：不读写任何草稿，避免落到全局命名空间。
      this.pendingStoredDraft = null;
      this.setData({ draftAvailable: false, draftForeign: false });
      return;
    }
    try {
      const stored = wx.getStorageSync(key) as StoredMedicineDraft | undefined;
      if (stored === undefined || stored === null) {
        this.setData({ draftAvailable: false, draftForeign: this.hasLegacyDraft() });
        return;
      }
      const usable = stored.schemaVersion === MEDICINE_DRAFT_SCHEMA_VERSION &&
        stored.medicineId === (this.data.medicineId as string) &&
        typeof stored.fields?.name === "string" && Array.isArray(stored.fields.batches);
      if (!usable) {
        this.setData({ draftAvailable: false, draftForeign: this.hasLegacyDraft() });
        return;
      }
      if (!draftBelongsToCurrentSession(stored)) {
        // 归属不同（旧账号/其他家庭/旧版本无归属）：保留文件但绝不自动恢复。
        this.pendingStoredDraft = null;
        this.setData({ draftAvailable: false, draftForeign: true });
        return;
      }
      this.pendingStoredDraft = stored.fields;
      this.setData({ draftAvailable: true, draftForeign: false });
    } catch {
      this.pendingStoredDraft = null;
    }
  },

  persistCurrentDraft(updateBanner = true): boolean {
    const key = this.draftStorageKey;
    if (key === null || key !== draftStorageKey(this.data.medicineId as string)) {
      wx.showToast({ title: "登录身份尚未确认或已变化，草稿未保存", icon: "none" });
      return false;
    }
    try {
      const data = this.data as MedicineEditPageData;
      const fields = draftValues(data);
      const stored: StoredMedicineDraft = {
        schemaVersion: MEDICINE_DRAFT_SCHEMA_VERSION,
        medicineId: data.medicineId,
        savedAt: new Date().toISOString(),
        fields,
        ...currentOwnership(),
      };
      wx.setStorageSync(key, stored);
      this.pendingStoredDraft = fields;
      if (updateBanner) this.setData({ draftAvailable: true, draftForeign: false });
      return true;
    } catch {
      wx.showToast({ title: "本机草稿保存失败，请先复制或完成保存", icon: "none" });
      return false;
    }
  },

  removeStoredDraft(): void {
    this.pendingStoredDraft = null;
    const key = this.draftStorageKey;
    try { if (key !== null) wx.removeStorageSync(key); } catch { /* local draft cleanup is best effort */ }
    this.setData({ draftAvailable: false, draftForeign: false });
  },

  async onRestoreDraft(): Promise<void> {
    if (this.medicineLoadPromise !== null) await this.medicineLoadPromise;
    const originalScope = scopedStorageKey("medicine-photo-drafts");
    const originalSession = captureSessionIdentity();
    if (!this.entryScopeIsCurrent(originalScope)) return;
    const fields = this.pendingStoredDraft;
    if (fields === null) {
      this.photoDraftsImported = true;
      this.loadPhotoDrafts();
      return;
    }
    if (this.data.isDirty) {
      const confirmed = await new Promise<boolean>((resolve) => wx.showModal({
        title: "恢复本机草稿",
        content: "恢复旧草稿会覆盖当前表单内容。是否继续？",
        success: (result) => resolve(result.confirm), fail: () => resolve(false),
      }));
      if (!confirmed) return;
    }
    if (!this.entryScopeIsCurrent(originalScope) || !isCurrentSession(originalSession)) return;
    this.photoDraftsImported = true;
    this.loadPhotoDrafts();
    this.setData({
      ...fields,
      usePhotoAsCover: fields.usePhotoAsCover === true,
      brand: fields.brand ?? "",
      leafletText: fields.leafletText ?? "",
      batches: fields.batches.map((batch) => {
        const latest = this.data.batches.find((item) => item.id === batch.id && item.id !== null);
        return latest ? { ...batch, version: latest.version } : batch;
      }),
      // 旧版本草稿没有标签字段：归一为空数组，避免 undefined 写入。
      populationTags: fields.populationTags ?? [],
      purposeTags: fields.purposeTags ?? [],
      purposeTagsTouched: fields.purposeTagsTouched === true,
      manualEdits: fields.manualEdits ?? {},
      fieldSources: fields.fieldSources ?? {},
      batchSources: fields.batchSources ?? [],
      resolvedConflictPhotoIds: fields.resolvedConflictPhotoIds ?? {},
      populationChips: buildPopulationChips(fields.populationTags ?? []),
      purposeChips: buildPurposeChips(fields.purposeTags ?? []),
      draftAvailable: false,
      recognitionHint: "已恢复本机草稿，请核对后保存。",
      barcodeLookupStatus: fields.scannedBarcode === "" ? "" : "已保留上次扫描的商品码。",
      canRetryBarcode: fields.scannedBarcode !== "",
      candidate: null,
      candidates: [],
      candidateWarnings: [],
    });
    this.pendingStoredDraft = null;
    this.updateDirtyState();
  },

  onDiscardStoredDraft(): void {
    this.removeStoredDraft();
  },

  onRequestLeave(): void {
    if (this.leaveNavigationPending) return;
    if (this.data.scopeInvalidated) {
      this.setNativeLeaveWarning(false);
      this.navigateBackFromForm();
      return;
    }
    const data = this.data as MedicineEditPageData;
    if (data.submitting || data.recognizing || data.medicineLoading) {
      wx.showToast({ title: "请等待当前操作完成后再离开", icon: "none" });
      return;
    }
    if (data.isDirty) {
      this.setData({ leaveSheetVisible: true });
      return;
    }
    this.navigateBackFromForm();
  },

  onLeaveChoice(event: { currentTarget: { dataset: { choice?: string } } }): void {
    if (!this.data.leaveSheetVisible || this.leaveNavigationPending) return;
    const choice = event.currentTarget.dataset.choice;
    if (choice === "keep" && !this.persistCurrentDraft()) return;
    this.setData({ leaveSheetVisible: false });
    if (choice === "continue") return;
    if (choice === "discard") {
      this.discardingDraft = true;
      this.removeStoredDraft();
    }
    if (choice !== "keep" && choice !== "discard") return;
    this.setData({ isDirty: false });
    this.setNativeLeaveWarning(false);
    this.navigateBackFromForm();
  },

  navigateBackFromForm(): void {
    if (this.leaveNavigationPending) return;
    this.leaveNavigationPending = true;
    wx.navigateBack({ delta: 1, fail: () => wx.reLaunch({
      url: "/pages/index/index",
      fail: () => { this.leaveNavigationPending = false; },
    }) });
  },

  /** 标记字段被用户显式修改（含清空）：这是"我已决定这里的值"的唯一依据。 */
  markFieldTouched(fieldPath: string): void {
    this.touchedFields[fieldPath] = (this.touchedFields[fieldPath] ?? 0) + 1;
    const field = evidenceField(fieldPath);
    const batch = /^batches\[(\d+)\]\.(lotNumber|expiryValue)$/.exec(fieldPath);
    const ownerBatchKey = batch ? batchKey(this.data.batches[Number(batch[1])]) : "";
    const batchField = batch?.[2] === "expiryValue" ? "expiry" : "lotNumber";
    this.setData({
      manualEdits: { ...this.data.manualEdits, [this.manualEditKey(fieldPath)]: true },
      ...(batch && ownerBatchKey ? { batchSources: [...this.data.batchSources.filter(item => item.batchKey !== ownerBatchKey || item.field !== batchField),
        { batchKey: ownerBatchKey, field: batchField, source: "manual", photoIds: [], reviewed: true }] } :
        field ? { fieldSources: { ...this.data.fieldSources, [field]: { source: "manual", photoIds: [], reviewed: true } } } : {}),
    });
  },

  manualEditKey(fieldPath: string): string {
    const batchField = /^batches\[(\d+)\]\.(.+)$/.exec(fieldPath);
    if (!batchField) return fieldPath;
    const batch = this.data.batches[Number(batchField[1])];
    const identity = batch?.id ?? batch?.draftKey;
    return identity ? `batch:${identity}:${batchField[2]}` : fieldPath;
  },

  isManuallyEdited(fieldPath: string): boolean {
    return this.data.manualEdits?.[this.manualEditKey(fieldPath)] === true;
  },

  onFieldInput(event: { currentTarget: { dataset: { field?: string } }; detail: { value: string } }): void {
    if (this.data.attemptedPayload) return;
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.markFieldTouched(field);
    this.setData({ [field]: event.detail.value });
    this.updateDirtyState();
  },

  onVerifiedChange(event: { detail: { value: boolean } }): void {
    if (this.data.attemptedPayload) return;
    this.setData({ verified: event.detail.value });
    this.updateDirtyState();
  },

  onToggleOptional(): void {
    this.setData({ optionalExpanded: !(this.data as MedicineEditPageData).optionalExpanded });
  },

  onToggleConversion(): void {
    this.setData({ conversionExpanded: !(this.data as MedicineEditPageData).conversionExpanded });
  },

  onPurposeChange(event: { detail: { value: string | number } }): void {
    if (this.data.attemptedPayload) return;
    const purposeIndex = Number(event.detail.value);
    const selected = PURPOSE_OPTIONS[purposeIndex] ?? "未分类";
    this.markFieldTouched("purposeCategory");
    this.setData({ purposeIndex, purposeCategory: selected === "未分类" ? "" : selected });
    this.updateDirtyState();
  },

  /** 人群标签多选（B02）：再次点击取消选择。 */
  onTogglePopulationTag(event: { currentTarget: { dataset: { kind?: string } } }): void {
    if (this.data.attemptedPayload) return;
    const kind = event.currentTarget.dataset.kind;
    if (kind === undefined) return;
    const current = (this.data as MedicineEditPageData).populationTags;
    const next = current.includes(kind) ? current.filter((tag) => tag !== kind) : [...current, kind];
    this.markFieldTouched("populationTags");
    this.setData({ populationTags: next, populationChips: buildPopulationChips(next) });
    this.updateDirtyState();
  },

  /** 用途标签多选（B02）。 */
  onTogglePurposeTag(event: { currentTarget: { dataset: { kind?: string } } }): void {
    if (this.data.attemptedPayload) return;
    const kind = event.currentTarget.dataset.kind;
    if (kind === undefined) return;
    const current = (this.data as MedicineEditPageData).purposeTags;
    const next = current.includes(kind) ? current.filter((tag) => tag !== kind) : [...current, kind];
    this.markFieldTouched("purposeTags");
    this.setData({ purposeTags: next, purposeTagsTouched: true, purposeChips: buildPurposeChips(next) });
    this.updateDirtyState();
  },

  onOpenedStateChange(event: { currentTarget: { dataset: { index?: string } }; detail: { value: string | number } }): void {
    if (this.data.attemptedPayload) return;
    const index = Number(event.detail.value);
    const state = (["unknown", "unopened", "opened"] as const)[index] ?? "unknown";
    const batchIndex = Number(event.currentTarget.dataset.index ?? 0);
    this.setData({ [`batches[${batchIndex}].openedStateIndex`]: index, [`batches[${batchIndex}].openedState`]: state });
    if (state !== "opened") {
      this.setData({
        [`batches[${batchIndex}].openedAt`]: "",
        [`batches[${batchIndex}].openingLimitMode`]: "none",
        [`batches[${batchIndex}].openingLimitModeIndex`]: 0,
        [`batches[${batchIndex}].openingLimitValue`]: "",
      });
    }
    this.updateDirtyState();
  },

  onToggleOpeningInfo(event: { currentTarget: { dataset: { index?: string } } }): void {
    const index = Number(event.currentTarget.dataset.index ?? 0);
    const batch = (this.data as MedicineEditPageData).batches[index];
    if (!batch) return;
    this.setData({ [`batches[${index}].openingExpanded`]: !batch.openingExpanded });
  },

  onOpeningLimitModeChange(event: { currentTarget: { dataset: { index?: string } }; detail: { value: string | number } }): void {
    if (this.data.attemptedPayload) return;
    if (String(event.detail.value).trim() === "") return;
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || index < 0 || index > 3) return;
    const mode = (["none", "day", "month", "date"] as const)[index] ?? "none";
    const batchIndex = Number(event.currentTarget.dataset.index ?? 0);
    const current = (this.data as MedicineEditPageData).batches[batchIndex];
    if (!Number.isInteger(batchIndex) || !current) return;
    this.setData({
      [`batches[${batchIndex}].openingLimitModeIndex`]: index,
      [`batches[${batchIndex}].openingLimitMode`]: mode,
      ...(current.openingLimitMode !== mode || mode === "none"
        ? { [`batches[${batchIndex}].openingLimitValue`]: "" }
        : {}),
    });
    this.updateDirtyState();
  },

  async onScanCode(): Promise<void> {
    if (this.data.attemptedPayload) return;
    const data = this.data as MedicineEditPageData;
    if (data.recognizing || data.submitting) return;
    const originalScope = scopedStorageKey("medicine-photo-drafts");
    const token = ++this.recognitionToken;
    const operationCurrent = (): boolean => token === this.recognitionToken && this.entryScopeIsCurrent(originalScope);
    if (!operationCurrent()) return;
    if (this.medicineLoadPromise !== null) await this.medicineLoadPromise;
    if (!operationCurrent()) return;
    this.setData({ recognizing: true, recognitionSubject: "商品资料", recognitionSeconds: 0, canRetryBarcode: false, recognitionHint: "请扫描药盒商品码，查询结果仅作为候选。" });
    let scannedBarcode = "";
    try {
      const shareConsent = await new Promise<boolean>((resolve) => wx.showModal({
        title: "查询药品资料候选",
        content: "扫描读到的商品码会发送给家庭药箱资料服务；若启用联网资料库，会将码值发送给外部资料供应商查询候选。不上传药盒照片。是否继续？",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      }));
      if (!operationCurrent()) return;
      if (!shareConsent) {
        this.setData({ recognitionHint: "已取消扫码，未查询资料。" });
        return;
      }
      const result = await new Promise<{ result: string }>((resolve, reject) => {
        wx.scanCode({ onlyFromCamera: false, scanType: ["barCode"],
          success: (value) => resolve(value), fail: (error) => reject(error) });
      });
      if (!operationCurrent()) return;
      if (result.result.trim() === "") {
        this.setData({ barcodeLookupStatus: "没有读到条码，请重试或手动录入。", recognitionHint: "没有读到条码，请重试或手动录入。" });
        return;
      }
      scannedBarcode = result.result.trim();
      const parsed = parseMedicineBarcode(scannedBarcode);
      const barcodeValue = parsed.queryBarcode ?? scannedBarcode;
      this.setData({
        scannedBarcode,
        barcodeValue,
        canRetryBarcode: false,
        barcodeLookupStatus: parsed.statusText,
        recognitionHint: parsed.statusText,
      });
      this.updateDirtyState();
      if (parsed.queryBarcode === null) {
        this.setData({ barcodeLookupStatus: parsed.statusText, recognitionHint: parsed.statusText });
        return;
      }
      if (parsed.extractedLotNumber || parsed.extractedExpiry) {
        const currentBatches = [...(this.data as MedicineEditPageData).batches];
        if (currentBatches.length > 0) {
          const firstBatch = { ...currentBatches[0] };
          if (!firstBatch.lotNumber && parsed.extractedLotNumber) {
            firstBatch.lotNumber = parsed.extractedLotNumber;
          }
          if (!firstBatch.expiryValue && parsed.extractedExpiry) {
            firstBatch.expiryValue = parsed.extractedExpiry.value;
            firstBatch.precisionIndex = parsed.extractedExpiry.precision === "month" ? 1 : 0;
          }
          currentBatches[0] = firstBatch;
          this.setData({ batches: currentBatches });
        }
      }
      this.startRecognitionClock("商品资料");
      await ensureLoggedIn();
      if (!operationCurrent()) return;
      const response = await api.findMedicineCandidates(parsed.queryBarcode);
      if (!operationCurrent()) return;
      this.setData({
        candidates: response.candidates,
        candidate: response.candidates[0] ?? null,
        candidateWarnings: response.warnings,
        recognitionHint: response.candidates.length > 0
          ? "找到资料候选，请核对名称、规格和厂家；确认后才会填入表单。"
          : "暂未找到条码候选资料；商品码已保留，可拍药盒尝试生成待核对草稿，或手动录入。",
        barcodeLookupStatus: response.candidates.length > 0
          ? `已读取商品码 ${parsed.queryBarcode}，请核对候选。`
          : `商品码 ${parsed.queryBarcode} 已填入表单；可拍药盒尝试生成待核对草稿，或手动填写。`,
        canRetryBarcode: false,
      });
    } catch (error) {
      if (!operationCurrent()) return;
      if (!scannedBarcode) {
        const kind = nativeFailureKind(error);
        const message = kind === "cancel" ? "已取消扫码，未查询资料。"
          : kind === "permission" ? "扫码权限未允许，请在微信设置中检查相机或相册权限；本次未读取商品码。"
          : "扫码未读取到商品码，请重新扫描或手动录入。";
        this.setData({ barcodeLookupStatus: message, recognitionHint: message, canRetryBarcode: false });
        return;
      }
      const message = catalogLookupFailureMessage(error);
      this.setData({ barcodeLookupStatus: message, recognitionHint: message, canRetryBarcode: true });
      if (!(error instanceof ApiError && (error.code === "MEDICINE_CATALOG_UNAVAILABLE" || error.code === "MEDICINE_CATALOG_NOT_CONFIGURED"))) showError(error);
    } finally {
      if (operationCurrent()) {
        this.stopRecognitionClock();
        this.setData({ recognizing: false });
      }
    }
  },

  async onRetryBarcodeLookup(): Promise<void> {
    if (this.data.attemptedPayload) return;
    const data = this.data as MedicineEditPageData;
    if (data.recognizing || data.submitting || data.scannedBarcode.trim() === "") return;
    const parsed = parseMedicineBarcode(data.scannedBarcode);
    if (parsed.queryBarcode === null) {
      this.setData({ barcodeLookupStatus: parsed.statusText, recognitionHint: parsed.statusText, canRetryBarcode: false });
      return;
    }
    const originalScope = scopedStorageKey("medicine-photo-drafts");
    const token = ++this.recognitionToken;
    const operationCurrent = (): boolean => token === this.recognitionToken && this.entryScopeIsCurrent(originalScope);
    if (!operationCurrent()) return;
    this.setData({ recognizing: true, recognitionSubject: "商品资料", recognitionSeconds: 0 });
    const code = parsed.queryBarcode;
    const consent = await new Promise<boolean>((resolve) => wx.showModal({
      title: "重新查询商品码",
      content: `商品码 ${code} 将再次发送到家庭药箱资料服务；若启用联网资料库，会将码值发送给外部资料供应商查询候选。不上传照片。是否继续？`,
      success: (result) => resolve(result.confirm),
      fail: () => resolve(false),
    }));
    if (!operationCurrent()) return;
    if (!consent) {
      this.setData({ recognizing: false });
      return;
    }
    const codeToSearch = code;
    this.setData({ canRetryBarcode: false, barcodeLookupStatus: "正在查询候选资料…" });
    try {
      await ensureLoggedIn();
      if (!operationCurrent()) return;
      this.startRecognitionClock("商品资料");
      const response = await api.findMedicineCandidates(codeToSearch);
      if (!operationCurrent()) return;
      this.setData({
        candidates: response.candidates,
        candidate: response.candidates[0] ?? null,
        candidateWarnings: response.warnings,
        barcodeLookupStatus: response.candidates.length > 0
          ? `已读取商品码 ${code}，请核对候选。`
          : `未找到候选；商品码 ${code} 已保留。`,
        canRetryBarcode: false,
        recognitionHint: response.candidates.length > 0
          ? "找到资料候选，请核对名称、规格和厂家；确认后才会填入表单。"
          : "暂未找到条码候选资料；商品码已保留，可重试或手动录入。",
      });
    } catch (error) {
      if (!operationCurrent()) return;
      const message = catalogLookupFailureMessage(error);
      this.setData({ barcodeLookupStatus: message, recognitionHint: message, canRetryBarcode: true });
      if (!(error instanceof ApiError && (error.code === "MEDICINE_CATALOG_UNAVAILABLE" || error.code === "MEDICINE_CATALOG_NOT_CONFIGURED"))) showError(error);
    } finally {
      if (operationCurrent()) {
        this.stopRecognitionClock();
        this.setData({ recognizing: false });
      }
    }
  },

  /**
   * 规格文本暗示的批次单位（袋/支/粒等）：仅当用户没有改过单位、
   * 数量仍为空且当前是默认"盒"时预填；返回 null 表示不预填。
   */
  prefillBatchUnit(text: string | null | undefined, specWillFill: boolean): number | null {
    const unitIndex = unitIndexFromText(text);
    if (unitIndex === null || unitIndex === 4) return null;
    // 单位暗示来自候选规格：用户已写自己的规格时不预填，避免与用户规格不符。
    if (!specWillFill) return null;
    const first = (this.data as MedicineEditPageData).batches[0];
    if (!first) return null;
    if (first.quantity.trim() !== "" || first.unitIndex !== 4) return null;
    if (this.isManuallyEdited("batches[0].unitIndex")) return null;
    return unitIndex;
  },

  onApplyCandidate(event?: { currentTarget?: { dataset?: { index?: string } } }): void {
    if (this.data.attemptedPayload) return;
    const data = this.data as MedicineEditPageData;
    const index = Number(event?.currentTarget?.dataset?.index ?? 0);
    const candidate = data.candidates[index] ?? data.candidate;
    if (candidate === null) return;
    const fields: Record<string, unknown> = { candidate: null, candidates: [], candidateWarnings: [] };
    const canFill = (key: keyof MedicineEditPageData): boolean =>
      !this.isManuallyEdited(key) && typeof data[key] === "string" && (data[key] as string).trim() === "";
    if (canFill("name")) fields.name = candidate.name;
    if (canFill("brand") && candidate.brand) fields.brand = candidate.brand;
    if (canFill("specification") && candidate.specification !== null) fields.specification = candidate.specification;
    if (canFill("manufacturer") && candidate.manufacturer !== null) fields.manufacturer = candidate.manufacturer;
    if (canFill("approvalNumber") && candidate.approvalNumber !== null) fields.approvalNumber = candidate.approvalNumber;
    if (canFill("barcodeValue") && candidate.barcodeValue) fields.barcodeValue = candidate.barcodeValue;
    const specWillFill = canFill("specification") && candidate.specification !== null;
    const unitIndex = this.prefillBatchUnit(candidate.specification, specWillFill);
    if (unitIndex !== null) fields["batches[0].unitIndex"] = unitIndex;
    // 候选只填未编辑的空标签；明确全取消也是人工选择。外部资料仍须经过白名单。
    const candidatePurposeTags = Array.isArray(candidate.purposeTags)
      ? [...new Set(candidate.purposeTags.filter((tag) => PURPOSE_TAG_OPTIONS.some((option) => option.kind === tag)))].slice(0, 3)
      : [];
    if (candidatePurposeTags.length > 0 && data.purposeTags.length === 0 && !data.purposeTagsTouched) {
      fields.purposeTags = candidatePurposeTags;
      fields.purposeChips = buildPurposeChips(candidatePurposeTags);
      fields.classificationExpanded = true;
    }
    if (canFill("ingredients") && candidate.activeIngredients.length > 0) fields.ingredients = candidate.activeIngredients.join("、");
    if (candidate.leaflet !== null) {
      // 内容与来源必须同源：用户自己写过的说明书文字不能被改写成供应商来源。
      const hasOwnLeafletText = [
        data.leafletPurpose,
        data.leafletUsage,
        data.leafletContraindications,
        data.leafletPrecautions,
      ].some((text) => text.trim() !== "");
      const candidateHasLeafletText = [
        candidate.leaflet.purposeSummary,
        candidate.leaflet.packageUsageSummary,
        candidate.leaflet.contraindicationsSummary,
        candidate.leaflet.precautionsSummary,
      ].some((text) => (text ?? "").trim() !== "");
      const leafletFields = {
        leafletPurpose: candidate.leaflet.purposeSummary,
        leafletUsage: candidate.leaflet.packageUsageSummary,
        leafletContraindications: candidate.leaflet.contraindicationsSummary,
        leafletPrecautions: candidate.leaflet.precautionsSummary,
      };
      let filledLeaflet = false;
      for (const field of Object.keys(leafletFields) as Array<keyof typeof leafletFields>) {
        const value = leafletFields[field];
        if (canFill(field) && typeof value === "string" && value.trim() !== "") {
          fields[field] = value;
          filledLeaflet = true;
        }
      }
      if (filledLeaflet && !hasOwnLeafletText && candidateHasLeafletText && !this.isManuallyEdited("leafletSource")) {
        // 整段内容都来自候选项：来源随内容一起替换。
        fields.leafletSource = candidate.source;
      } else if (filledLeaflet && hasOwnLeafletText && candidateHasLeafletText) {
        // 混合内容：保留用户原来的来源，不把整段归因给供应商。
        wx.showToast({ title: "已补全说明书内容；来源保持为你原来的记录", icon: "none" });
      }
      if (filledLeaflet) {
        fields.verified = false;
        fields.optionalExpanded = true;
      }
    }
    const sources = snapshot(data.fieldSources ?? {});
    let sourceChanged = false;
    for (const [path, value] of Object.entries(fields)) {
      const field = evidenceField(path);
      if (!field || value === null || value === undefined || value === "" || Array.isArray(value) && value.length === 0) continue;
      sources[field] = { source: "catalog", photoIds: [], reviewed: false };
      sourceChanged = true;
    }
    if (sourceChanged) fields.fieldSources = sources;
    this.setData(fields);
    this.updateDirtyState();
    wx.showToast({ title: "候选已填入，请核对后保存", icon: "none" });
  },

  onDiscardCandidate(): void {
    this.setData({ candidate: null, candidates: [], candidateWarnings: [] });
  },

  noop(): void {
    // 阻止底部弹层内的点击穿透。
  },

  startRecognitionClock(subject: string): void {
    this.stopRecognitionClock();
    this.setData({ recognizing: true, recognitionSeconds: 0, recognitionSubject: subject });
    const tick = (): void => {
      if (!this.data.recognizing) return;
      this.setData({ recognitionSeconds: this.data.recognitionSeconds + 1 });
      this.recognitionTimer = setTimeout(tick, 1000);
    };
    this.recognitionTimer = setTimeout(tick, 1000);
  },

  stopRecognitionClock(): void {
    if (this.recognitionTimer !== null) clearTimeout(this.recognitionTimer);
    this.recognitionTimer = null;
  },

  onPreviewEntryPhoto(event: { currentTarget: { dataset: { id?: string } } }): void {
    if (!this.entryScopeIsCurrent(scopedStorageKey("medicine-photo-drafts"))) return;
    const entry = this.data.photoDrafts.find((item) => item.id === event.currentTarget.dataset.id);
    if (entry) {
      const photos = entry.photos.filter(photo => !photo.removed);
      if (photos.length > 0) wx.previewImage({ current: photos[0].path, urls: photos.map(photo => photo.path) });
    }
  },

  onChooseCaptureSource(): void {
    if (this.data.recognizing || this.data.submitting || this.data.attemptedPayload) return;
    const scope = scopedStorageKey("medicine-photo-drafts");
    const identity = captureSessionIdentity();
    if (!this.entryScopeIsCurrent(scope)) return;
    wx.showActionSheet({
      itemList: ["扫码查资料", "从相册选择药盒", "从相册选择说明书"],
      success: result => {
        if (!this.entryScopeIsCurrent(scope) || !isCurrentSession(identity) || this.data.recognizing || this.data.submitting) return;
        if (result.tapIndex === 0) void this.onScanCode();
        if (result.tapIndex === 1 || result.tapIndex === 2) {
          void this.onRecognizePhoto({ currentTarget: { dataset: { source: "album", purpose: result.tapIndex === 2 ? "leaflet" : "box_front" } } });
        }
      },
    });
  },

  refreshPhotoReview(): void {
    const current = this.data.photoDrafts.find(item => item.id === this.data.activePhotoDraftId);
    const draft = current ? snapshot(current) : null;
    if (draft) assignPhotoIdentities(draft);
    const photos = draft?.photos.filter(photo => !photo.removed).map(photo => ({ ...photo,
      batchKey: photoBatchKey(photo, draft, this.data.batches),
    })) ?? [];
    const items: PhotoReviewItem[] = photos.map(photo => ({
      clientPhotoId: photo.clientPhotoId!, sequence: photo.sequence!, numberLabel: `${this.data.isEdit ? "本次图" : "图"}${photo.sequence!}`, path: photo.path,
      kindLabel: photo.purpose === "leaflet" ? "说明书" : photo.purpose === "expiry" ? "有效期" : "药盒",
      statusLabel: photo.review?.status === "recognized" ? "待核对" : photo.review?.status === "failed" ? "识别失败" : photo.review?.status === "pending" ? "待识别" : "未记录识别内容",
      ...(photo.purpose === "expiry" ? { batchLabel: this.data.batches.findIndex(batch => batchKey(batch) === photo.batchKey) < 0
        ? "所属库存已移除，请移除此照片" : `库存 ${this.data.batches.findIndex(batch => batchKey(batch) === photo.batchKey) + 1}` } : {}),
      fields: Object.entries(photo.review?.fields ?? {}).flatMap(([key, value]) => {
        if (!Object.hasOwn(REVIEW_LABELS, key) || value === null || value === undefined || key === "expiryPrecision") return [];
        const field = key as ReviewField;
        return [{ field, label: REVIEW_LABELS[field], value: displayReviewValue(field, value) }];
      }),
    }));
    const selected = items.find(item => item.clientPhotoId === this.data.selectedReviewPhotoId) ?? items[0] ?? null;
    const conflicts = photoCandidates(photos).filter(item => {
      const path = reviewFormField(item.field, item.batchKey, this.data.batches);
      if (item.choices.length <= 1 || path === null) return false;
      if (!this.isManuallyEdited(path)) return true;
      const source = item.field === "expiryValue" || item.field === "lotNumber"
        ? this.data.batchSources.find(entry => entry.batchKey === item.batchKey && entry.field === (item.field === "expiryValue" ? "expiry" : "lotNumber"))
        : this.data.fieldSources[item.field];
      if (source?.source !== "recognized") return false;
      const seen = this.data.resolvedConflictPhotoIds[`${item.field}:${item.batchKey ?? ""}`] ?? [];
      return item.choices.some(choice => !choice.photoIds.some(id => source.photoIds.includes(id)) &&
        choice.photoIds.some(id => !seen.includes(id)));
    }).map(item => ({ ...item, choices: item.choices.map(choice => ({ ...choice, label: displayReviewValue(item.field, choice.value),
      sourceLabel: this.data.isEdit ? choice.sourceLabel.replace(/图/g, "本次图") : choice.sourceLabel })) }));
    const sourceLabels: Partial<Record<ReviewField, string>> = {};
    for (const [rawField, source] of Object.entries(this.data.fieldSources)) {
      if (!source || !Object.hasOwn(REVIEW_LABELS, rawField)) continue;
      const field = rawField as ReviewField;
      if (source.source === "recognized") {
        const numbers = source.photoIds.map(id => items.find(item => item.clientPhotoId === id)?.sequence).filter((number): number is number => number !== undefined);
        sourceLabels[field] = numbers.length ? `来自${numbers.map(number => `${this.data.isEdit ? "本次图" : "图"}${number}`).join("、")} · ${source.reviewed ? "已核对" : "待核对"}` : "来源图片未记录";
      } else if (source.source === "catalog") sourceLabels[field] = "来自资料库 · 待核对";
      else if (source.source === "removed") sourceLabels[field] = "来源图已移除";
    }
    const batchSourceLabels: Record<string, string> = {};
    for (const source of this.data.batchSources ?? []) {
      const index = this.data.batches.findIndex(batch => batchKey(batch) === source.batchKey);
      if (index < 0) continue;
      const numbers = source.photoIds.map(id => items.find(item => item.clientPhotoId === id)?.sequence).filter((number): number is number => number !== undefined);
      if (source.source === "recognized" && numbers.length) batchSourceLabels[`${index}.${source.field}`] =
        `来自${numbers.map(number => `${this.data.isEdit ? "本次图" : "图"}${number}`).join("、")} · ${source.reviewed ? "已核对" : "待核对"}`;
      else if (source.source === "removed") batchSourceLabels[`${index}.${source.field}`] = "来源图已移除";
    }
    this.setData({ photoReviewItems: items, selectedReviewPhotoId: selected?.clientPhotoId ?? "", selectedReviewPhoto: selected, reviewConflicts: conflicts, sourceLabels, batchSourceLabels });
  },

  onSelectReviewPhoto(event: { currentTarget: { dataset: { photoId?: string } } }): void {
    const selected = this.data.photoReviewItems.find(item => item.clientPhotoId === event.currentTarget.dataset.photoId);
    if (selected && this.entryScopeIsCurrent(scopedStorageKey("medicine-photo-drafts"))) {
      this.setData({ selectedReviewPhotoId: selected.clientPhotoId, selectedReviewPhoto: selected,
        photoReviewExpanded: selected.clientPhotoId !== this.data.selectedReviewPhotoId || !this.data.photoReviewExpanded });
    }
  },

  onPreviewReviewPhoto(): void {
    const selected = this.data.selectedReviewPhoto;
    if (selected && this.entryScopeIsCurrent(scopedStorageKey("medicine-photo-drafts"))) {
      wx.previewImage({ current: selected.path, urls: this.data.photoReviewItems.map(item => item.path) });
    }
  },

  onRemoveReviewPhoto(event: { currentTarget: { dataset: { photoId?: string } } }): void {
    if (this.data.attemptedPayload || this.data.recognizing || this.data.submitting) return;
    const scope = scopedStorageKey("medicine-photo-drafts");
    const identity = captureSessionIdentity();
    const draftId = this.data.activePhotoDraftId;
    const photoId = event.currentTarget.dataset.photoId;
    if (!draftId || !photoId || !this.entryScopeIsCurrent(scope)) return;
    wx.showModal({
      title: "移除此照片？",
      content: "照片将从本次录入中移除；本机原件在保存或删除草稿后清理。已确认的资料会保留。",
      success: result => {
        if (!result.confirm || !this.entryScopeIsCurrent(scope) || !isCurrentSession(identity) ||
            this.data.activePhotoDraftId !== draftId || this.data.recognizing || this.data.submitting) return;
        const queue = this.currentPhotoDraftQueue(draftId);
        const draft = queue?.find(item => item.id === draftId);
        if (!queue || !draft) return;
        assignPhotoIdentities(draft);
        const photo = draft.photos.find(item => item.clientPhotoId === photoId && !item.removed);
        if (!photo) return;
        if (photo.uploadedId) {
          wx.showToast({ title: "照片已上传，请在药品详情中移除", icon: "none", duration: 2800 });
          return;
        }
        if (photo.ownedLocal?.state === "reserved") {
          wx.showToast({ title: "照片尚未完整写入，请删除整份未完成草稿", icon: "none" });
          return;
        }
        const beforeFields = draftValues(this.data as MedicineEditPageData);
        const beforePhotos = snapshot(this.data.photoDrafts);
        photo.removed = true;
        const sources = snapshot(this.data.fieldSources);
        const batchSources = snapshot(this.data.batchSources ?? []);
        const updates: Record<string, unknown> = {};
        for (const [rawField, source] of Object.entries(sources)) {
          if (!source || source.source !== "recognized" || !source.photoIds.includes(photoId) || !Object.hasOwn(REVIEW_LABELS, rawField)) continue;
          const field = rawField as ReviewField;
          const remaining = source.photoIds.filter(id => id !== photoId);
          if (remaining.length > 0) { sources[field] = { ...source, photoIds: remaining }; continue; }
          const path = formField(field);
          if (source.reviewed || path && this.isManuallyEdited(path)) {
            sources[field] = { source: "removed", photoIds: [], reviewed: source.reviewed };
            continue;
          }
          delete sources[field];
          if (!path) continue;
          const oldValue = photo.review?.fields[field];
          const currentValue = path.startsWith("batches[0].")
            ? this.data.batches[0]?.[path.slice("batches[0].".length) as keyof BatchForm]
            : this.data[path as keyof MedicineEditPageData];
          const equal = Array.isArray(oldValue) && Array.isArray(currentValue)
            ? JSON.stringify([...oldValue].sort()) === JSON.stringify([...currentValue].sort())
            : typeof oldValue === "string" && typeof currentValue === "string" && oldValue.trim() === currentValue.trim();
          if (!equal) continue;
          updates[path] = Array.isArray(oldValue) ? [] : "";
          if (field === "purposeTags") updates.purposeChips = buildPurposeChips([]);
          if (field === "populationTags") updates.populationChips = buildPopulationChips([]);
          if (field === "expiryValue") updates["batches[0].precisionIndex"] = 2;
        }
        for (let i = batchSources.length - 1; i >= 0; i -= 1) {
          const source = batchSources[i];
          if (source.source !== "recognized" || !source.photoIds.includes(photoId)) continue;
          const remaining = source.photoIds.filter(id => id !== photoId);
          if (remaining.length) { batchSources[i] = { ...source, photoIds: remaining }; continue; }
          const field = source.field === "expiry" ? "expiryValue" : "lotNumber";
          const path = reviewFormField(field, source.batchKey, this.data.batches);
          if (source.reviewed || path && this.isManuallyEdited(path)) {
            batchSources[i] = { ...source, source: "removed", photoIds: [] };
            continue;
          }
          batchSources.splice(i, 1);
          const index = this.data.batches.findIndex(batch => batchKey(batch) === source.batchKey);
          const oldValue = photo.review?.fields[field];
          if (index >= 0 && path && typeof oldValue === "string" && this.data.batches[index][field].trim() === oldValue.trim()) {
            updates[path] = "";
            if (field === "expiryValue") updates[`batches[${index}].precisionIndex`] = 2;
          }
        }
        this.setData({ ...updates, fieldSources: sources, batchSources, photoDrafts: this.visiblePhotoDrafts(queue) });
        if (!this.persistPhotoDrafts()) {
          this.setData({ ...beforeFields, photoDrafts: beforePhotos,
            populationChips: buildPopulationChips(beforeFields.populationTags), purposeChips: buildPurposeChips(beforeFields.purposeTags) });
          this.refreshPhotoReview();
          return;
        }
        this.updateDirtyState();
      },
    });
  },

  onChooseReviewConflict(event: { currentTarget: { dataset: { field?: string; index?: string; batchKey?: string } } }): void {
    if (this.data.attemptedPayload || this.data.recognizing || this.data.submitting ||
        !this.entryScopeIsCurrent(scopedStorageKey("medicine-photo-drafts"))) return;
    const conflict = this.data.reviewConflicts.find(item => item.field === event.currentTarget.dataset.field &&
      (item.batchKey ?? "") === (event.currentTarget.dataset.batchKey ?? ""));
    const index = Number(event.currentTarget.dataset.index);
    const path = conflict ? reviewFormField(conflict.field, conflict.batchKey, this.data.batches) : null;
    if (!conflict || !path || !Number.isInteger(index) || index < -1 || index >= conflict.choices.length) return;
    this.applyReviewChoice(conflict.field, index < 0 ? null : conflict.choices[index], conflict.batchKey);
  },

  applyReviewChoice(field: ReviewField, choice: ReviewChoice | null, ownerBatchKey?: string): void {
    const path = reviewFormField(field, ownerBatchKey, this.data.batches);
    if (!path) return;
    if (field === "expiryValue" && choice && !["day", "month"].includes(choice.precision ?? "")) {
      wx.showToast({ title: "有效期精度不明确，请手动填写", icon: "none" });
      return;
    }
    const arrayField = field === "purposeTags" || field === "populationTags";
    const value = choice ? choice.value : arrayField ? [] : "";
    this.markFieldTouched(path);
    const activeDraft = this.data.photoDrafts.find(item => item.id === this.data.activePhotoDraftId);
    const candidates = activeDraft ? photoCandidates(activeDraft.photos.filter(photo => !photo.removed).map(photo => ({ ...photo,
      batchKey: photoBatchKey(photo, activeDraft, this.data.batches) }))) : [];
    const seen = candidates.find(item => item.field === field && (item.batchKey ?? "") === (ownerBatchKey ?? ""));
    const fields: Record<string, unknown> = { [path]: value };
    if (seen) fields.resolvedConflictPhotoIds = { ...this.data.resolvedConflictPhotoIds,
      [`${field}:${ownerBatchKey ?? ""}`]: seen.choices.flatMap(item => item.photoIds) };
    if (field === "activeIngredients" && Array.isArray(value)) fields[path] = value.join("、");
    if (field === "purposeTags" && Array.isArray(value)) {
      fields.purposeTagsTouched = true;
      fields.purposeChips = buildPurposeChips(value);
    }
    if (field === "populationTags" && Array.isArray(value)) fields.populationChips = buildPopulationChips(value);
    if (field === "expiryValue") fields[path.replace(/expiryValue$/, "precisionIndex")] = choice?.precision
      ? PRECISION_VALUES.indexOf(choice.precision as ExpiryPrecision) : 2;
    const source: FieldSource = choice
      ? { source: "recognized", photoIds: [...choice.photoIds], reviewed: true }
      : { source: "manual", photoIds: [], reviewed: true };
    if ((field === "expiryValue" || field === "lotNumber") && ownerBatchKey) {
      const batchField = field === "expiryValue" ? "expiry" : "lotNumber";
      fields.batchSources = [...this.data.batchSources.filter(item => item.batchKey !== ownerBatchKey || item.field !== batchField),
        { batchKey: ownerBatchKey, field: batchField, ...source }];
    } else fields.fieldSources = { ...this.data.fieldSources, [field]: source };
    this.setData(fields);
    this.updateDirtyState();
  },

  onUsePhotoField(event: { currentTarget: { dataset: { field?: string; photoId?: string } } }): void {
    if (this.data.attemptedPayload || this.data.recognizing || this.data.submitting) return;
    const scope = scopedStorageKey("medicine-photo-drafts");
    const identity = captureSessionIdentity();
    const field = event.currentTarget.dataset.field;
    const photoId = event.currentTarget.dataset.photoId;
    const active = this.data.photoDrafts.find(item => item.id === this.data.activePhotoDraftId);
    if (!active || !field || !Object.hasOwn(REVIEW_LABELS, field) || !photoId || !this.entryScopeIsCurrent(scope)) return;
    const draft = snapshot(active);
    assignPhotoIdentities(draft);
    const selectedPhoto = draft.photos.find(item => item.clientPhotoId === photoId && !item.removed);
    if (!selectedPhoto) return;
    const ownerBatchKey = photoBatchKey(selectedPhoto, draft, this.data.batches);
    const choiceBatchKey = field === "expiryValue" || field === "lotNumber" ? ownerBatchKey : undefined;
    const photos = draft.photos.filter(item => !item.removed).map(item => ({ ...item,
      batchKey: photoBatchKey(item, draft, this.data.batches) }));
    const candidate = photoCandidates(photos).find(item => item.field === field &&
      (field !== "expiryValue" && field !== "lotNumber" || item.batchKey === ownerBatchKey))?.choices.find(choice => choice.photoIds.includes(photoId));
    const path = reviewFormField(field as ReviewField, ownerBatchKey, this.data.batches);
    if (!candidate || !path) return;
    const apply = (): void => {
      if (this.entryScopeIsCurrent(scope) && isCurrentSession(identity) && this.data.activePhotoDraftId === active.id &&
          this.data.photoReviewItems.some(item => item.clientPhotoId === photoId)) this.applyReviewChoice(field as ReviewField, candidate, choiceBatchKey);
    };
    if (!this.isManuallyEdited(path)) { apply(); return; }
    wx.showModal({ title: "使用照片识别结果", content: "这会替换你手动修改的内容，是否继续？",
      success: result => { if (result.confirm) apply(); } });
  },

  async onRecognizePhoto(
    sourceOverride?:
      | "camera"
      | "album"
      | { currentTarget?: { dataset?: { source?: string; purpose?: string; batchIndex?: string | number } } },
  ): Promise<void> {
    const initialData = this.data as MedicineEditPageData;
    if (initialData.recognizing || initialData.submitting) return;
    const originalScope = scopedStorageKey("medicine-photo-drafts");
    if (!this.entryScopeIsCurrent(originalScope)) {
      wx.showToast({ title: "登录身份已变化，请重新打开录入页", icon: "none" });
      return;
    }
    // 发起前固化请求代次、字段版本快照与批次结构：晚到的响应只能填补
    // 用户从未触碰过的空字段，且批次结构未变时才按稳定身份写入。
    if (this.data.attemptedPayload) return;
    const dataset = typeof sourceOverride === "object" ? sourceOverride.currentTarget?.dataset : undefined;
    const purpose = dataset?.purpose === "leaflet" ? "leaflet" : dataset?.purpose === "expiry" ? "expiry" : "box_front";
    const requestedIndex = purpose === "expiry" ? Number(dataset?.batchIndex ?? 0) : 0;
    const ownerBatchKey = Number.isInteger(requestedIndex) && requestedIndex >= 0 ? batchKey(initialData.batches[requestedIndex]) : "";
    if (!ownerBatchKey) {
      wx.showToast({ title: "请先选择要关联的库存", icon: "none" });
      return;
    }
    if (!initialData.activePhotoDraftId && (this.photoDraftQueueForWrite()?.filter(item => item.status !== "saved" && item.status !== "cleanup_pending").length ?? 0) >= 10) {
      this.setData({ recognitionHint: PHOTO_DRAFT_LIMIT_HINT, draftAvailable: true });
      return;
    }
    const active = initialData.photoDrafts.find((item) => item.id === initialData.activePhotoDraftId);
    if (active?.photos.some((photo) => photo.ownedLocal?.state === "reserved")) {
      this.setData({ recognitionHint: "照片写入尚未完成，请先删除这份照片草稿再重拍；药品文字仍可手动保存。" });
      wx.showToast({ title: "请先处理未完成的照片草稿", icon: "none" });
      return;
    }
    if (initialData.activePhotoDraftId && !this.currentPhotoDraftQueue(initialData.activePhotoDraftId)) {
      this.setData({ recognitionHint: "本机照片草稿已变化，请重新打开页面核对。" });
      return;
    }
    const token = ++this.recognitionToken;
    const touchedSnapshot = { ...this.touchedFields };
    const batchShape = initialData.batches.map((batch) => batch.id ?? batch.draftKey ?? batch);
    this.setData({ recognizing: true });
    let photo: PhotoEntryDraft["photos"][number] | undefined;
    let registered = false;
    let operationDraftId = initialData.activePhotoDraftId;
    let existingDraftId = initialData.activePhotoDraftId;
    let photoStage: "selection" | "read" | "storage" | "recognition" = "selection";
    const operationCurrent = (): boolean => token === this.recognitionToken && this.entryScopeIsCurrent(originalScope) &&
      (!registered || this.currentPhotoDraftQueue(operationDraftId, photo?.path) !== null);
    try {
      if (this.medicineLoadPromise !== null) await this.medicineLoadPromise;
      if (!operationCurrent()) return;
      const eventSource = typeof sourceOverride === "object" ? sourceOverride.currentTarget?.dataset?.source : sourceOverride;
      const source = eventSource === "album" ? "album" : "camera";
      const selection = await wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: [source], sizeType: ["compressed"] });
      if (!operationCurrent()) return;
      const file = selection.tempFiles[0];
      if (!file) return;
      const unhandledDraft = this.data.photoDrafts.find((item) => item.status !== "saved" && item.status !== "cleanup_pending");
      if (!this.data.activePhotoDraftId && unhandledDraft) {
        if (unhandledDraft.status === "failed") {
          const queue = this.currentPhotoDraftQueue(unhandledDraft.id);
          const failed = queue?.find((item) => item.id === unhandledDraft.id);
          if (!failed || failed.photos.some((photo) => photo.ownedLocal?.state === "reserved")) {
            wx.showToast({ title: "请先恢复或删除未完成的照片草稿", icon: "none" });
            return;
          }
          existingDraftId = failed.id;
          operationDraftId = unhandledDraft.id;
          this.setData({ activePhotoDraftId: unhandledDraft.id });
        } else {
          wx.showToast({ title: "请先保存或恢复已有药品草稿", icon: "none" });
          return;
        }
      }
      let uploadPath = file.tempFilePath;
      let compressedPhoto = false;
      if (typeof wx.compressImage === "function") {
        try {
          const compressed = await new Promise<{ tempFilePath: string }>((resolve, reject) => {
            wx.compressImage({
              src: file.tempFilePath,
              quality: 80,
              compressedWidth: 1280,
              success: resolve,
              fail: reject,
            });
          });
          if (compressed && compressed.tempFilePath) {
            uploadPath = compressed.tempFilePath;
            compressedPhoto = true;
          }
        } catch {
          // Gracefully keep original file if compression fails or is mocked
        }
      }
      if (!compressedPhoto && file.size > 4 * 1024 * 1024) {
        wx.showToast({ title: "图片超过 4MB，请压缩后重试", icon: "none" });
        return;
      }
      if (!operationCurrent()) return;
      if (typeof wx.getFileInfo === "function") {
        let uploadSize: number;
        try {
          uploadSize = await new Promise<number>((resolve, reject) => wx.getFileInfo({
            filePath: uploadPath,
            success: (result) => resolve(result.size),
            fail: reject,
          }));
        } catch {
          wx.showToast({ title: "无法核对图片大小，请重拍或手动录入", icon: "none" });
          return;
        }
        if (!operationCurrent()) return;
        if (uploadSize > 4 * 1024 * 1024) {
          wx.showToast({ title: "图片超过 4MB，请压缩后重试", icon: "none" });
          return;
        }
      }
      photoStage = "read";
      const imageBase64 = await new Promise<string>((resolve, reject) => {
        wx.getFileSystemManager().readFile({
          filePath: uploadPath,
          encoding: "base64",
          success: (result) => resolve(result.data as string),
          fail: reject,
        });
      });
      if (!operationCurrent()) return;
      const padding = imageBase64.endsWith("==") ? 2 : imageBase64.endsWith("=") ? 1 : 0;
      if (Math.floor(imageBase64.length * 3 / 4) - padding > 4 * 1024 * 1024) {
        wx.showToast({ title: "图片超过 4MB，请压缩后重试", icon: "none" });
        return;
      }
      let mimeType: "image/jpeg" | "image/png";
      if (imageBase64.startsWith("/9j/")) mimeType = "image/jpeg";
      else if (imageBase64.startsWith("iVBORw0KGgo")) mimeType = "image/png";
      else {
        wx.showToast({ title: "请选择 JPEG 或 PNG 照片", icon: "none" });
        return;
      }
      this.startRecognitionClock(purpose === "leaflet" ? "说明书" : "药品包装");
      const id = existingDraftId || `photo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      operationDraftId = id;
      const fs = wx.getFileSystemManager();
      photoStage = "storage";
      let sdkVersion = "";
      try { sdkVersion = wx.getSystemInfoSync().SDKVersion; } catch { /* fail closed below */ }
      if (typeof wx.base64ToArrayBuffer !== "function") {
        throw new PhotoFileWriteError("PHOTO_STORAGE_UNAVAILABLE", "当前微信版本不支持安全保存照片草稿，请升级微信或手动录入。");
      }
      await writeOwnedPhotoFile({
        fs, sdkVersion, root: wx.env?.USER_DATA_PATH ?? "", scopeKey: this.photoScopeKey ?? originalScope!, draftId: id,
        purpose, mimeType, data: wx.base64ToArrayBuffer(imageBase64),
        isCurrent: operationCurrent,
        register: (owner) => {
          if (!operationCurrent()) return false;
          if (existingDraftId && this.data.activePhotoDraftId !== id) return false;
          const entries = existingDraftId
            ? this.currentPhotoDraftQueue(id) : this.photoDraftQueueForWrite();
          if (!entries) return false;
          let entry = entries.find((item) => item.id === id);
          if (entry && !existingDraftId) return false;
          if (!entry) {
            if (entries.filter((item) => item.status !== "saved" && item.status !== "cleanup_pending").length >= 10) {
              this.setData({ recognitionHint: PHOTO_DRAFT_LIMIT_HINT, draftAvailable: true });
              return false;
            }
            entry = { id, thumbnail: owner.path, status: "recognizing", fields: draftValues(this.data as MedicineEditPageData), medicineId: "", photos: [] };
            entries.push(entry);
          }
          assignPhotoIdentities(entry);
          const sequence = (entry.nextPhotoSequence ?? 0) + 1;
          entry.nextPhotoSequence = sequence;
          entry.failureCode = null;
          photo = { path: owner.path, mimeType, purpose, batchIndex: requestedIndex, batchKey: ownerBatchKey, ownedLocal: owner,
            clientPhotoId: `${id}-${sequence}`, sequence, review: { status: "pending", fields: {}, warnings: [] } };
          entry.photos.push(photo);
          entry.status = "recognizing";
          this.setData({ activePhotoDraftId: id });
          this.setData({ photoDrafts: this.visiblePhotoDrafts(entries), recognitionHint: "正在安全保存本机照片草稿…" });
          registered = this.persistPhotoDrafts();
          return registered;
        },
        markReady: (owner) => {
          if (!photo || !operationCurrent()) return false;
          const entries = this.currentPhotoDraftQueue(id, photo.path);
          const currentPhoto = entries?.find((item) => item.id === id)?.photos.find((item) => item.path === photo!.path);
          if (!entries || !currentPhoto) return false;
          const reserved = currentPhoto.ownedLocal;
          currentPhoto.ownedLocal = owner;
          photo = currentPhoto;
          this.setData({ photoDrafts: this.visiblePhotoDrafts(entries) });
          if (this.persistPhotoDrafts()) return true;
          currentPhoto.ownedLocal = reserved;
          return false;
        },
      });
      if (!operationCurrent()) return;
      this.setData({ recognitionHint: "正在识别药盒，请稍候…保存时照片会上传到家庭私有资料。" });
      photoStage = "recognition";
      await ensureLoggedIn();
      if (!operationCurrent()) return;
      const result = await api.recognizeMedicine(imageBase64, mimeType, purpose === "leaflet" ? "leaflet" : "box_front");
      // 过期响应（期间又发起过识别/已加载别的药品）直接丢弃。
      if (!operationCurrent()) return;
      const draft = result.draft;
      const recognizedFields = recognitionFields(draft, POPULATION_TAG_OPTIONS.map(item => item.kind), PURPOSE_TAG_OPTIONS.map(item => item.kind));
      const current = this.data as MedicineEditPageData;
      const targetIndex = current.batches.findIndex(batch => batchKey(batch) === ownerBatchKey);
      const first = current.batches[0];
      const target = targetIndex >= 0 ? current.batches[targetIndex] : undefined;
      // 只有用户自上次快照以来没有改过这个字段，才允许识别结果填入。
      const untouched = (fieldPath: string): boolean =>
        !this.isManuallyEdited(fieldPath) &&
        (this.touchedFields[fieldPath] ?? 0) === (touchedSnapshot[fieldPath] ?? 0);
      const fields: Record<string, unknown> = {
        recognitionHint: result.warnings.length > 0
          ? `识别完成，请逐项核对。${result.warnings.join("；")}`
          : "识别完成，请对照包装核对后保存。有效期在另一面时可再拍一次。",
      };
      const recognitionSpecWillFill = untouched("specification") && current.specification.trim() === "" &&
        typeof draft.specification === "string" && draft.specification !== "";
      const recognitionUnitIndex = recognitionSpecWillFill
        ? unitIndexFromText(draft.specification) : null;
      for (const key of ["name", "brand", "specification", "manufacturer", "approvalNumber", "purposeCategory"] as const) {
        if (untouched(key) && current[key].trim() === "" && typeof draft[key] === "string" && draft[key] !== "") {
          fields[key] = draft[key];
          if (key === "purposeCategory") {
            const optionIndex = PURPOSE_OPTIONS.indexOf(draft[key]);
            if (optionIndex >= 0) fields.purposeIndex = optionIndex;
          }
        }
      }
      if (recognitionUnitIndex !== null && untouched("batches[0].unitIndex") &&
        first && first.quantity.trim() === "" && first.unitIndex === 4) {
        fields["batches[0].unitIndex"] = recognitionUnitIndex;
      }
      if (untouched("purposeTags") && !current.purposeTagsTouched && current.purposeTags.length === 0 && Array.isArray(recognizedFields.purposeTags)) {
        fields.purposeTags = recognizedFields.purposeTags;
        fields.purposeChips = buildPurposeChips(recognizedFields.purposeTags);
        fields.classificationExpanded = true;
      }
      if (untouched("populationTags") && current.populationTags.length === 0 && Array.isArray(recognizedFields.populationTags)) {
        fields.populationTags = recognizedFields.populationTags;
        fields.populationChips = buildPopulationChips(recognizedFields.populationTags);
      }
      if (purpose === "leaflet" && draft.leaflet) {
        if (untouched("leafletText") && current.leafletText.trim() === "") fields.leafletText = draft.leaflet.text ?? "";
        const mapping = { leafletPurpose: "purposeSummary", leafletUsage: "packageUsageSummary", leafletContraindications: "contraindicationsSummary", leafletPrecautions: "precautionsSummary" } as const;
        for (const field of Object.keys(mapping) as Array<keyof typeof mapping>) {
          const value = draft.leaflet[mapping[field]];
          if (untouched(field) && current[field].trim() === "" && value) fields[field] = value;
        }
        if (untouched("leafletSource") && !current.leafletSource.trim()) fields.leafletSource = "包装内说明书照片（待核对）";
        fields.optionalExpanded = true;
        fields.verified = false;
      }
      // 批次结构必须与发起时一致（数量与稳定 id 逐一匹配），否则宁可跳过，
      // 也不能把晚到的识别结果写进被删除/新增后的另一个批次。
      const shapeUnchanged = current.batches.length === batchShape.length &&
        current.batches.every((batch, index) => (batch.id ?? batch.draftKey ?? batch) === batchShape[index]);
      if (target && shapeUnchanged) {
        const lotPath = `batches[${targetIndex}].lotNumber`;
        const expiryPath = `batches[${targetIndex}].expiryValue`;
        if (untouched(lotPath) && target.lotNumber.trim() === "" && draft.lotNumber) {
          fields[lotPath] = draft.lotNumber;
        }
        if (untouched(expiryPath) &&
          (target.precisionIndex === 2 || target.expiryValue.trim() === "") &&
          draft.expiryValue && (draft.expiryPrecision === "day" || draft.expiryPrecision === "month")) {
          fields[expiryPath] = draft.expiryValue;
          fields[`batches[${targetIndex}].precisionIndex`] = PRECISION_VALUES.indexOf(draft.expiryPrecision);
        }
      }
      const latest = this.currentPhotoDraftQueue(id, photo?.path);
      if (!latest) return;
      const recognizedDraft = latest.find((entry) => entry.id === id);
      const recognizedPhoto = recognizedDraft?.photos.find(item => item.path === photo?.path);
      if (!recognizedDraft || !recognizedPhoto?.clientPhotoId) return;
      recognizedPhoto.review = { status: "recognized", fields: recognizedFields,
        warnings: result.warnings.filter((warning): warning is string => typeof warning === "string") };
      const candidates = photoCandidates(recognizedDraft.photos);
      const sources = snapshot(current.fieldSources ?? {});
      const batchSources = snapshot(current.batchSources ?? []);
      for (const rawField of Object.keys(recognizedFields)) {
        const field = rawField as ReviewField;
        if (field === "leafletText" || field === "rawOcrText") continue;
        const path = reviewFormField(field, ownerBatchKey, current.batches);
        if (!path) continue;
        if (field === "expiryValue" || field === "lotNumber") {
          const batchField: LocalBatchSource["field"] = field === "expiryValue" ? "expiry" : "lotNumber";
          const existingIndex = batchSources.findIndex(item => item.batchKey === ownerBatchKey && item.field === batchField);
          const existing = batchSources[existingIndex];
          const sameChoice = candidates.find(item => item.field === field && item.batchKey === ownerBatchKey)?.choices.find(choice =>
            choice.photoIds.includes(recognizedPhoto.clientPhotoId!) && existing?.photoIds.some(id => choice.photoIds.includes(id)));
          const next = Object.hasOwn(fields, path) ? { batchKey: ownerBatchKey, field: batchField, source: "recognized" as const,
            photoIds: [recognizedPhoto.clientPhotoId], reviewed: false } : existing?.source === "recognized" && sameChoice && !this.isManuallyEdited(path)
            ? { ...existing, photoIds: [...new Set([...existing.photoIds, ...sameChoice.photoIds])] } : null;
          if (next) { if (existingIndex < 0) batchSources.push(next); else batchSources[existingIndex] = next; }
          continue;
        }
        if (Object.hasOwn(fields, path)) {
          sources[field] = { source: "recognized", photoIds: [recognizedPhoto.clientPhotoId], reviewed: false };
        } else {
          const existing = sources[field];
          const sameChoice = candidates.find(item => item.field === field)?.choices.find(choice =>
            choice.photoIds.includes(recognizedPhoto.clientPhotoId!) && existing?.photoIds.some(id => choice.photoIds.includes(id)));
          if (existing?.source === "recognized" && sameChoice && !this.isManuallyEdited(path)) {
            sources[field] = { ...existing, photoIds: [...new Set([...existing.photoIds, ...sameChoice.photoIds])] };
          }
        }
      }
      fields.fieldSources = sources;
      fields.batchSources = batchSources;
      if (recognizedDraft && photo?.purpose === "box_front" && photo.ownedLocal?.state === "ready") {
        recognizedDraft.thumbnail = photo.path;
      }
      this.setData({ photoDrafts: this.visiblePhotoDrafts(latest) });
      this.setData(fields);
      this.setPhotoDraftStatus("review");
      this.updateDirtyState();
    } catch (error) {
      if (!operationCurrent()) return;
      if (nativeFailureKind(error) === "cancel") {
        this.setData({ recognitionHint: "已取消照片选择，未发送识别请求。" });
        return;
      }
      if (photoStage === "selection" || photoStage === "read") {
        const message = nativeFailureKind(error) === "permission" ? "照片访问权限未允许，请在微信设置中检查相机或相册权限后重试。"
          : photoStage === "read" ? "照片读取失败，请重新选择或重拍；尚未发送识别请求。"
          : "无法打开相机或相册，请稍后重试或手动录入。";
        this.setData({ recognitionHint: message });
        return;
      }
      if (registered) {
        const latest = this.currentPhotoDraftQueue(operationDraftId, photo?.path);
        if (!latest) return;
        const failedPhoto = latest.find(item => item.id === operationDraftId)?.photos.find(item => item.path === photo?.path);
        if (failedPhoto) failedPhoto.review = { status: "failed", fields: {}, warnings: [] };
        this.setData({ photoDrafts: this.visiblePhotoDrafts(latest) });
        const failureCode = error instanceof PhotoFileWriteError ? "local_storage"
          : error instanceof ApiError && error.code === "NETWORK_ERROR" ? "network"
          : error instanceof ApiError && error.code === "RECOGNITION_UNAVAILABLE" ? "recognition_service" : "unknown";
        this.setPhotoDraftStatus("failed", failureCode);
      } else if (photo) {
        // Registration did not acknowledge: show a local failure without replaying an old queue.
        this.setData({ photoDrafts: this.data.photoDrafts.map((item) => item.id === operationDraftId ? { ...item, status: "failed" as const } : item) });
      }
      if (error instanceof PhotoFileWriteError) {
        const incomplete = this.data.photoDrafts.find((entry) => entry.id === this.data.activePhotoDraftId)
          ?.photos.some((photo) => photo.ownedLocal?.state === "reserved");
        this.setData({ recognitionHint: error.message + (incomplete ? " 请删除这份未完成的照片草稿后重拍；药品文字仍可手动保存。" : "") });
        wx.showToast({ title: "照片草稿未完成，请查看页面提示", icon: "none" });
        return;
      }
      const code = error instanceof ApiError ? error.code : "";
      if (code === "NETWORK_ERROR") {
        this.setData({ recognitionHint: "网络连接失败；照片草稿已保留，请检查网络后重试。" });
      } else if (["UNAUTHORIZED", "UNAUTHENTICATED", "SESSION_EXPIRED"].includes(code)) {
        this.setData({ recognitionHint: "登录已失效，请重新登录；照片草稿仍保留。" });
      } else if (code === "RECOGNITION_UNAVAILABLE") {
        // The API already maps model/context/timeout failures to safe, actionable
        // messages. Do not erase that category into a generic unavailable toast.
        const detail = error instanceof ApiError ? error.message.slice(0, 180) : "";
        this.setData({ recognitionHint: detail || "拍照识别暂不可用，可重新拍照或先手动录入。" });
      } else if (code !== "") {
        this.setData({ recognitionHint: `识别失败：${error instanceof ApiError ? error.message : "请重试或手动录入"}` });
        showError(error);
      } else {
        this.setData({ recognitionHint: "未识别图片；可重新拍照，或直接填写药名。" });
      }
    } finally {
      if (!this.entryDisposed && token === this.recognitionToken) {
        this.stopRecognitionClock();
        this.setData({ recognizing: false });
      }
    }
  },

  onBatchFieldInput(event: {
    currentTarget: { dataset: { index?: string; field?: string } };
    detail: { value: string };
  }): void {
    if (this.data.attemptedPayload) return;
    const index = event.currentTarget.dataset.index;
    const field = event.currentTarget.dataset.field;
    if (index === undefined || field === undefined || field === "") return;
    this.markFieldTouched(`batches[${index}].${field}`);
    this.setData({ [`batches[${index}].${field}`]: event.detail.value });
    this.updateDirtyState();
  },

  onExpiryDateChange(event: { currentTarget: { dataset: { index?: string } }; detail: { value: string; precision?: ExpiryPrecision } }): void {
    if (this.data.attemptedPayload) return;
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !this.data.batches[index]) return;
    const precision = event.detail.precision ? PRECISION_VALUES.indexOf(event.detail.precision) : this.data.batches[index]?.precisionIndex;
    if (precision === undefined || precision < 0) return;
    this.setData({ [`batches[${index}].expiryValue`]: expiryValueForPrecision(event.detail.value, PRECISION_VALUES[precision]),
      ...(event.detail.precision ? { [`batches[${index}].precisionIndex`]: precision } : {}) });
    this.markFieldTouched(`batches[${index}].expiryValue`);
    this.updateDirtyState();
  },

  onBatchPrecisionChange(event: { currentTarget: { dataset: { index?: string } }; detail: { value: string | number } }): void {
    if (this.data.attemptedPayload) return;
    const index = event.currentTarget.dataset.index;
    if (index === undefined || !Number.isInteger(Number(index)) || !this.data.batches[Number(index)]) return;
    if (String(event.detail.value).trim() === "") return;
    const precisionIndex = Number(event.detail.value);
    if (!Number.isInteger(precisionIndex) || !PRECISION_VALUES[precisionIndex]) return;
    // 精度改变意味着有效期语义由用户重新指定，识别不得再改写该批次日期。
    this.markFieldTouched(`batches[${index}].expiryValue`);
    const value = this.data.batches[Number(index)]?.expiryValue ?? "";
    this.setData({ [`batches[${index}].precisionIndex`]: precisionIndex,
      [`batches[${index}].expiryValue`]: expiryValueForPrecision(value, PRECISION_VALUES[precisionIndex]) });
    this.updateDirtyState();
  },

  onConversionUnitChange(event: { currentTarget: { dataset: { index?: string } }; detail: { value: string | number } }): void {
    if (this.data.attemptedPayload) return;
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ [`batches[${index}].conversionUnitIndex`]: Number(event.detail.value) });
    this.updateDirtyState();
  },
  onBatchUnitChange(event: { currentTarget: { dataset: { index?: string } }; detail: { value: string | number } }): void {
    if (this.data.attemptedPayload) return;
    const index = event.currentTarget.dataset.index;
    if (index === undefined) return;
    const batch = (this.data as MedicineEditPageData).batches[Number(index)];
    if (!batch) return;
    const nextIndex = Number(event.detail.value);
    const nextUnit = UNIT_VALUES[nextIndex];
    const currentUnit = UNIT_VALUES[batch.unitIndex];
    if (nextUnit === undefined || nextUnit === currentUnit) return;
    // 单位切换守卫（与 batch-edit 一致）：数字不换算，由用户确认后生效。
    const hasValue = batch.quantity.trim() !== "" || batch.confirmedUnits.trim() !== "";
    if (!hasValue) {
      this.markFieldTouched(`batches[${index}].unitIndex`);
      this.setData({ [`batches[${index}].unitIndex`]: nextIndex });
      this.updateDirtyState();
      return;
    }
    wx.showModal({
      title: "切换单位",
      content: "单位不会自动换算已填的数字。例如把 2 片改成 2 盒，保存后仍是 2。请核对后再保存。",
      confirmText: "仍要切换",
      cancelText: "保持原单位",
      success: (result) => {
        if (result.confirm) {
          this.markFieldTouched(`batches[${index}].unitIndex`);
          this.setData({ [`batches[${index}].unitIndex`]: nextIndex });
          this.updateDirtyState();
        }
      },
    });
  },

  onBatchUnknownChange(event: { currentTarget: { dataset: { index?: string } }; detail: { value: boolean } }): void {
    if (this.data.attemptedPayload) return;
    const index = event.currentTarget.dataset.index;
    if (index === undefined) return;
    this.setData({ [`batches[${index}].quantityUnknown`]: event.detail.value });
    this.updateDirtyState();
  },

  onAddBatch(): void {
    if (this.data.attemptedPayload) return;
    const batches = (this.data as MedicineEditPageData).batches;
    this.setData({ batches: [...batches, emptyBatch()] });
    this.updateDirtyState();
  },

  onRemoveBatch(event: { currentTarget: { dataset: { index?: string } } }): void {
    if (this.data.attemptedPayload) return;
    const index = event.currentTarget.dataset.index;
    if (index === undefined) return;
    const batches = (this.data as MedicineEditPageData).batches;
    const activeId = this.data.activePhotoDraftId;
    if (activeId) {
      const queue = this.currentPhotoDraftQueue(activeId);
      const draft = queue?.find(item => item.id === activeId);
      if (!queue || !draft) return;
      for (const photo of draft.photos) {
        if (!photo.batchKey) photo.batchKey = photoBatchKey(photo, draft, batches);
      }
      this.setData({ photoDrafts: this.visiblePhotoDrafts(queue) });
      if (!this.persistPhotoDrafts()) return;
    }
    const next = batches.filter((_, position) => position !== Number(index));
    this.setData({ batches: next.length > 0 ? next : [emptyBatch()] });
    this.updateDirtyState();
  },

  /** An open form keeps its original household; async work must not adopt a later login. */
  entryScopeIsCurrent(scope: string | null): boolean {
    const familyScope = scopedStorageKey("medicine-photo-drafts");
    const photoScope = this.data.medicineId
      ? scopedStorageKey("medicine-photo-drafts", this.data.medicineId) : familyScope;
    return !this.entryDisposed && !this.data.scopeInvalidated && (!this.entryIdentity || isCurrentSession(this.entryIdentity)) &&
      scope !== null && (scope === familyScope || scope === photoScope) &&
      (this.photoScopeKey === null || this.photoScopeKey === photoScope) &&
      (this.draftStorageKey === null || this.draftStorageKey === draftStorageKey(this.data.medicineId));
  },

  async checkEntrySession(): Promise<void> {
    const originalScope = scopedStorageKey("medicine-photo-drafts");
    const originalMedicineId = this.data.medicineId;
    try {
      await ensureLoggedIn({ allowInteractive: false });
      if (this.entryDisposed || this.data.scopeInvalidated) return;
      this.refreshDraftScope();
      if (!this.entryIdentity && readSessionScope()) this.entryIdentity = captureSessionIdentity();
      this.loadPhotoDrafts();
    } catch (error) {
      if (this.entryDisposed || this.data.medicineId !== originalMedicineId) return;
      if (error instanceof ApiError && error.invalidatedSession !== undefined &&
          !isCurrentSession(error.invalidatedSession)) return;
      const currentScope = scopedStorageKey("medicine-photo-drafts");
      // Only this request's verified 401 cleanup may clear scope and still redirect.
      const ownInvalidation = currentScope === null && error instanceof ApiError &&
        error.invalidatedSession !== undefined && isCurrentSession(error.invalidatedSession);
      if (error instanceof ApiError && error.code === "STALE_SESSION") return;
      if (!ownInvalidation && (currentScope !== originalScope ||
          (originalScope !== null && !this.entryScopeIsCurrent(originalScope)))) return;
      if (error instanceof ApiError &&
          (error.statusCode === 401 || error.code === "UNAUTHENTICATED" ||
           error.code === "UNAUTHORIZED" || error.code === "SESSION_EXPIRED")) {
        wx.redirectTo({ url: `/pages/login/login?redirect=${encodeURIComponent("/pages/medicine-edit/medicine-edit" + (this.data.medicineId ? `?id=${this.data.medicineId}` : ""))}` });
        return;
      }
      showError(error);
    }
  },
  onCoverChoice(event: { detail: { value: boolean } }): void {
    if (this.data.attemptedPayload) return;
    this.setData({ usePhotoAsCover: event.detail.value === true });
    this.updateDirtyState();
  },
  loadPhotoDrafts(): void {
    if (this.entryDisposed || this.data.scopeInvalidated) return;
    const key = this.data.medicineId ? scopedStorageKey("medicine-photo-drafts", this.data.medicineId) : scopedStorageKey("medicine-photo-drafts");
    if (!key) return;
    if (this.isolateNewEntry && this.photoScopeKey !== null && this.photoScopeKey !== key) return;
    if (this.photoScopeKey === key && (this.data.recognizing || this.data.submitting)) return;
    if (this.photoScopeKey !== key) this.setData({ photoDrafts: [], activePhotoDraftId: "" });
    this.photoScopeKey = key;
    try {
      const drafts = wx.getStorageSync(key) as PhotoEntryDraft[] | undefined;
      if (!Array.isArray(drafts)) return;
      if (this.isolateNewEntry && !this.photoDraftsImported && drafts.some(draft => draft.status !== "saved" && draft.status !== "cleanup_pending")) {
        this.setData({ draftAvailable: true });
      }
      const recovered = drafts.map((draft) => {
        const failureCode = ["local_read", "local_storage", "network", "recognition_service", "unknown"].includes(draft.failureCode ?? "")
          ? draft.failureCode : null;
        return draft.status === "recognizing" && draft.photos?.some((photo) => photo.ownedLocal?.state === "reserved")
          ? { ...draft, status: "failed" as const, failureCode: "local_storage" as const } : { ...draft, failureCode };
      });
      this.applyPhotoDraftQueue(recovered);
      if (!this.isolateNewEntry || this.photoDraftsImported) void this.cleanupPhotoDrafts();
      this.photoDraftStorageWarningShown = false;
    } catch {
      if (!this.photoDraftStorageWarningShown) {
        this.photoDraftStorageWarningShown = true;
        wx.showToast({ title: "本机照片草稿读取失败，请重新拍照或直接填写", icon: "none" });
      }
    }
  },
  photoDraftQueueForWrite(): PhotoEntryDraft[] | null {
    const key = this.photoScopeKey;
    if (!key || !this.entryScopeIsCurrent(key)) return null;
    try {
      const stored = wx.getStorageSync(key) as unknown;
      if (stored === undefined || stored === null || stored === "") return [];
      if (!Array.isArray(stored) || stored.some((item) => !item || typeof item.id !== "string" ||
          !Array.isArray(item.photos) || typeof item.fields !== "object" || !item.fields)) return null;
      // Own the snapshot: do not mutate a platform/test storage cache before setStorageSync acknowledges.
      return JSON.parse(JSON.stringify(stored)) as PhotoEntryDraft[];
    } catch { return null; }
  },

  currentPhotoDraftQueue(id: string, path?: string): PhotoEntryDraft[] | null {
    const queue = this.photoDraftQueueForWrite();
    if (!queue) return null;
    const draft = queue.find((item) => item.id === id);
    if (!draft || draft.status === "cleanup_pending" || draft.status === "saved") return null;
    try {
      // Preserve later edits from another page too, rather than replaying this page's stale fields.
      if (formFingerprint({ ...this.data, ...draft.fields } as MedicineEditPageData) !== formFingerprint(this.data as MedicineEditPageData)) return null;
    } catch { return null; }
    if (path && !draft.photos.some((photo) => photo.path === path && photo.ownedLocal?.path === path &&
        photo.ownedLocal?.scopeKey === this.photoScopeKey && photo.ownedLocal?.draftId === id)) return null;
    return queue;
  },

  /** Refresh queue and visible form together; keep the form's acknowledgement separate. */
  visiblePhotoDrafts(drafts: PhotoEntryDraft[]): PhotoEntryDraft[] {
    if (!this.isolateNewEntry || this.photoDraftsImported) return drafts;
    const ids = new Set(this.data.photoDrafts.map(draft => draft.id));
    if (this.data.activePhotoDraftId) ids.add(this.data.activePhotoDraftId);
    return drafts.filter(draft => ids.has(draft.id));
  },

  applyPhotoDraftQueue(drafts: PhotoEntryDraft[]): void {
    drafts = this.visiblePhotoDrafts(drafts);
    const id = this.data.activePhotoDraftId;
    const old = this.data.photoDrafts.find((item) => item.id === id);
    const active = drafts.find((item) => item.id === id && item.status !== "saved" && item.status !== "cleanup_pending");
    const baseline = this.photoFormBaseline?.id === id ? this.photoFormBaseline.fields : old?.fields;
    const fields = active && baseline
      ? rebasePhotoValue(draftValues(this.data as MedicineEditPageData), baseline, active.fields) as MedicineDraftValues
      : active?.fields;
    // Keep top-level entry references held by an in-flight save, but never reuse its stale fields.
    const entries = drafts.map((draft) => {
      const existing = this.data.photoDrafts.find((item) => item.id === draft.id);
      return existing ? Object.assign(existing, snapshot(draft)) : snapshot(draft);
    });
    this.photoQueueBaseline = snapshot(drafts);
    this.photoFormBaseline = active ? { id: active.id, fields: snapshot(active.fields) } : null;
    this.setData({ photoDrafts: entries,
      ...(fields ? { ...fields, usePhotoAsCover: fields.usePhotoAsCover === true, manualEdits: fields.manualEdits ?? {}, purposeTagsTouched: fields.purposeTagsTouched === true, populationChips: buildPopulationChips(fields.populationTags ?? []),
        fieldSources: fields.fieldSources ?? {}, batchSources: fields.batchSources ?? [], resolvedConflictPhotoIds: fields.resolvedConflictPhotoIds ?? {}, purposeChips: buildPurposeChips(fields.purposeTags ?? []) } : {}),
      ...(!active ? { activePhotoDraftId: "" } : {}),
    });
    this.refreshPhotoReview();
  },
  persistPhotoDrafts(): boolean {
    const latest = this.photoDraftQueueForWrite();
    if (!latest) return false;
    try {
      for (const draft of this.data.photoDrafts) {
        const local = snapshot(draft);
        const prior = this.photoQueueBaseline?.find((item) => item.id === draft.id);
        const baseline = snapshot(prior ?? draft);
        if (draft.id === this.data.activePhotoDraftId) {
          local.fields = draftValues(this.data as MedicineEditPageData);
          baseline.fields = snapshot(this.photoFormBaseline?.id === draft.id ? this.photoFormBaseline.fields : draft.fields);
        }
        const index = latest.findIndex((item) => item.id === draft.id);
        if (index < 0) { if (!prior) latest.push(local); continue; }
        // Durable deletion/save wins over any obsolete page, including its catch paths.
        if (latest[index].status === "cleanup_pending" || latest[index].status === "saved") continue;
        latest[index] = rebasePhotoValue(local, baseline, latest[index]) as PhotoEntryDraft;
      }
      if (!this.writePhotoDraftQueue(latest)) return false;
      this.applyPhotoDraftQueue(latest);
      return true;
    } catch {
      wx.showToast({ title: "照片草稿已在别页变化，当前编辑已保留，请核对后重试", icon: "none" });
      return false;
    }
  },
  /** Queue-only persistence: passive cleanup must never copy this page's form fields. */
  writePhotoDraftQueue(drafts: PhotoEntryDraft[]): boolean {
    const key = this.photoScopeKey;
    if (!key || !this.entryScopeIsCurrent(key)) return false;
    try {
      wx.setStorageSync(key, drafts);
      this.photoDraftStorageWarningShown = false;
      return true;
    } catch {
      if (!this.photoDraftStorageWarningShown) {
        this.photoDraftStorageWarningShown = true;
        wx.showToast({ title: "照片草稿保存失败，请尽快完成当前录入", icon: "none" });
      }
      return false;
    }
  },
  async cleanupPhotoDrafts(): Promise<void> {
    const scope = this.photoScopeKey;
    if (this.photoCleanupRunning || !scope || !this.entryScopeIsCurrent(scope)) return;
    this.photoCleanupRunning = true;
    try {
      // Only durable intents authorize deletion. Explicit delete/save persists them first.
      // onShow also enters here, so neither register nor rewrite a stale page snapshot.
      const queue = this.photoDraftQueueForWrite();
      if (!queue) return;
      for (const draft of queue) {
        if (draft.status !== "saved" && draft.status !== "cleanup_pending") continue;
        const original = JSON.stringify(draft);
        const unchanged = (item: PhotoEntryDraft): boolean => item.id === draft.id && JSON.stringify(item) === original;
        const current = (): boolean => this.entryScopeIsCurrent(scope) &&
          (this.photoDraftQueueForWrite()?.some(unchanged) ?? false);
        if (!current()) return;
        const removed = await removePhotoDraftFiles(draft, scope, current);
        if (!current()) return;
        // Native close/unlink yields. Rebase only this exact, unchanged target onto
        // the newest durable queue, retaining additions and edits from other pages.
        const latest = this.photoDraftQueueForWrite();
        if (!latest) return;
        const index = latest.findIndex(unchanged);
        if (index < 0) return;
        if (removed) latest.splice(index, 1);
        else latest[index] = draft;
        if (!this.writePhotoDraftQueue(latest)) return;
        // A submission owns unacknowledged medicineId/uploadedId and photo objects
        // across awaits. Do not replace them while cleaning another queue target;
        // its next explicit persistence will rebase against this durable queue.
        if (!this.data.submitting || !this.data.activePhotoDraftId) this.applyPhotoDraftQueue(latest);
        if (!removed) {
          wx.showToast({ title: "部分本机照片待清理，记录已保留", icon: "none" });
        }
      }
    } catch {
      wx.showToast({ title: "本机照片清理未完成，记录已保留", icon: "none" });
    } finally {
      this.photoCleanupRunning = false;
    }
  },
  setPhotoDraftStatus(status: PhotoEntryDraft["status"], failureCode: PhotoEntryDraft["failureCode"] = null): void {
    const drafts = this.data.photoDrafts.map((item) => item.id === this.data.activePhotoDraftId ? { ...item, status, failureCode } : item);
    this.setData({ photoDrafts: drafts });
    this.persistPhotoDrafts();
  },
  onSelectPhotoDraft(event: { currentTarget: { dataset: { id?: string } } }): void {
    if (this.data.recognizing || this.data.submitting) return;
    const entry = this.data.photoDrafts.find((item) => item.id === event.currentTarget.dataset.id);
    if (!entry || entry.status === "saved" || entry.status === "cleanup_pending") return;
    if (!this.persistPhotoDrafts() && this.data.activePhotoDraftId) return;
    this.recognitionToken += 1;
    const incomplete = entry.photos.some((photo) => photo.ownedLocal?.state === "reserved");
    this.setData({ ...entry.fields, usePhotoAsCover: entry.fields.usePhotoAsCover === true, manualEdits: entry.fields.manualEdits ?? {}, fieldSources: entry.fields.fieldSources ?? {}, batchSources: entry.fields.batchSources ?? [], resolvedConflictPhotoIds: entry.fields.resolvedConflictPhotoIds ?? {}, purposeTagsTouched: entry.fields.purposeTagsTouched === true, brand: entry.fields.brand ?? "", leafletText: entry.fields.leafletText ?? "", activePhotoDraftId: entry.id, recognitionHint: incomplete
      ? "照片写入尚未完成，请删除这份照片草稿后重拍；药品文字仍可手动保存。"
      : entry.status === "photo_pending" ? "药品已保存，照片待补；点击保存重试照片。" : "已打开照片草稿，请核对后保存。" });
    this.updateDirtyState();
  },
  onNewPhotoDraft(): void {
    if (this.data.recognizing || this.data.submitting) return;
    wx.showToast({ title: "请先保存当前药品，再添加下一种", icon: "none" });
  },
  onDeletePhotoDraft(event: { currentTarget: { dataset: { id?: string } } }): void {
    const id = event.currentTarget.dataset.id;
    if (!id || this.data.recognizing || this.data.submitting) return;
    const originalScope = scopedStorageKey("medicine-photo-drafts");
    if (!this.entryScopeIsCurrent(originalScope)) return;
    wx.showModal({ title: "删除本机照片草稿", content: "已保存的药品和私有照片不受影响。", success: (result) => {
      if (!result.confirm || !this.entryScopeIsCurrent(originalScope) || this.data.recognizing || this.data.submitting) return;
      const latest = this.photoDraftQueueForWrite();
      const draft = latest?.find((item) => item.id === id);
      if (!latest || !draft) return;
      draft.status = "cleanup_pending";
      if (!this.writePhotoDraftQueue(latest)) return;
      this.applyPhotoDraftQueue(latest);
      void this.cleanupPhotoDrafts();
    } });
  },

  onToggleClassification(): void {
    this.setData({ classificationExpanded: !this.data.classificationExpanded });
  },

  onToggleStorage(): void { this.setData({ storageExpanded: !this.data.storageExpanded }); },

  async syncPhotoEvidence(draftId: string, medicine: MedicationSummary, isEdit: boolean, scope: string | null): Promise<"synced" | "synced-stale" | "pending" | "none"> {
    const queue = this.currentPhotoDraftQueue(draftId);
    const draft = queue?.find(item => item.id === draftId);
    if (!queue || !draft) throw new PhotoSaveDeferred("照片草稿已变化，请重新打开核对。");
    const photos = draft.photos.filter(photo => !photo.removed && photo.review);
    if (photos.length === 0 && !draft.evidenceIntent) return "none";
    if (!Number.isInteger(medicine.version) || medicine.version < 1) throw new PhotoSaveDeferred("药品和照片已保存，来源版本未确认，草稿仍保留。");

    let intent = draft.evidenceIntent;
    if (!intent) {
      let existing: RecognitionEvidence | null = null;
      try {
        const response = await api.getRecognitionEvidence(medicine.id);
        if (!this.entryScopeIsCurrent(scope)) throw new PhotoSaveDeferred("身份已变化，照片资料保留在原家庭草稿中。");
        if (response.capabilities?.coverPhotoVersionGuard !== true) throw new Error("unsupported");
        existing = response.evidence;
      } catch {
        if (!this.entryScopeIsCurrent(scope)) throw new PhotoSaveDeferred("身份已变化，照片资料保留在原家庭草稿中。");
        // A new medicine has no earlier provenance. On an old service, freeze the
        // revision-zero intent locally; an eventual conflicting write is rejected.
        if (isEdit) throw new PhotoSaveDeferred("药品和照片已保存，当前服务无法核对原有来源；草稿已保留。");
      }
      const photoIdMap: Record<string, string> = {};
      const uploadedPhotos = photos.map(photo => {
        if (!photo.clientPhotoId || !photo.uploadedId || !photo.sequence || !photo.review) {
          throw new PhotoSaveDeferred("照片上传回执不完整，来源保留在草稿中。");
        }
        photoIdMap[photo.clientPhotoId] = photo.uploadedId;
        return { clientPhotoId: photo.clientPhotoId, photoId: photo.uploadedId, sequence: photo.sequence, review: photo.review };
      });
      const fieldSources = Object.fromEntries(Object.entries(this.data.fieldSources).filter(([field]) =>
        !["lotNumber", "expiryValue", "expiryPrecision", "leafletText", "rawOcrText"].includes(field)));
      const batchSources: RecognitionEvidenceBatchSource[] = [];
      for (const source of this.data.batchSources) {
        if (!this.data.batches.some(batch => batchKey(batch) === source.batchKey)) continue;
        const batchId = draft.batchReceipts?.find(receipt => receipt.batchKey === source.batchKey)?.id;
        if (!batchId) throw new PhotoSaveDeferred("库存回执未确认，照片来源保留在草稿中。");
        batchSources.push({ batchId, field: source.field, source: source.source, photoIds: [...source.photoIds], reviewed: source.reviewed });
      }
      const merged = mergeRecognitionEvidence({ existing, uploadedPhotos, photoIdMap, fieldSources, batchSources,
        revision: existing?.revision ?? 0, medicineVersion: medicine.version,
        idempotencyKey: `evidence-${Date.now()}-${Math.random().toString(36).slice(2, 14)}` });
      if (!merged.ok) throw new PhotoSaveDeferred(`来源资料无法安全整理（${merged.reason}），药品和照片已保存，草稿仍保留。`);
      intent = merged.payload;
      const freshQueue = this.currentPhotoDraftQueue(draftId);
      const fresh = freshQueue?.find(item => item.id === draftId);
      if (!freshQueue || !fresh || fresh.evidenceIntent) throw new PhotoSaveDeferred("照片来源已变化，请重新打开核对。");
      fresh.evidenceIntent = intent;
      this.setData({ photoDrafts: this.visiblePhotoDrafts(freshQueue) });
      if (!this.persistPhotoDrafts()) throw new PhotoSaveDeferred("药品和照片已保存，来源草稿未能安全保存。");
    }
    let pending;
    try { pending = getPendingRecognitionEvidence(medicine.id); } catch {
      throw new PhotoSaveDeferred("药品和照片已保存，无法读取本机待同步来源。");
    }
    if (pending && JSON.stringify(pending.payload) !== JSON.stringify(intent)) {
      throw new PhotoSaveDeferred("已有另一份待同步来源，请先到照片与资料页核对。");
    }
    const result = pending ? await retryRecognitionEvidence(medicine.id) : await queueRecognitionEvidence(medicine.id, intent);
    if (!this.entryScopeIsCurrent(scope) || result.status === "identity_changed") throw new PhotoSaveDeferred("身份已变化，来源草稿仍保留。");
    if (result.status === "synced") return result.reason === "stale" ? "synced-stale" : "synced";
    if (result.status === "pending") return "pending";
    throw new PhotoSaveDeferred(result.status === "existing" ? "已有另一份待同步来源，请先核对。" : "来源待同步资料未能安全保存在本机，请保留草稿重试。");
  },

  async onSubmit(): Promise<void> {
    const initialData = this.data as MedicineEditPageData;
    if (initialData.submitting || initialData.recognizing) return;
    if (initialData.reviewConflicts.length > 0) {
      this.setData({ recognitionHint: "多张照片的资料存在不同内容，请先选择或留空后再保存。" });
      wx.showToast({ title: "请先核对照片中的不同内容", icon: "none" });
      return;
    }
    const originalScope = scopedStorageKey("medicine-photo-drafts");
    if (!this.entryScopeIsCurrent(originalScope)) {
      wx.showToast({ title: "登录身份已变化，请重新打开录入页", icon: "none" });
      return;
    }
    if (this.medicineLoadPromise !== null) await this.medicineLoadPromise;
    if (!this.entryScopeIsCurrent(originalScope)) return;
    const data = this.data as MedicineEditPageData;
    const initialPhoto = data.photoDrafts.find(item => item.id === data.activePhotoDraftId);
    if (initialPhoto?.photos.some(photo => !photo.removed && photo.purpose === "expiry" &&
      !data.batches.some(batch => batchKey(batch) === photoBatchKey(photo, initialPhoto, data.batches)))) {
      this.setData({ recognitionHint: "有效期照片所属库存已移除，请先移除此照片，再保存。" });
      wx.showToast({ title: "请处理无所属库存的照片", icon: "none", duration: 2800 });
      return;
    }
    const name = data.name.trim();
    if (name === "") {
      wx.showToast({ title: "药品名称不能为空", icon: "none" });
      return;
    }
    const built = buildBatchPayloads(data.batches);
    if (built.error !== null) {
      wx.showToast({ title: built.error, icon: "none", duration: 2800 });
      return;
    }

    const ingredients = data.ingredients
      .split(/[、,，;；\s]+/)
      .map((item) => item.trim())
      .filter((item) => item !== "");

    if (!data.isEdit && !data.createOperationKey) {
      this.setData({ createOperationKey: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 12)}` });
      this.persistCurrentDraft();
    }
    const payload: MedicinePayload = {
      name,
      brand: data.brand.trim() || null,
      ...(!data.isEdit ? { idempotencyKey: this.data.createOperationKey } : {}),
      specification: data.specification.trim() === "" ? null : data.specification.trim(),
      manufacturer: data.manufacturer.trim() === "" ? null : data.manufacturer.trim(),
      approvalNumber: data.approvalNumber.trim() === "" ? null : data.approvalNumber.trim(),
      barcodeValue: data.barcodeValue.trim() === "" ? (data.scannedBarcode.trim() || null) : data.barcodeValue.trim(),
      activeIngredients: ingredients,
      purposeCategory: data.purposeCategory.trim() === "" ? null : data.purposeCategory.trim(),
      // B02：整体保存必须回写标签（此前缺省被后端归一为 []，会清空原有标签）。
      populationTags: data.populationTags as MedicinePayload["populationTags"],
      purposeTags: data.purposeTags as MedicinePayload["purposeTags"],
      leaflet: {
        purposeSummary: data.leafletPurpose.trim() === "" ? null : data.leafletPurpose.trim(),
        packageUsageSummary: data.leafletUsage.trim() === "" ? null : data.leafletUsage.trim(),
        contraindicationsSummary:
          data.leafletContraindications.trim() === "" ? null : data.leafletContraindications.trim(),
        precautionsSummary:
          data.leafletPrecautions.trim() === "" ? null : data.leafletPrecautions.trim(),
        source: data.leafletSource.trim() === "" ? null : data.leafletSource.trim(),
        reviewStatus: data.verified ? "user_confirmed" : "unverified",
      },
      batches: built.payloads,
    };

    this.setData({ submitting: true });
    try {
      await ensureLoggedIn();
      if (!this.entryScopeIsCurrent(originalScope)) return;
      if (data.verified && ingredients.length > 0) {
        let matches: MedicationSummary[] = [];
        try {
          const household = await api.listMedicines();
          matches = findVerifiedIngredientMatches(
            ingredients,
            household.medicines,
            true,
            data.isEdit ? data.medicineId : "",
          );
        } catch {
          // The hint is best-effort and must never prevent inventory entry.
        }
        if (!this.entryScopeIsCurrent(originalScope)) return;
        if (matches.length > 0 && !(await confirmIngredientOverlap(matches))) return;
      }
      if (!this.entryScopeIsCurrent(originalScope)) return;
      const activePhoto = data.photoDrafts.find((item) => item.id === data.activePhotoDraftId);
      if (activePhoto?.photos.some((photo) => photo.ownedLocal?.state === "reserved")) {
        this.setData({ recognitionHint: "照片写入尚未完成，请删除该照片草稿后重新拍照，或手动保存药品。" });
        wx.showToast({ title: "照片尚未完整保存", icon: "none" });
        return;
      }
      let saved: MedicationSummary & {
        batchSaveReceipts?: Array<{ index: number; id: string; version: number }>;
      };
      // expiry 照片用提交顺序索引，不能假定服务端批次列表维持这一顺序。
      let acknowledgedBatchIds: Array<string | null> | null = null;
      if (data.isEdit) {
        // 已关联药品的照片草稿同样必须提交本次编辑。旧实现只 GET，
        // 导致 photo_pending 重试时悄悄丢掉用户修改的药品字段。
        if (activePhoto?.medicineId && activePhoto.medicineId !== data.medicineId) {
          throw new Error("照片草稿不属于当前编辑的药品，请重新核对");
        }
        const reuseSaved = activePhoto?.savedMedicinePayload === JSON.stringify(payload) &&
          Number.isInteger(activePhoto.savedMedicineVersion);
        if (reuseSaved && activePhoto) {
          saved = await api.getMedicine(data.medicineId);
          if (!this.entryScopeIsCurrent(originalScope)) return;
          const cover = activePhoto.coverIntent;
          const completedLostAck = cover && saved.coverPhotoId === cover.photoId && saved.version === cover.expectedVersion + 1;
          if (saved.version !== activePhoto.savedMedicineVersion && !completedLostAck) {
            throw new PhotoSaveDeferred("药品已在其他地方更新，请重新打开药品核对，照片草稿仍保留。");
          }
          acknowledgedBatchIds = data.batches.map(batch => batch.id);
        } else {
        if (activePhoto?.coverIntent && !activePhoto.coverIntent.completedVersion) {
          throw new PhotoSaveDeferred("上次封面设置尚未确认，请先恢复照片草稿核对。");
        }
        const submittedBatches = data.batches.map((batch) => ({ ...batch }));
        saved = await api.updateMedicine(data.medicineId, { ...payload, version: data.version });
        if (!this.entryScopeIsCurrent(originalScope)) return;
        const byId = new Map(saved.batches.map((batch) => [batch.id, batch]));
        const receipts = saved.batchSaveReceipts;
        const validReceipts = Array.isArray(receipts) &&
          receipts.length === submittedBatches.length &&
          receipts.every((receipt, index) => receipt.index === index &&
            typeof receipt.id === "string" && Number.isInteger(receipt.version) &&
            byId.get(receipt.id)?.version === receipt.version &&
            (submittedBatches[index].id === null || submittedBatches[index].id === receipt.id));
        const oldIds = new Set(submittedBatches.map((batch) => batch.id).filter((id): id is string => id !== null));
        const newRows = saved.batches.filter((batch) => !oldIds.has(batch.id));
        const newCount = submittedBatches.filter((batch) => batch.id === null).length;
        const submittedPhotoBatchIds: Array<string | null> = submittedBatches.map((batch, index) =>
          validReceipts ? receipts[index].id :
          batch.id ?? (newCount === 1 && newRows.length === 1 ? newRows[0].id : null));
        const unambiguous = submittedPhotoBatchIds.length === saved.batches.length &&
          submittedPhotoBatchIds.every((id) => id !== null && Number.isInteger(byId.get(id)?.version)) &&
          new Set(submittedPhotoBatchIds).size === submittedPhotoBatchIds.length;
        // 已部署的旧 API 不提供写回执：至多一个新批次时可凭 ID 差集
        // 唯一回绑；多个新批次时使用服务端权威列表，禁止猜测照片关联。
        const acknowledgedBatches: BatchForm[] = unambiguous
          ? submittedBatches.map((batch, index) => ({
              ...batch, id: submittedPhotoBatchIds[index],
              version: byId.get(submittedPhotoBatchIds[index]!)!.version,
            }))
          : batchFromSummary(saved);
        // 必须在改表单指纹前确认旧队列仍属原提交，禁止覆盖另一页面的更改。
        const draftQueue = activePhoto ? this.currentPhotoDraftQueue(activePhoto.id) : null;
        const keyMap = new Map(submittedBatches.flatMap((batch, index) => {
          const id = submittedPhotoBatchIds[index];
          return id ? [[batchKey(batch), `saved:${id}`] as const] : [];
        }));
        const manualEdits = { ...this.data.manualEdits };
        for (const [oldKey, newKey] of keyMap) {
          const oldIdentity = oldKey.slice(oldKey.indexOf(":") + 1);
          const newIdentity = newKey.slice(newKey.indexOf(":") + 1);
          for (const key of Object.keys(manualEdits)) {
            if (key.startsWith(`batch:${oldIdentity}:`)) manualEdits[`batch:${newIdentity}:${key.slice(`batch:${oldIdentity}:`.length)}`] = true;
          }
        }
        const batchSources = this.data.batchSources.map(source => ({ ...source, batchKey: keyMap.get(source.batchKey) ?? source.batchKey }));
        this.setData({ version: saved.version, batches: acknowledgedBatches, manualEdits, batchSources });
        acknowledgedBatchIds = acknowledgedBatches.map((batch) => batch.id);
        if (activePhoto) {
          const draft = draftQueue?.find((item) => item.id === activePhoto.id);
          if (!draftQueue || !draft) {
            wx.showToast({ title: "药品已保存，照片草稿已变化，请重新核对", icon: "none" });
            return;
          }
          draft.batchReceipts = [];
          for (const photo of draft.photos) {
            const originalKey = photo.batchKey || batchKey(submittedBatches[photo.batchIndex]);
            photo.batchKey = keyMap.get(originalKey) ?? originalKey;
            photo.batchIndex = acknowledgedBatches.findIndex(batch => batchKey(batch) === photo.batchKey);
          }
          for (const [originalKey, nextKey] of keyMap) {
            const id = nextKey.slice("saved:".length);
            draft.batchReceipts.push({ batchKey: nextKey, id });
            if (originalKey !== nextKey) draft.batchReceipts.push({ batchKey: originalKey, id });
          }
          draft.fields = draftValues(this.data as MedicineEditPageData);
          draft.savedMedicinePayload = JSON.stringify({ ...payload, batches: buildBatchPayloads(acknowledgedBatches).payloads });
          draft.savedMedicineVersion = saved.version;
          if (!this.writePhotoDraftQueue(draftQueue)) {
            wx.showToast({ title: "药品已保存，批次回执本机存储失败，请勿重复新增", icon: "none" });
            return;
          }
          this.photoQueueBaseline = snapshot(draftQueue);
          this.photoFormBaseline = { id: draft.id, fields: snapshot(draft.fields) };
          this.setData({ photoDrafts: this.visiblePhotoDrafts(draftQueue) });
        }
        this.persistCurrentDraft();
        wx.showToast({ title: "已保存", icon: "success" });
        }
      } else if (activePhoto?.medicineId) {
        // 新建药品在首次保存后绑定了 ID；重试只补照片，不重复创建。
        saved = await api.getMedicine(activePhoto.medicineId);
      } else {
        if (!this.data.attemptedPayload) { this.setData({ attemptedPayload: payload }); this.persistCurrentDraft(); this.persistPhotoDrafts(); }
        saved = await api.createMedicine(this.data.attemptedPayload ?? payload);
        if (!this.entryScopeIsCurrent(originalScope)) return;
        if (saved?.id) {
          const highlightKey = scopedStorageKey("cabinet-saved-highlight");
          try { if (highlightKey) wx.setStorageSync(highlightKey, saved.id); } catch { /* post-save highlight is best effort */ }
        }
        wx.showToast({ title: "已录入", icon: "success" });
      }
      if (!this.entryScopeIsCurrent(originalScope)) return;
      if (activePhoto && saved?.id) {
        // Persist the medicine association before the first upload: a process restart
        // or lost ACK must resume photos under the already-created medicine.
        // Older in-memory/legacy drafts may not yet have a durable queue receipt.
        // Write the current draft first and proceed only after it is persisted.
        if (!this.currentPhotoDraftQueue(activePhoto.id) && !this.persistPhotoDrafts()) {
          wx.showToast({ title: "照片草稿尚未安全保存，请重试保存后再补传", icon: "none" });
          return;
        }
        const linkedQueue = this.currentPhotoDraftQueue(activePhoto.id);
        const linked = linkedQueue?.find(item => item.id === activePhoto.id);
        if (!linkedQueue || !linked) return;
        const wasAlreadyLinked = Boolean(linked.medicineId);
        linked.medicineId = saved.id;
        const needsBatchReceipt = linked.photos.some(photo => !photo.removed && photo.purpose === "expiry") ||
          this.data.batchSources.some(source => this.data.batches.some(batch => batchKey(batch) === source.batchKey));
        if (!data.isEdit && !linked.batchReceipts && !needsBatchReceipt) linked.batchReceipts = [];
        if (!data.isEdit && !linked.batchReceipts) {
          const ids = saved.batches.map(batch => batch.id);
          if ((!wasAlreadyLinked || ids.length === 1) && ids.length === data.batches.length && ids.every(Boolean) && new Set(ids).size === ids.length) {
            // The create response preserves the insertion order of the submitted batches.
            linked.batchReceipts = data.batches.map((batch, index) => ({ batchKey: batchKey(batch), id: ids[index] }));
          }
        }
        this.setData({ photoDrafts: this.visiblePhotoDrafts(linkedQueue) });
        if (!this.persistPhotoDrafts()) {
          wx.showToast({ title: "药品已保存，但照片关联暂未安全落盘；请重试保存", icon: "none" });
          return;
        }
        if (!data.isEdit && !linked.batchReceipts) {
          wx.showToast({ title: "药品已保存，库存回执不完整，照片保留待核对", icon: "none", duration: 3500 });
          return;
        }
        try {
          for (const snapshotPhoto of activePhoto.photos) {
            // Always derive the live photo from the durable queue, not a stale page snapshot.
            const queue = this.currentPhotoDraftQueue(activePhoto.id, snapshotPhoto.path);
            const livePhoto = queue?.find(entry => entry.id === activePhoto.id)?.photos.find(p => p.path === snapshotPhoto.path);
            if (!queue || !livePhoto) return;
            if (livePhoto.removed || livePhoto.uploadedId) continue;
            if (!livePhoto.uploadIntentKey) {
              livePhoto.uploadIntentKey = `photo-upload-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
              this.setData({ photoDrafts: this.visiblePhotoDrafts(queue) });
              if (!this.persistPhotoDrafts()) throw new Error("照片上传回执标识保存失败");
            }
            // If persistence is unavailable, never dispatch an unrepeatable upload.
            const confirmed = this.currentPhotoDraftQueue(activePhoto.id, snapshotPhoto.path)
              ?.find(entry => entry.id === activePhoto.id)?.photos.find(p => p.path === snapshotPhoto.path);
            if (!confirmed?.uploadIntentKey) throw new Error("照片上传标识未能持久保存");
            const imageBase64 = await new Promise<string>((resolve, reject) => wx.getFileSystemManager().readFile({
              filePath: snapshotPhoto.path, encoding: "base64", success: (result) => resolve(result.data as string), fail: reject,
            }));
            if (!this.entryScopeIsCurrent(originalScope)) return;
            const ownerKey = photoBatchKey(confirmed, linked, data.batches);
            const batchIndex = data.batches.findIndex(batch => batchKey(batch) === ownerKey);
            const batchId = linked.batchReceipts?.find(receipt => receipt.batchKey === ownerKey)?.id ??
              (data.isEdit && batchIndex >= 0 ? acknowledgedBatchIds?.[batchIndex] ?? null : null);
            if (confirmed.purpose === "expiry" && !batchId) throw new Error("库存关联尚未完成，照片仍保留待核对");
            const result = await api.uploadLeafletPhoto(saved.id, imageBase64, confirmed.mimeType, "medicine_entry",
              { purpose: confirmed.purpose, ...(batchId ? { batchId } : {}) }, confirmed.uploadIntentKey);
            if (!this.entryScopeIsCurrent(originalScope)) return;
            const after = this.currentPhotoDraftQueue(activePhoto.id, snapshotPhoto.path);
            const acknowledged = after?.find(entry => entry.id === activePhoto.id)?.photos.find(p => p.path === snapshotPhoto.path);
            if (!after || !acknowledged || acknowledged.uploadIntentKey !== confirmed.uploadIntentKey) return;
            acknowledged.uploadedId = result.photo.id;
            this.setData({ photoDrafts: this.visiblePhotoDrafts(after) });
            if (!this.persistPhotoDrafts()) throw new Error("照片上传成功但本机回执保存失败");
          }
          const coverQueue = this.currentPhotoDraftQueue(activePhoto.id);
          const acknowledgedDraft = coverQueue?.find(entry => entry.id === activePhoto.id);
          if (!coverQueue || !acknowledgedDraft) return;
          if (data.usePhotoAsCover || acknowledgedDraft.coverIntent) {
            const front = acknowledgedDraft.photos.filter(photo => !photo.removed && photo.purpose === "box_front" && photo.uploadedId).slice(-1)[0];
            const photoId = acknowledgedDraft.coverIntent?.photoId ?? front?.uploadedId;
            if (photoId) {
              if (!Number.isInteger(saved.version)) throw new PhotoSaveDeferred("药品和照片已保存，封面版本未确认，请保留草稿重试。");
              if (!acknowledgedDraft.coverIntent) {
                acknowledgedDraft.coverIntent = { photoId, expectedVersion: saved.version };
                this.setData({ photoDrafts: this.visiblePhotoDrafts(coverQueue) });
                if (!this.persistPhotoDrafts()) throw new PhotoSaveDeferred("药品和照片已保存，封面待处理状态未能安全保存。");
              }
              const intent = acknowledgedDraft.coverIntent;
              if (!intent.completedVersion) {
                // A lost acknowledgement is only accepted when both version and desired photo match.
                if (saved.version === intent.expectedVersion + 1 && saved.coverPhotoId === intent.photoId) {
                  intent.completedVersion = saved.version;
                } else {
                  if (saved.version !== intent.expectedVersion) throw new PhotoSaveDeferred("药品已变化，封面设置需重新核对；照片仍保留。");
                  let supported = false;
                  try { supported = (await api.getRecognitionEvidence(saved.id)).capabilities?.coverPhotoVersionGuard === true; } catch { /* old or unreachable API */ }
                  if (!this.entryScopeIsCurrent(originalScope)) return;
                  if (!supported) throw new PhotoSaveDeferred("药品和照片已保存，当前服务暂不支持安全设置封面；草稿已保留。");
                  const result = await api.setMedicineCover(saved.id, intent.photoId, intent.expectedVersion);
                  if (!this.entryScopeIsCurrent(originalScope)) return;
                  if (result.coverPhotoId !== intent.photoId || result.version !== intent.expectedVersion + 1) {
                    throw new PhotoSaveDeferred("封面回执未确认，草稿已保留，请重新核对。");
                  }
                  intent.completedVersion = result.version;
                  saved.version = result.version;
                  saved.coverPhotoId = intent.photoId;
                }
                const currentQueue = this.currentPhotoDraftQueue(activePhoto.id);
                const currentDraft = currentQueue?.find(entry => entry.id === activePhoto.id);
                if (!currentQueue || !currentDraft || currentDraft.coverIntent?.photoId !== intent.photoId ||
                    currentDraft.coverIntent.expectedVersion !== intent.expectedVersion) return;
                currentDraft.coverIntent.completedVersion = intent.completedVersion;
                currentDraft.savedMedicineVersion = intent.completedVersion;
                this.setData({ version: intent.completedVersion, photoDrafts: this.visiblePhotoDrafts(currentQueue) });
                if (!this.persistPhotoDrafts()) throw new PhotoSaveDeferred("封面已设置，但回执未能安全保留；请勿重复修改。");
              }
            }
          }
          if (!this.entryScopeIsCurrent(originalScope)) return;
          const evidenceOutcome = await this.syncPhotoEvidence(activePhoto.id, saved, data.isEdit, originalScope);
          if (!this.entryScopeIsCurrent(originalScope)) return;
          const finishedQueue = this.currentPhotoDraftQueue(activePhoto.id);
          const finishedDraft = finishedQueue?.find(item => item.id === activePhoto.id);
          if (!finishedQueue || !finishedDraft) return;
          finishedDraft.status = "saved";
          if (!this.writePhotoDraftQueue(finishedQueue)) return;
          this.setData({ photoDrafts: this.visiblePhotoDrafts(finishedQueue), activePhotoDraftId: "" });
          await this.cleanupPhotoDrafts();
          if (!this.entryScopeIsCurrent(originalScope)) return;
          if (evidenceOutcome === "pending") {
            wx.showToast({ title: "药品和照片已保存，识别来源待同步，可在照片与资料页重试。", icon: "none", duration: 4000 });
          } else if (evidenceOutcome === "synced-stale") {
            wx.showToast({ title: "来源已保存，部分历史资料仍需核对。", icon: "none", duration: 4000 });
          }
        } catch (error) {
          if (!this.entryScopeIsCurrent(originalScope)) return;
          this.setPhotoDraftStatus("photo_pending");
          this.persistPhotoDrafts();
          if (error instanceof PhotoSaveDeferred) this.setData({ recognitionHint: error.message });
          wx.showToast({ title: error instanceof PhotoSaveDeferred ? "资料待处理，请查看页面提示" : "药品已保存，照片待补；点击保存可重试照片", icon: "none", duration: 4000 });
          return;
        }
      }
      this.removeStoredDraft();
      this.discardingDraft = true;
      this.setData({ isDirty: false });
      this.setNativeLeaveWarning(false);
      setTimeout(() => {
        if (!this.entryScopeIsCurrent(originalScope)) return;
        if (data.isEdit) this.navigateBackFromForm();
        else wx.switchTab({ url: "/pages/index/index" });
      }, 800);
    } catch (error) {
      if (!this.entryScopeIsCurrent(originalScope)) return;
      if (error instanceof PhotoSaveDeferred) {
        this.setData({ recognitionHint: error.message });
        wx.showToast({ title: "资料待处理，请查看页面提示", icon: "none", duration: 4000 });
        return;
      }
      if (!data.isEdit && error instanceof ApiError && error.statusCode === 400) {
        this.setData({ attemptedPayload: null });
        this.persistCurrentDraft();
        this.persistPhotoDrafts();
      }
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        this.persistCurrentDraft();
        wx.showModal({
          title: "保存冲突",
          content: "你的修改已保留为本机草稿。重新读取最新记录后，可恢复草稿核对，再保存；继续编辑会保留当前输入。",
          confirmText: "读取最新", cancelText: "继续编辑",
          success: (result) => { if (result.confirm) void this.loadMedicine(data.medicineId); },
        });
      } else {
        showError(error);
      }
    } finally {
      this.setData({ submitting: false });
    }
  },
});
