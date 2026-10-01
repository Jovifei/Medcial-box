import type { ExpiryPrecision } from "./api-types";

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
