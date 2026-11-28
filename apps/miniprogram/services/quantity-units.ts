import { UNIT_DISPLAY } from "./input-validation";
import type { QuantityUnit } from "./api-types";

/**
 * 数量单位短名：复用 input-validation 的 B02 共享表，未知枚举不静默改成“份”，
 * 保留待核对提示，避免把 24 ml 误写成 24 份；不做数量换算。
 */
export function quantityUnitShort(unit: unknown): string {
  if (typeof unit === "string" && Object.hasOwn(UNIT_DISPLAY, unit)) {
    return UNIT_DISPLAY[unit as QuantityUnit];
  }
  return "单位待核对";
}