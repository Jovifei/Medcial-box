/**
 * 定点数量：数据库用 numeric(14,3) 存毫升等可带小数的数量，
 * 而 pg 驱动会把 numeric 读成字符串。所有边界（读库、算数、回写）
 * 都必须经过这里，避免出现 "12.5" 与 12.5 混用或浮点累加误差。
 */
export const DECIMAL_SCALE = 1000;

/** numeric 列 → 安全 number（null 保持 null；非法值同样返回 null）。 */
export function decimalOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * DECIMAL_SCALE) / DECIMAL_SCALE;
}

/** number → 毫单位整数，用于加减乘除与比较，避免 0.1+0.2 这类误差。 */
export function toMilli(value: number): number {
  return Math.round(value * DECIMAL_SCALE);
}

/** 毫单位整数 → number。 */
export function fromMilli(value: number): number {
  return value / DECIMAL_SCALE;
}
