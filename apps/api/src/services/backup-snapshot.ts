import { createHash, randomUUID } from "node:crypto";
import type {
  FamilyInventorySettings,
  FamilyMedicineBackup,
  MedicationSummary,
} from "@home-medicine/contracts";
import { validateMedicineInput, type ValidatedMedicineFields } from "../inputs.js";

export interface ValidatedFamilyMedicineBackup {
  schemaVersion: 1;
  backupId: string;
  exportedAt: string;
  familyName: string;
  inventorySettings: FamilyInventorySettings;
  medicines: Array<ValidatedMedicineFields & { isArchived: boolean }>;
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

/** Create a fresh additive-only household snapshot; IDs/versions/private notes are omitted. */
export function createFamilyMedicineBackup(
  familyName: string,
  medicines: readonly (MedicationSummary & Record<string, unknown>)[],
  inventorySettings: FamilyInventorySettings,
  exportedAt = new Date(),
): FamilyMedicineBackup {
  return {
    schemaVersion: 1,
    backupId: randomUUID(),
    exportedAt: exportedAt.toISOString(),
    familyName,
    inventorySettings,
    medicines: medicines.map((medicine) => ({
      name: medicine.name,
      specification: medicine.specification,
      manufacturer: medicine.manufacturer,
      approvalNumber: medicine.approvalNumber,
      barcodeValue: medicine.barcodeValue ?? null,
      activeIngredients: [...medicine.activeIngredients],
      purposeCategory: medicine.purposeCategory,
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
      batches: medicine.batches.map((batch) => ({
        lotNumber: batch.lotNumber,
        expiry: batch.expiry,
        quantity: batch.quantity,
        unit: batch.unit,
        confirmedUnitsPerPackage: batch.confirmedUnitsPerPackage,
        storageLocation: batch.storageLocation,
        openedState: batch.openedState ?? "unknown",
        openedAt: batch.openedAt ?? null,
        afterOpeningLimit: batch.afterOpeningLimit ?? null,
      })),
    })),
  };
}

export function validateFamilyMedicineBackup(raw: unknown): BackupValidationResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["备份内容必须是 JSON 对象"] };
  if (containsPrivateFields(raw)) errors.push("备份包含登录凭据或个人私有字段");
  if (raw.schemaVersion !== 1) errors.push("不支持的备份版本");
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
  const medicines: Array<ValidatedMedicineFields & { isArchived: boolean }> = [];
  if (Array.isArray(raw.medicines) && raw.medicines.length <= 500) {
    raw.medicines.forEach((item, index) => {
      if (!isRecord(item)) {
        errors.push(`第 ${index + 1} 项药品格式不正确`);
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
      medicines.push({ ...parsed.value, isArchived: item.isArchived === true });
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      backupId: raw.backupId as string,
      exportedAt: raw.exportedAt as string,
      familyName: (raw.familyName as string).trim(),
      inventorySettings: settings as unknown as FamilyInventorySettings,
      medicines,
    },
  };
}
