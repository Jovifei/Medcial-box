// 有效期精度算法（纯函数，注入 now）：
// - day 精度：默认提前 30 天临期；过期日当天仍属临期（剩 0 天）。
// - month 精度：只显示月份，过完该月才标过期，当月内标"本月到期"。
// - unknown：无法解析时一律"有效期未知"，不伪造日期。
import type {
  ExpiryState,
  ExpiryStateInfo,
  ExpiryValue,
} from "@home-medicine/contracts";

export const EXPIRING_SOON_DAYS = 30;

/**
 * 家庭时区（审核修复 #5）：有效期按家庭所在时区的"今天"计算。
 * 默认 Asia/Shanghai——此前用 UTC 日期，在中国时区凌晨 0 点到早上 8 点之间
 * 服务端日期仍是前一天，导致"昨天到期"的药误显示为"今天到期"。
 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zonedFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    zonedFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** 把时刻映射到指定时区的日历日期（家庭"今天"以此为准）。 */
export function zonedDateParts(
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): { year: number; month: number; day: number } {
  const parts = zonedFormatter(timeZone).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value ?? "0";
    return Number.parseInt(value, 10);
  };
  return { year: pick("year"), month: pick("month"), day: pick("day") };
}

const DAY_MS = 86_400_000;

/**
 * Parse a raw expiry string into the storage shape. Recognizes YYYY-MM-DD and
 * YYYY-MM (with calendar validation); everything else stays "unknown" while
 * keeping the original text so users never lose what was printed on the box.
 */
export function parseExpiry(raw: string | null): ExpiryValue {
  const text = (raw ?? "").trim();
  if (text === "") return { value: null, precision: "unknown" };

  const monthMatch = /^(\d{4})-(\d{2})$/.exec(text);
  if (monthMatch) {
    const month = Number(monthMatch[2]);
    if (month >= 1 && month <= 12) return { value: text, precision: "month" };
    return { value: text, precision: "unknown" };
  }

  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dayMatch) {
    const year = Number(dayMatch[1]);
    const month = Number(dayMatch[2]);
    const day = Number(dayMatch[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    const calendarValid =
      check.getUTCFullYear() === year &&
      check.getUTCMonth() === month - 1 &&
      check.getUTCDate() === day;
    if (calendarValid) return { value: text, precision: "day" };
    return { value: text, precision: "unknown" };
  }

  return { value: text, precision: "unknown" };
}

/** Whole days from `now`'s family-timezone date to the expiry date (day precision only). */
export function daysUntilExpiry(
  expiry: ExpiryValue,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): number | null {
  if (expiry.precision !== "day" || expiry.value === null) return null;
  const parts = expiry.value.split("-");
  const expiryDay = Date.UTC(
    Number(parts[0]),
    Number(parts[1]) - 1,
    Number(parts[2]),
  );
  const todayParts = zonedDateParts(now, timeZone);
  const today = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day);
  return Math.round((expiryDay - today) / DAY_MS);
}

export function deriveExpiryState(
  expiry: ExpiryValue,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): ExpiryState {
  if (expiry.precision === "unknown" || expiry.value === null) return "unknown";

  if (expiry.precision === "month") {
    const parts = expiry.value.split("-");
    const expiryMonthIndex = Number(parts[0]) * 12 + (Number(parts[1]) - 1);
    const todayParts = zonedDateParts(now, timeZone);
    const nowMonthIndex = todayParts.year * 12 + (todayParts.month - 1);
    if (expiryMonthIndex < nowMonthIndex) return "expired";
    if (expiryMonthIndex === nowMonthIndex) return "due_this_month";
    return "ok";
  }

  const daysRemaining = daysUntilExpiry(expiry, now, timeZone);
  if (daysRemaining === null) return "unknown";
  if (daysRemaining < 0) return "expired";
  if (daysRemaining <= EXPIRING_SOON_DAYS) return "expiring_soon";
  return "ok";
}

export function formatExpiryLabel(
  state: ExpiryState,
  expiry: ExpiryValue,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  switch (state) {
    case "unknown":
      return "有效期未知";
    case "expired":
      return expiry.value === null ? "已过期" : `已过期（${expiry.value}）`;
    case "due_this_month":
      return expiry.value === null ? "本月到期" : `本月到期（${expiry.value}）`;
    case "expiring_soon": {
      const days = daysUntilExpiry(expiry, now, timeZone);
      if (days === null) return "临期";
      if (days === 0) return "临期（今天到期）";
      return `临期（剩 ${days} 天）`;
    }
    case "ok":
      return expiry.value === null ? "有效期未知" : `有效期至 ${expiry.value}`;
  }
}

/** Combined state + label for a single expiry record. */
export function describeExpiry(
  expiry: ExpiryValue,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): ExpiryStateInfo {
  const state = deriveExpiryState(expiry, now, timeZone);
  return { state, label: formatExpiryLabel(state, expiry, now, timeZone) };
}

const STATE_SEVERITY: Record<ExpiryState, number> = {
  expired: 4,
  due_this_month: 3,
  expiring_soon: 2,
  unknown: 1,
  ok: 0,
};

/** Worst state among a medicine's batches; empty input yields "ok". */
export function mostSevereState(states: readonly ExpiryState[]): ExpiryState {
  let worst: ExpiryState = "ok";
  for (const state of states) {
    if (STATE_SEVERITY[state] > STATE_SEVERITY[worst]) worst = state;
  }
  return worst;
}

/** Generic per-state label for medicine-level summaries (no batch date). */
export function summarizeExpiryState(state: ExpiryState): string {
  switch (state) {
    case "expired":
      return "已过期";
    case "due_this_month":
      return "本月到期";
    case "expiring_soon":
      return "临期";
    case "unknown":
      return "有效期未知";
    case "ok":
      return "正常";
  }
}
