import { createHash, randomUUID } from "node:crypto";
import type {
  DispositionStatus,
  FamilyInventorySettings,
  FamilyMedicineBackup,
  MedicationSummary,
  RecognitionEvidenceBackupDocument,
  RecognitionEvidenceBackupBatchSource,
  RecognitionEvidenceDocument,
} from "@home-medicine/contracts";
import { validateMedicineInput, type ValidatedBatchFields, type ValidatedMedicineFields } from "../inputs.js";
import { validateRecognitionEvidenceDocument } from "./recognition-evidence.js";

export interface ValidatedBackupBatchFields extends ValidatedBatchFields {
  /** 已处理批次恢复后必须保持 handled，不得复活为正常库存。 */
  dispositionStatus: DispositionStatus;
  backupBatchRef?: string;
}

export interface ValidatedBackupMedicineFields extends Omit<ValidatedMedicineFields, "batches"> {
  isArchived: boolean;
  batches: ValidatedBackupBatchFields[];
  recognitionEvidence?: RecognitionEvidenceBackupDocument;
}

export interface ValidatedFamilyMedicineBackup {
  /** v1：整数数量与旧单位；v2：定点数量（ml 三位小数）与 ml/blister 单位。 */
  schemaVersion: 1 | 2;
  contentScope?: "inventory_only" | "inventory_and_recognition_evidence";
  backupId: string;
  exportedAt: string;
  familyName: string;
  inventorySettings: FamilyInventorySettings;
  medicines: ValidatedBackupMedicineFields[];
}

export type BackupValidationResult =
  | { ok: true; value: ValidatedFamilyMedicineBackup }
  | { ok: false; errors: string[] };

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableJsonValue(item));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, stableJsonValue(child)]),
  );
}

/** Digest normalized backup contents so confirmation cannot be reused for edits. */
export function hashFamilyMedicineBackup(value: ValidatedFamilyMedicineBackup): string {
  return createHash("sha256").update(JSON.stringify(stableJsonValue(value))).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIsoTimestampOrNull(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59 &&
    offsetHour <= 23 && offsetMinute <= 59;
}

function containsPrivateFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateFields);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    /token|session|dosage|personalnote|leafletphotos|photo/i.test(key) || containsPrivateFields(child),
  );
}

function freshBackupRef(used: Set<string>): string {
  let ref: string;
  do { ref = randomUUID(); } while (used.has(ref));
  used.add(ref);
  return ref;
}

/** References are generated within this backup, never inferred from equal values or ordering. */
function backupEvidence(document: RecognitionEvidenceDocument, refs: ReadonlyMap<string, string>, used: Set<string>): RecognitionEvidenceBackupDocument {
  if (document.batchSources === undefined) return { schemaVersion: 1, photos: document.photos, fieldSources: document.fieldSources };
  const historical = new Map<string, string>();
  const batchSources: RecognitionEvidenceBackupBatchSource[] = document.batchSources.map((source) => {
    const bound = source.batchId === null ? undefined : refs.get(source.batchId);
    const historyKey = source.batchId === null ? `history:${source.historicalBatchRef}` : `batch:${source.batchId}`;
    let ref = bound ?? historical.get(historyKey);
    if (ref === undefined) { ref = freshBackupRef(used); historical.set(historyKey, ref); }
    return { backupBatchRef: ref, batchState: bound === undefined ? "removed" : "bound",
      field: source.field, source: source.source, photoIds: source.photoIds, reviewed: source.reviewed };
  });
  return { schemaVersion: 1, photos: document.photos, fieldSources: document.fieldSources, batchSources };
}

const BACKUP_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate the external ref graph before converting it to an internal placeholder document. */
function validateBackupEvidence(value: unknown, knownRefs: ReadonlySet<string>): RecognitionEvidenceBackupDocument | null {
  if (!isRecord(value)) return null;
  if (value.batchSources === undefined) {
    const parsed = validateRecognitionEvidenceDocument(value);
    return parsed ? { schemaVersion: 1, photos: parsed.photos, fieldSources: parsed.fieldSources } : null;
  }
  if (!Array.isArray(value.batchSources) || value.batchSources.length > 1000) return null;
  const states = new Map<string, string>();
  const converted: unknown[] = [];
  for (const raw of value.batchSources) {
    if (!isRecord(raw) || !Object.keys(raw).every((key) => ["backupBatchRef", "batchState", "field", "source", "photoIds", "reviewed"].includes(key)) ||
        typeof raw.backupBatchRef !== "string" || !BACKUP_REF.test(raw.backupBatchRef) ||
        (raw.batchState !== "bound" && raw.batchState !== "removed")) return null;
    const ref = raw.backupBatchRef.toLowerCase();
    if ((raw.batchState === "bound") !== knownRefs.has(ref) || (states.has(ref) && states.get(ref) !== raw.batchState)) return null;
    states.set(ref, raw.batchState);
    converted.push({ batchId: raw.batchState === "bound" ? ref : null,
      ...(raw.batchState === "removed" ? { historicalBatchRef: ref } : {}),
      field: raw.field, source: raw.source, photoIds: raw.photoIds, reviewed: raw.reviewed });
  }
  const parsed = validateRecognitionEvidenceDocument({ ...value, batchSources: converted });
  if (!parsed) return null;
  const batchSources = parsed.batchSources?.map((source, index) => {
    const raw = value.batchSources as Array<Record<string, unknown>>;
    return { backupBatchRef: String(raw[index].backupBatchRef).toLowerCase(), batchState: raw[index].batchState as "bound" | "removed",
      field: source.field, source: source.source, photoIds: source.photoIds, reviewed: source.reviewed };
  });
  return { schemaVersion: 1, photos: parsed.photos, fieldSources: parsed.fieldSources, batchSources };
}

/** Create a fresh additive-only household snapshot; IDs/versions/private notes are omitted. */
export function createFamilyMedicineBackup<T extends MedicationSummary>(
  familyName: string,
  medicines: readonly T[],
  inventorySettings: FamilyInventorySettings,
  exportedAt = new Date(),
  evidenceByMedicine: ReadonlyMap<string, RecognitionEvidenceDocument> = new Map(),
): FamilyMedicineBackup {
  return {
    schemaVersion: 2,
    backupId: randomUUID(),
    exportedAt: exportedAt.toISOString(),
    familyName,
    inventorySettings,
    medicines: medicines.map((medicine) => {
      const evidence = evidenceByMedicine.get(medicine.id);
      const refs = new Map<string, string>();
      const used = new Set<string>();
      if ((evidence?.batchSources?.length ?? 0) > 0) {
        for (const batch of medicine.batches) refs.set(batch.id, freshBackupRef(used));
      }
      return {
      name: medicine.name,
      specification: medicine.specification,
      brand: medicine.brand ?? null,
      manufacturer: medicine.manufacturer,
      approvalNumber: medicine.approvalNumber,
      barcodeValue: medicine.barcodeValue ?? null,
      activeIngredients: [...medicine.activeIngredients],
      purposeCategory: medicine.purposeCategory,
      populationTags: [...(medicine.populationTags ?? [])],
      purposeTags: [...(medicine.purposeTags ?? [])],
      tagSource: medicine.tagSource ?? "manual",
      leaflet: {
        purposeSummary: medicine.leaflet.purposeSummary,
        packageUsageSummary: medicine.leaflet.packageUsageSummary,
        contraindicationsSummary: medicine.leaflet.contraindicationsSummary,
        precautionsSummary: medicine.leaflet.precautionsSummary,
        source: medicine.leaflet.source,
        reviewStatus: medicine.leaflet.reviewStatus,
      },
      lowStockThreshold: medicine.lowStockThreshold ?? null,
      isArchived: medicine.isArchived === true,
      ...(evidence === undefined ? {} : { recognitionEvidence: backupEvidence(evidence, refs, used) }),
      batches: medicine.batches.map((batch) => ({
        ...(refs.has(batch.id) ? { backupBatchRef: refs.get(batch.id) } : {}),
        lotNumber: batch.lotNumber,
        expiry: batch.expiry,
        quantity: batch.quantity,
        unit: batch.unit,
        confirmedUnitsPerPackage: batch.confirmedUnitsPerPackage,
        conversionUnit: batch.conversionUnit ?? null,
        storageLocation: batch.storageLocation,
        openedState: batch.openedState ?? "unknown",
        openedAt: batch.openedAt ?? null,
        afterOpeningLimit: batch.afterOpeningLimit ?? null,
        dispositionStatus: batch.dispositionStatus ?? "active",
      })),
      };
    }),
  };
}

export function validateFamilyMedicineBackup(raw: unknown): BackupValidationResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["备份内容必须是 JSON 对象"] };
  // Only the strict recognition-evidence document is allowed to contain photo IDs;
  // all other photo fields and every unknown/private field remain prohibited.
  const { medicines: rawMedicines, ...backupWithoutMedicines } = raw;
  const hasPrivateMedicine = Array.isArray(rawMedicines) && rawMedicines.some((item) => {
    if (!isRecord(item)) return containsPrivateFields(item);
    const medicineWithoutEvidence = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "recognitionEvidence"));
    return containsPrivateFields(medicineWithoutEvidence);
  });
  if (containsPrivateFields(backupWithoutMedicines) || hasPrivateMedicine) errors.push("备份包含登录凭据或个人私有字段");
  // v1（旧版整数数量）继续可恢复；v2 是定点数量与 ml/blister 之后的版本。
  // 未知版本直接拒绝，绝不静默当作最新版解析。
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) errors.push("不支持的备份版本");
  if (raw.contentScope !== undefined && raw.contentScope !== "inventory_only" && raw.contentScope !== "inventory_and_recognition_evidence") {
    errors.push("备份范围不正确");
  }
  if (typeof raw.backupId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.backupId)) {
    errors.push("backupId 格式不正确");
  }
  if (typeof raw.exportedAt !== "string" || !Number.isFinite(Date.parse(raw.exportedAt))) errors.push("导出时间不正确");
  if (typeof raw.familyName !== "string" || raw.familyName.trim() === "" || Array.from(raw.familyName).length > 80) errors.push("家庭名称不正确");
  const settings = raw.inventorySettings;
  if (!isRecord(settings) || !["weekly", "monthly", "disabled"].includes(String(settings.stocktakeInterval))) {
    errors.push("盘点设置不正确");
  } else {
    if (!isValidIsoTimestampOrNull(settings.lastStocktakeAt)) errors.push("上次盘点时间格式不正确");
    if (!isValidIsoTimestampOrNull(settings.nextStocktakeAt)) errors.push("下次盘点时间格式不正确");
  }
  if (!Array.isArray(raw.medicines) || raw.medicines.length > 500) errors.push("药品列表格式不正确或超过 500 项");
  const medicines: ValidatedBackupMedicineFields[] = [];
  if (Array.isArray(raw.medicines) && raw.medicines.length <= 500) {
    raw.medicines.forEach((item, index) => {
      if (!isRecord(item)) {
        errors.push(`第 ${index + 1} 项药品格式不正确`);
        return;
      }
      if (raw.contentScope === "inventory_only" && item.recognitionEvidence !== undefined) {
        errors.push(`第 ${index + 1} 项药品包含不属于仅库存备份的来源资料`);
        return;
      }
      if (item.isArchived !== undefined && typeof item.isArchived !== "boolean") {
        errors.push(`第 ${index + 1} 项归档状态不正确`);
        return;
      }
      const parsed = validateMedicineInput(item);
      if (!parsed.ok) {
        errors.push(`第 ${index + 1} 项药品：${parsed.message}`);
        return;
      }
      const rawBatches = Array.isArray(item.batches) ? item.batches : [];
      const refs = new Set<string>();
      for (const rawBatch of rawBatches) {
        if (!isRecord(rawBatch) || rawBatch.backupBatchRef === undefined) continue;
        if (typeof rawBatch.backupBatchRef !== "string" || !BACKUP_REF.test(rawBatch.backupBatchRef) || refs.has(rawBatch.backupBatchRef.toLowerCase())) {
          errors.push(`第 ${index + 1} 项药品的批次引用格式不正确`);
          return;
        }
        refs.add(rawBatch.backupBatchRef.toLowerCase());
      }
      const evidence = item.recognitionEvidence === undefined ? undefined : validateBackupEvidence(item.recognitionEvidence, refs);
      if (evidence === null) {
        errors.push(`第 ${index + 1} 项药品的来源资料格式不正确`);
        return;
      }
      let dispositionValid = true;
      const batches: ValidatedBackupBatchFields[] = parsed.value.batches.map((batch, batchIndex) => {
        const rawBatch = isRecord(rawBatches[batchIndex]) ? rawBatches[batchIndex] : {};
        const claimed = rawBatch.dispositionStatus;
        const ref = typeof rawBatch.backupBatchRef === "string" ? rawBatch.backupBatchRef.toLowerCase() : undefined;
        const withRef = { ...batch, ...(ref === undefined ? {} : { backupBatchRef: ref }) };
        if (claimed === undefined || claimed === null) return { ...withRef, dispositionStatus: "active" as const };
        if (claimed !== "active" && claimed !== "handled") {
          errors.push(`第 ${index + 1} 项药品第 ${batchIndex + 1} 个批次处置状态不合法`);
          dispositionValid = false;
          return { ...withRef, dispositionStatus: "active" as const };
        }
        return { ...withRef, dispositionStatus: claimed };
      });
      if (!dispositionValid) return;
      medicines.push({ ...parsed.value, isArchived: item.isArchived === true, batches,
        ...(evidence === undefined ? {} : { recognitionEvidence: evidence }) });
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: raw.schemaVersion as 1 | 2,
      ...(raw.contentScope === undefined ? {} : { contentScope: raw.contentScope as "inventory_only" | "inventory_and_recognition_evidence" }),
      backupId: raw.backupId as string,
      exportedAt: raw.exportedAt as string,
      familyName: (raw.familyName as string).trim(),
      inventorySettings: settings as unknown as FamilyInventorySettings,
      medicines,
    },
  };
}
