import type { PopulationTag, PurposeTag } from "./api-types";
/**
 * 标签统一定义（B02）：录入/编辑/展示共用一套值与文案。
 * 值域与后端 inputs.ts 白名单保持一致（adult/child；fever…other）。
 */
export const POPULATION_TAG_OPTIONS: readonly { kind: PopulationTag; label: string }[] = [
  { kind: "adult", label: "成人" },
  { kind: "child", label: "儿童" },
] as const;

export const PURPOSE_TAG_OPTIONS: readonly { kind: PurposeTag; label: string }[] = [
  { kind: "fever", label: "发热" },
  { kind: "cough", label: "咳嗽" },
  { kind: "throat", label: "咽喉" },
  { kind: "nasal", label: "鼻部" },
  { kind: "gastro", label: "胃肠" },
  { kind: "pain", label: "疼痛" },
  { kind: "topical", label: "外用" },
  { kind: "allergy", label: "抗过敏" },
  { kind: "other", label: "其他" },
] as const;

export function populationTagLabel(kind: string): string {
  return POPULATION_TAG_OPTIONS.find((option) => option.kind === kind)?.label ?? kind;
}

export function purposeTagLabel(kind: string): string {
  return PURPOSE_TAG_OPTIONS.find((option) => option.kind === kind)?.label ?? kind;
}
