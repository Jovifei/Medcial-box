// 有效期算法纯函数直测：注入固定 now 覆盖月末、跨年、年月精度与 30 天临期边界。
import assert from "node:assert/strict";
import test from "node:test";
import {
  daysUntilExpiry,
  deriveExpiryState,
  describeExpiry,
  formatExpiryLabel,
  mostSevereState,
  parseExpiry,
  summarizeExpiryState,
} from "../dist/domain/expiry.js";

const NOW = new Date("2026-10-15T08:00:00Z");

test("parseExpiry keeps YYYY-MM-DD as day precision", () => {
  assert.deepEqual(parseExpiry("2026-10-31"), { value: "2026-10-31", precision: "day" });
});

test("parseExpiry keeps YYYY-MM as month precision without inventing a day", () => {
  assert.deepEqual(parseExpiry("2026-10"), { value: "2026-10", precision: "month" });
});

test("parseExpiry rejects impossible calendar dates as unknown", () => {
  assert.equal(parseExpiry("2026-02-30").precision, "unknown");
  assert.equal(parseExpiry("2026-13-01").precision, "unknown");
  assert.equal(parseExpiry("2026-00-10").precision, "unknown");
});

test("parseExpiry keeps unknown text and empty input without a date", () => {
  assert.deepEqual(parseExpiry("近期"), { value: "近期", precision: "unknown" });
  assert.deepEqual(parseExpiry(null), { value: null, precision: "unknown" });
  assert.deepEqual(parseExpiry("   "), { value: null, precision: "unknown" });
});

test("day precision: past date is expired", () => {
  const expiry = { value: "2026-09-30", precision: "day" };
  assert.equal(deriveExpiryState(expiry, NOW), "expired");
});

test("day precision: the 30-day advance boundary is expiring_soon, 31 days is ok", () => {
  assert.equal(
    deriveExpiryState({ value: "2026-11-14", precision: "day" }, NOW),
    "expiring_soon",
  );
  assert.equal(
    deriveExpiryState({ value: "2026-11-15", precision: "day" }, NOW),
    "ok",
  );
});

test("day precision: expiry today is expiring_soon with zero days left", () => {
  const expiry = { value: "2026-10-15", precision: "day" };
  assert.equal(deriveExpiryState(expiry, NOW), "expiring_soon");
  assert.equal(daysUntilExpiry(expiry, NOW), 0);
});

test("day precision: month-end and leap-year boundaries stay exact", () => {
  const now = new Date("2026-02-01T00:00:00Z");
  assert.equal(deriveExpiryState({ value: "2026-03-03", precision: "day" }, now), "expiring_soon");
  const leapNow = new Date("2028-02-01T00:00:00Z");
  assert.equal(daysUntilExpiry({ value: "2028-03-02", precision: "day" }, leapNow), 30);
});

test("month precision: only after the month ends is it expired", () => {
  assert.equal(
    deriveExpiryState({ value: "2026-09", precision: "month" }, NOW),
    "expired",
  );
});

test("month precision: the expiry month itself is due_this_month", () => {
  assert.equal(
    deriveExpiryState({ value: "2026-10", precision: "month" }, NOW),
    "due_this_month",
  );
  // 当月最后一天仍未过期（以家庭时区 Asia/Shanghai 为准：UTC 16:00 前仍是当月）。
  assert.equal(
    deriveExpiryState({ value: "2026-10", precision: "month" }, new Date("2026-10-31T15:59:59Z")),
    "due_this_month",
  );
});

test("month precision: cross-year boundaries (family timezone Asia/Shanghai)", () => {
  // UTC 2026-12-31T15:59:59Z = 上海 2026-12-31 23:59 → "2026-12" 仍是当月。
  const lastMinuteOf2026 = new Date("2026-12-31T15:59:59Z");
  const endOf2026 = new Date("2026-12-31T23:59:59Z"); // 上海已是 2027-01-01
  const startOf2027 = new Date("2027-01-01T16:00:01Z"); // 上海 2027-01-02
  assert.equal(deriveExpiryState({ value: "2026-12", precision: "month" }, lastMinuteOf2026), "due_this_month");
  assert.equal(deriveExpiryState({ value: "2027-01", precision: "month" }, lastMinuteOf2026), "ok");
  assert.equal(deriveExpiryState({ value: "2027-01", precision: "month" }, endOf2026), "due_this_month");
  assert.equal(deriveExpiryState({ value: "2026-12", precision: "month" }, endOf2026), "expired");
  assert.equal(deriveExpiryState({ value: "2026-12", precision: "month" }, startOf2027), "expired");
});

test("day precision follows the family timezone, not UTC (audit fix #5)", () => {
  // UTC 2026-09-24T20:00:00Z = 上海 2026-09-25 04:00：
  // 上海视角 2026-09-24 已经过去 → expired（旧 UTC 算法会误判为"今天到期"）。
  const earlyMorning = new Date("2026-09-24T20:00:00Z");
  assert.equal(
    deriveExpiryState({ value: "2026-09-24", precision: "day" }, earlyMorning),
    "expired",
  );
  assert.equal(daysUntilExpiry({ value: "2026-09-24", precision: "day" }, earlyMorning), -1);
  // UTC 2026-09-30T17:00:00Z = 上海 2026-10-01 01:00 → "2026-09" 已过月。
  assert.equal(
    deriveExpiryState({ value: "2026-09", precision: "month" }, new Date("2026-09-30T17:00:00Z")),
    "expired",
  );
});

test("unknown precision always reports unknown regardless of value", () => {
  assert.equal(deriveExpiryState({ value: null, precision: "unknown" }, NOW), "unknown");
  assert.equal(deriveExpiryState({ value: "2026-10", precision: "unknown" }, NOW), "unknown");
});

test("labels describe state, remaining days and the original value", () => {
  assert.equal(
    formatExpiryLabel("expired", { value: "2026-10", precision: "month" }, NOW),
    "已过期（2026-10）",
  );
  assert.equal(
    formatExpiryLabel("due_this_month", { value: "2026-10", precision: "month" }, NOW),
    "本月到期（2026-10）",
  );
  assert.equal(
    formatExpiryLabel("expiring_soon", { value: "2026-11-05", precision: "day" }, NOW),
    "临期（剩 21 天）",
  );
  assert.equal(
    formatExpiryLabel("expiring_soon", { value: "2026-10-15", precision: "day" }, NOW),
    "临期（今天到期）",
  );
  assert.equal(
    formatExpiryLabel("ok", { value: "2027-06-30", precision: "day" }, NOW),
    "有效期至 2027-06-30",
  );
  assert.equal(formatExpiryLabel("unknown", { value: null, precision: "unknown" }, NOW), "有效期未知");
});

test("describeExpiry combines state and label", () => {
  const info = describeExpiry({ value: "2026-10", precision: "month" }, NOW);
  assert.deepEqual(info, { state: "due_this_month", label: "本月到期（2026-10）" });
});

test("mostSevereState picks the worst state and summarizeExpiryState labels it", () => {
  assert.equal(mostSevereState(["ok", "expiring_soon", "expired"]), "expired");
  assert.equal(mostSevereState(["ok", "unknown"]), "unknown");
  assert.equal(mostSevereState([]), "ok");
  assert.equal(summarizeExpiryState("due_this_month"), "本月到期");
  assert.equal(summarizeExpiryState("ok"), "正常");
});
