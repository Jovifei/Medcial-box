import type { MedicineRecognitionResponse } from "./api-types";

export const REVIEW_LABELS = {
  name: "药品名称", brand: "品牌", specification: "规格", manufacturer: "厂家", approvalNumber: "批准文号",
  barcodeValue: "包装码", activeIngredients: "有效成分", purposeCategory: "历史用途", lotNumber: "批号",
  expiryValue: "有效期", expiryPrecision: "有效期精度", populationTags: "适用人群", purposeTags: "用途标签",
  leafletText: "说明书原文", rawOcrText: "识别原文（待核对）", purposeSummary: "用途", packageUsageSummary: "用法用量",
  contraindicationsSummary: "禁忌", precautionsSummary: "注意事项",
} as const;

export type ReviewField = keyof typeof REVIEW_LABELS;
export type ReviewValue = string | string[] | null;
export type ReviewFields = Partial<Record<ReviewField, ReviewValue>>;
export interface PhotoReview {
  status: "pending" | "recognized" | "failed";
  fields: ReviewFields;
  warnings: string[];
}
export interface ReviewPhoto {
  clientPhotoId?: string;
  sequence?: number;
  batchKey?: string;
  review?: PhotoReview;
}
export interface FieldSource {
  source: "manual" | "recognized" | "catalog" | "removed";
  photoIds: string[];
  reviewed: boolean;
}
export interface ReviewChoice {
  value: string | string[];
  label: string;
  photoIds: string[];
  sequences: number[];
  sourceLabel: string;
  precision?: string;
}
export interface ReviewConflict { field: ReviewField; label: string; batchKey?: string; choices: ReviewChoice[] }

const directFields = [
  "name", "brand", "specification", "manufacturer", "approvalNumber", "purposeCategory", "lotNumber",
  "expiryValue", "expiryPrecision",
] as const;
const leafletFields = ["text", "purposeSummary", "packageUsageSummary", "contraindicationsSummary", "precautionsSummary"] as const;

/** Preserve only actual provider fields; no medical category or dose inference. */
export function recognitionFields(
  draft: MedicineRecognitionResponse["draft"], populations: readonly string[], purposes: readonly string[],
): ReviewFields {
  const fields: ReviewFields = {};
  for (const key of directFields) {
    const value = draft[key];
    if (typeof value === "string" && value.trim() !== "") fields[key] = value;
  }
  for (const [key, allowed] of [["populationTags", populations], ["purposeTags", purposes]] as const) {
    const raw = draft[key];
    if (Array.isArray(raw)) {
      const values = [...new Set<string>(raw.filter(value => typeof value === "string" && allowed.includes(value)))];
      if (values.length > 0) fields[key] = values;
    }
  }
  if (draft.leaflet) {
    for (const key of leafletFields) {
      const value = draft.leaflet[key];
      if (typeof value === "string" && value.trim() !== "") fields[key === "text" ? "leafletText" : key] = value;
    }
  }
  return fields;
}

/** Form field paths and persisted evidence use explicit, stable names. */
export function evidenceField(path: string): ReviewField | null {
  const batch = /^batches\[\d+\]\.(lotNumber|expiryValue)$/.exec(path);
  if (batch) return batch[1] as ReviewField;
  const names: Record<string, ReviewField> = {
    ingredients: "activeIngredients", leafletPurpose: "purposeSummary", leafletUsage: "packageUsageSummary",
    leafletContraindications: "contraindicationsSummary", leafletPrecautions: "precautionsSummary",
  };
  if (names[path]) return names[path];
  return Object.hasOwn(REVIEW_LABELS, path) ? path as ReviewField : null;
}

export function formField(field: ReviewField): string | null {
  const names: Partial<Record<ReviewField, string>> = {
    activeIngredients: "ingredients", purposeSummary: "leafletPurpose", packageUsageSummary: "leafletUsage",
    contraindicationsSummary: "leafletContraindications", precautionsSummary: "leafletPrecautions",
    lotNumber: "batches[0].lotNumber", expiryValue: "batches[0].expiryValue",
  };
  if (field === "expiryPrecision" || field === "rawOcrText") return null;
  return names[field] ?? field;
}

function valueKey(value: string | string[]): string {
  return JSON.stringify(Array.isArray(value) ? [...value].sort() : value.trim());
}

/** Group identical values and keep conflicts visible instead of choosing a last photo. */
export function photoCandidates(photos: ReviewPhoto[]): ReviewConflict[] {
  const groups = new Map<string, { field: ReviewField; batchKey?: string; choices: Map<string, ReviewChoice> }>();
  for (const photo of photos) {
    if (!photo.clientPhotoId || !photo.sequence || photo.review?.status !== "recognized") continue;
    for (const [rawField, rawValue] of Object.entries(photo.review.fields)) {
      if (!Object.hasOwn(REVIEW_LABELS, rawField) || rawField === "expiryPrecision" || rawField === "leafletText" || rawField === "rawOcrText" ||
          rawValue === null || rawValue === undefined || Array.isArray(rawValue) && rawValue.length === 0) continue;
      const field = rawField as ReviewField;
      const batchKey = field === "expiryValue" || field === "lotNumber" ? photo.batchKey : undefined;
      const groupKey = `${field}\u0000${batchKey ?? ""}`;
      const value = rawValue as string | string[];
      const precision = field === "expiryValue" && typeof photo.review.fields.expiryPrecision === "string"
        ? photo.review.fields.expiryPrecision : undefined;
      const key = `${valueKey(value)}:${precision ?? ""}`;
      const group = groups.get(groupKey) ?? { field, ...(batchKey ? { batchKey } : {}), choices: new Map<string, ReviewChoice>() };
      const choices = group.choices;
      const current = choices.get(key) ?? { value, label: Array.isArray(value) ? value.join("、") : value, photoIds: [], sequences: [], sourceLabel: "", ...(precision ? { precision } : {}) };
      current.photoIds.push(photo.clientPhotoId);
      current.sequences.push(photo.sequence);
      current.sourceLabel = current.sequences.map(number => `图${number}`).join("、");
      choices.set(key, current);
      groups.set(groupKey, group);
    }
  }
  return [...groups.values()].map(group => ({ field: group.field, label: REVIEW_LABELS[group.field],
    ...(group.batchKey ? { batchKey: group.batchKey } : {}), choices: [...group.choices.values()] }));
}
