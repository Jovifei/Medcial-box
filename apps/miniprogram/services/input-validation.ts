import type { ExpiryPrecision, QuantityUnit } from "./api-types";

/**
 * 单位定义统一表（B02）：值、文案、精度规则一处维护。
 * 顺序即 picker 顺序； medicinal-edit 与 batch-edit 共用，
 * 避免"值表 8 项、文案 6 项"错位导致『其他』存成『板』。
 */
export const UNIT_VALUES: QuantityUnit[] = ["tablet", "capsule", "sachet", "bottle", "box", "blister", "ml", "other"];
export const UNIT_LABELS = ["片", "粒", "袋", "瓶", "盒", "板", "毫升", "其他"];

/** 数量按单位的输入规则：ml 允许最多 3 位小数，其余计件单位必须是非负整数。 */
export function unitAllowsDecimals(unit: QuantityUnit): boolean {
  return unit === "ml";
}

/** 按单位校验并解析数量输入；返回 null 表示非法（由页面给出文案）。 */
export function parseQuantityByUnit(raw: string, unit: QuantityUnit): number | null {
  const value = raw.trim();
  if (unitAllowsDecimals(unit)) {
    if (!isNonNegativeDecimalQuantity(value)) return null;
    return Math.round(Number(value) * 1000) / 1000;
  }
  if (!isStrictNonNegativeInteger(value)) return null;
  return Number(value);
}

/** 按单位校验并解析每包装换算数（板→片、盒→板/片、瓶→ml 的确认关系）。 */
export function parseConfirmedUnitsByUnit(raw: string, unit: QuantityUnit): number | null {
  const value = raw.trim();
  if (unitAllowsDecimals(unit)) {
    if (!isNonNegativeDecimalQuantity(value) || Number(value) <= 0) return null;
    return Math.round(Number(value) * 1000) / 1000;
  }
  if (!isStrictPositiveInteger(value)) return null;
  return Number(value);
}

/**
 * 输入框中的库存数量必须是完整的、非负的安全整数。
 * Number.parseInt("12abc", 10) 会得到 12，因此这里先校验完整字符串。
 */
/**
 * 非负数量，允许最多 3 位小数（毫升）。计件单位请继续用
 * isStrictNonNegativeInteger，由页面按单位选择。
 */
export function isNonNegativeDecimalQuantity(value: string): boolean {
  return /^(0|[1-9]\d{0,8})(\.\d{1,3})?$/.test(value);
}

export function isStrictNonNegativeInteger(value: string): boolean {
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) return false;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0;
}

/** 每包装换算数必须是完整的正安全整数。 */
export function isStrictPositiveInteger(value: string): boolean {
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) return false;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

/**
 * 校验有效期的格式和真实日历值。
 * 月精度只接受真实月份；日精度会拒绝 2 月 31 日等不存在日期。
 */
export function isValidExpiryValue(value: string, precision: ExpiryPrecision): boolean {
  if (precision === "unknown") return value === "";
  if (precision === "day" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (precision === "month" && !/^\d{4}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  if (!Number.isInteger(year) || year < 1 || !Number.isInteger(month) || month < 1 || month > 12) {
    return false;
  }
  if (precision === "month") return true;

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Number.isInteger(day) && day >= 1 && day <= daysInMonth[month - 1];
}
