import type {
  AfterOpeningLimitInput,
  BatchExpiryInput,
  LowStockThresholdInput,
  MedicationBatchSummary,
  QuantityUnit,
  StockStatus,
} from "@home-medicine/contracts";
import { deriveExpiryState, describeExpiry } from "./expiry.js";

export interface EffectiveExpiryResult {
  date: string | null;
  source: "package" | "opened" | null;
}

export interface StockStatusResult {
  state: StockStatus;
  quantity: number | null;
  unit: QuantityUnit | null;
}

function parseCalendarDate(value: string | null): { year: number; month: number; day: number } | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function formatCalendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function calculateOpenedExpiryDate(
  openedAt: string | null,
  limit: AfterOpeningLimitInput | null,
): string | null {
  const opened = parseCalendarDate(openedAt);
  if (limit === null) {
    return null;
  }
  if ("date" in limit) return parseCalendarDate(limit.date) === null ? null : limit.date;
  if (opened === null || !Number.isSafeInteger(limit.value) || limit.value < 1) return null;
  if (limit.unit === "day") {
    const result = new Date(Date.UTC(opened.year, opened.month - 1, opened.day + limit.value));
    return formatCalendarDate(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate());
  }
  const monthIndex = opened.year * 12 + opened.month - 1 + limit.value;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const day = Math.min(opened.day, daysInMonth(year, month));
  return formatCalendarDate(year, month, day);
}

function packageExpiryDate(expiry: BatchExpiryInput): string | null {
  if (expiry.value === null) return null;
  if (expiry.precision === "day") return parseCalendarDate(expiry.value) === null ? null : expiry.value;
  if (expiry.precision !== "month" || !/^\d{4}-\d{2}$/.test(expiry.value)) return null;
  const [year, month] = expiry.value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12) return null;
  return formatCalendarDate(year, month, daysInMonth(year, month));
}

export function calculateEffectiveExpiryDate(
  packageExpiry: BatchExpiryInput,
  openedExpiryDate: string | null,
): EffectiveExpiryResult {
  const packageDate = packageExpiryDate(packageExpiry);
  const openedDate =
    openedExpiryDate !== null && parseCalendarDate(openedExpiryDate) !== null
      ? openedExpiryDate
      : null;
  if (packageDate === null && openedDate === null) return { date: null, source: null };
  if (packageDate === null) return { date: openedDate, source: "opened" };
  if (openedDate === null || packageDate <= openedDate) return { date: packageDate, source: "package" };
  return { date: openedDate, source: "opened" };
}

function quantityInThresholdUnit(
  batch: Pick<MedicationBatchSummary, "quantity" | "unit" | "confirmedUnitsPerPackage">,
  thresholdUnit: QuantityUnit,
): number | null {
  if (batch.quantity === null) return null;
  if (batch.quantity === 0 || batch.unit === thresholdUnit) return batch.quantity;
  if (batch.unit === "box" && thresholdUnit === "tablet" && batch.confirmedUnitsPerPackage !== null) {
    return batch.quantity * batch.confirmedUnitsPerPackage;
  }
  return null;
}

export function calculateStockStatus(
  batches: readonly Pick<MedicationBatchSummary, "quantity" | "unit" | "confirmedUnitsPerPackage" | "managementExpiryDate" | "dispositionStatus">[],
  threshold: LowStockThresholdInput | null,
  now: Date,
): StockStatusResult {
  if (threshold === null || batches.length === 0) {
    return { state: "unknown", quantity: null, unit: threshold?.unit ?? null };
  }
  const currentBatches = batches.filter((batch) => {
    if (batch.dispositionStatus === "handled") return false;
    if (batch.managementExpiryDate === null || batch.managementExpiryDate === undefined) return true;
    return deriveExpiryState({ value: batch.managementExpiryDate, precision: "day" }, now) !== "expired";
  });
  if (currentBatches.length === 0) return { state: "unknown", quantity: null, unit: threshold.unit };

  let total = 0;
  for (const batch of currentBatches) {
    const quantity = quantityInThresholdUnit(batch, threshold.unit);
    if (quantity === null) return { state: "unknown", quantity: null, unit: threshold.unit };
    total += quantity;
    if (!Number.isSafeInteger(total)) return { state: "unknown", quantity: null, unit: threshold.unit };
  }
  if (total === 0) return { state: "exhausted", quantity: total, unit: threshold.unit };
  return {
    state: total <= threshold.quantity ? "low" : "ok",
    quantity: total,
    unit: threshold.unit,
  };
}

export function describeManagementExpiry(date: string | null, now: Date) {
  if (date === null) return { state: "unknown" as const, label: "开封/包装有效期待补充" };
  return describeExpiry({ value: date, precision: "day" }, now);
}
