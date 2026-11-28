/**
 * B2 试点：药品说明摘要。
 * - 只把药品记录里的公开资料发给 aiRelay，不包含家庭、账号或私人备注；
 * - 输出只作记录参考，页面必须显示「AI 生成，请以说明书为准」；
 * - 不含诊断、剂量或用药建议；资料不足时允许 AI 明确说无法概括。
 */
import { aiApi, type AiMessage } from "./ai-api";
import type { MedicationSummary } from "./api-types";

export const AI_SUMMARY_DISCLAIMER = "AI 生成，请以说明书为准";
const MAX_SUMMARY_CHARS = 240;

export function buildMedicineSummaryMessages(medicine: MedicationSummary): AiMessage[] {
  const facts: string[] = [`药名：${medicine.name}`];
  if (medicine.specification !== null && medicine.specification !== "") facts.push(`规格：${medicine.specification}`);
  if (medicine.manufacturer !== null && medicine.manufacturer !== "") facts.push(`厂家：${medicine.manufacturer}`);
  if (medicine.activeIngredients.length > 0) facts.push(`成分：${medicine.activeIngredients.join("、")}`);
  if (medicine.leaflet.purposeSummary !== null) facts.push(`说明书用途：${medicine.leaflet.purposeSummary}`);
  if (medicine.leaflet.packageUsageSummary !== null) facts.push(`说明书用法：${medicine.leaflet.packageUsageSummary}`);
  if (medicine.leaflet.contraindicationsSummary !== null) facts.push(`说明书禁忌：${medicine.leaflet.contraindicationsSummary}`);
  if (medicine.leaflet.precautionsSummary !== null) facts.push(`说明书注意事项：${medicine.leaflet.precautionsSummary}`);
  return [
    {
      role: "system",
      content: "你是家庭药箱的记录助理。只根据提供的药品资料，用一句不超过 120 字的中文概括用途和需要注意的事项；不要给出诊断、剂量或用药建议；资料不足时直接说明无法概括。",
    },
    { role: "user", content: facts.join("\n") },
  ];
}

export async function summarizeMedicine(medicine: MedicationSummary): Promise<string> {
  const result = await aiApi.generateText(buildMedicineSummaryMessages(medicine));
  const text = result.text.trim().replace(/\s+/g, " ");
  if (text === "") throw new Error("AI 没有返回摘要，请稍后重试");
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text;
}