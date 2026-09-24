// Markdown 导出渲染器（纯函数）：
// - 分区：在用库存 / 已过期 / 已耗尽 / 日期待补充（D4：已归档仅在显式请求时输出）；
// - 显式标注数量未知与零、有效期原文与精度（YYYY-MM 不伪造日期）、存放位置（D1）；
// - 仅 reviewStatus 为 user_confirmed / matched 的说明书摘要作为"已核对资料"输出；
// - 所有用户输入经 Markdown 转义，防止表格/标题/列表注入；
// - "库存存在"不表述为"适合服用"。
import type {
  ExpiryPrecision,
  MedicationBatchSummary,
  MedicationSummary,
  QuantityUnit,
} from "@home-medicine/contracts";
import { describeExpiry } from "../domain/expiry.js";

export interface MarkdownExportOptions {
  includePersonalDosage: boolean;
  includeArchived: boolean;
  includeStorageLocation: boolean;
}

export interface ExportDosageNote {
  userId: string;
  isMine: boolean;
  content: string;
}

export interface ExportMedicine extends MedicationSummary {
  /** 仅在 includePersonalDosage=true 时附带，且已按查看权限过滤。 */
  dosageNotes?: ExportDosageNote[];
}

export type ExportSection =
  | "active"
  | "expired"
  | "exhausted"
  | "missing_date"
  | "archived";

const DISCLAIMER = "信息仅供家庭管理参考，以说明书和医嘱为准。";

const UNIT_LABELS: Record<QuantityUnit, string> = {
  tablet: "片",
  capsule: "粒",
  sachet: "袋",
  bottle: "瓶",
  box: "盒",
  other: "个单位",
};

const PRECISION_LABELS: Record<ExpiryPrecision, string> = {
  day: "到日",
  month: "仅到月",
  unknown: "日期未记录",
};

/**
 * Escape Markdown-active characters and flatten newlines so user input can
 * never inject headings, lists, tables or emphasis.
 */
export function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([\]`|*_#>[])/g, "\\$1")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** 已耗尽判定：有批次且全部批次数量为 0（数量未知不算耗尽）。 */
export function isExhausted(medicine: ExportMedicine): boolean {
  return (
    medicine.batches.length > 0 &&
    medicine.batches.every((batch) => batch.quantity === 0)
  );
}

/** 日期待补充判定：无批次，或全部批次有效期为未知精度。 */
export function isMissingDate(medicine: ExportMedicine): boolean {
  return (
    medicine.batches.length === 0 ||
    medicine.batches.every((batch) => batch.expiry.precision === "unknown")
  );
}

/**
 * Medicine-level partition. Priority: 已归档 > 已耗尽 > 已过期 > 日期待补充 >
 * 在用库存；批次级临期等细节在条目内用标签展示。
 */
export function partitionMedicine(medicine: ExportMedicine): ExportSection {
  if (medicine.isArchived === true) return "archived";
  if (isExhausted(medicine)) return "exhausted";
  if (medicine.expiryState?.state === "expired") return "expired";
  if (isMissingDate(medicine)) return "missing_date";
  return "active";
}

function quantityText(batch: MedicationBatchSummary): string {
  if (batch.quantity === null) return "数量未知";
  if (batch.quantity === 0) return "已耗尽";
  return `${batch.quantity} ${UNIT_LABELS[batch.unit] ?? "个单位"}`;
}

function expiryText(
  batch: MedicationBatchSummary,
  now: Date,
): string {
  const { label } = describeExpiry(batch.expiry, now);
  const precision = PRECISION_LABELS[batch.expiry.precision];
  const printed = batch.expiry.value ?? "未记录";
  return `有效期 ${printed}（${precision}，${label}）`;
}

function storageText(
  batch: MedicationBatchSummary,
  includeStorageLocation: boolean,
): string {
  if (!includeStorageLocation) return "";
  return batch.storageLocation === null
    ? "；存放位置未记录"
    : `；存放位置：${batch.storageLocation}`;
}

function leafletText(medicine: ExportMedicine): string[] {
  const lines: string[] = [];
  const leaflet = medicine.leaflet;
  if (leaflet.reviewStatus === "unverified") {
    lines.push("- 说明书摘要：未核验（未对照包装内说明书核对前，不作为用药依据）");
    return lines;
  }
  const sourceSuffix = leaflet.source === null ? "" : `（来源：${leaflet.source}）`;
  const statusSuffix =
    leaflet.reviewStatus === "user_confirmed" ? "本人已核对" : "资料匹配";
  lines.push(`- 说明书摘要 ${statusSuffix}${sourceSuffix}：`);
  const sections: Array<[string, string | null]> = [
    ["用途", leaflet.purposeSummary],
    ["用法用量", leaflet.packageUsageSummary],
    ["禁忌", leaflet.contraindicationsSummary],
    ["注意事项", leaflet.precautionsSummary],
  ];
  let rendered = false;
  for (const [title, value] of sections) {
    if (value !== null && value !== "") {
      lines.push(`  - ${title}：${value}`);
      rendered = true;
    }
  }
  if (!rendered) lines.push("  - 暂无已填写内容");
  return lines;
}

function notesText(medicine: ExportMedicine): string[] {
  const notes = medicine.dosageNotes ?? [];
  if (notes.length === 0) return [];
  const lines = ["- 个人剂量备注（实际每日剂量由成员各自记录）："];
  for (const note of notes) {
    const owner = note.isMine ? "本人" : "家庭成员";
    lines.push(`  - ${owner}：${note.content}`);
  }
  return lines;
}

function renderMedicine(
  medicine: ExportMedicine,
  options: MarkdownExportOptions,
  now: Date,
): string[] {
  const lines: string[] = [];
  const specSuffix = medicine.specification === null ? "" : `（${medicine.specification}）`;
  lines.push(`### ${medicine.name}${specSuffix}`);

  const meta: string[] = [];
  if (medicine.manufacturer !== null) meta.push(`生产厂家：${medicine.manufacturer}`);
  if (medicine.approvalNumber !== null) meta.push(`批准文号：${medicine.approvalNumber}`);
  if (medicine.purposeCategory !== null) meta.push(`用途分类：${medicine.purposeCategory}`);
  if (meta.length > 0) lines.push(`- ${meta.join("；")}`);

  if (medicine.batches.length === 0) {
    lines.push("- 批次：暂无批次记录");
  } else {
    lines.push("- 批次：");
    for (const batch of medicine.batches) {
      const lot =
        batch.lotNumber === null ? "批次号未记录" : `批次号 ${batch.lotNumber}`;
      const confirmed =
        batch.confirmedUnitsPerPackage === null
          ? ""
          : `；每包装含 ${batch.confirmedUnitsPerPackage} 个最小单位（本人已确认换算）`;
      lines.push(
        `  - ${lot}：${quantityText(batch)}；${expiryText(batch, now)}` +
          `${storageText(batch, options.includeStorageLocation)}${confirmed}`,
      );
    }
  }

  lines.push(...leafletText(medicine));
  lines.push(...notesText(medicine));
  return lines;
}

const SECTION_HEADERS: Record<Exclude<ExportSection, "archived">, string> = {
  active: "## 在用库存",
  expired: "## 已过期",
  exhausted: "## 已耗尽",
  missing_date: "## 日期待补充",
};

const SECTION_NOTES: Record<Exclude<ExportSection, "archived">, string> = {
  active: "库存存在不等于适合服用，服用前请核对说明书并遵医嘱。",
  expired: "以下药品已过期，请勿服用，并按当地规定处理。",
  exhausted: "以下药品数量为零，需要时请及时补充。",
  missing_date: "以下药品的有效期未记录，请对照包装补充后再判断能否使用。",
};

/**
 * Render the full export document. Pure: same inputs always produce the same
 * string; the current time is injected.
 */
export function renderMarkdownExport(
  medicines: ExportMedicine[],
  options: MarkdownExportOptions,
  now: Date,
): string {
  const escaped = medicines.map((medicine) => ({
    ...medicine,
    name: escapeMarkdownText(medicine.name),
    specification:
      medicine.specification === null ? null : escapeMarkdownText(medicine.specification),
    manufacturer:
      medicine.manufacturer === null ? null : escapeMarkdownText(medicine.manufacturer),
    approvalNumber:
      medicine.approvalNumber === null ? null : escapeMarkdownText(medicine.approvalNumber),
    purposeCategory:
      medicine.purposeCategory === null ? null : escapeMarkdownText(medicine.purposeCategory),
    leaflet: {
      ...medicine.leaflet,
      purposeSummary:
        medicine.leaflet.purposeSummary === null
          ? null
          : escapeMarkdownText(medicine.leaflet.purposeSummary),
      packageUsageSummary:
        medicine.leaflet.packageUsageSummary === null
          ? null
          : escapeMarkdownText(medicine.leaflet.packageUsageSummary),
      contraindicationsSummary:
        medicine.leaflet.contraindicationsSummary === null
          ? null
          : escapeMarkdownText(medicine.leaflet.contraindicationsSummary),
      precautionsSummary:
        medicine.leaflet.precautionsSummary === null
          ? null
          : escapeMarkdownText(medicine.leaflet.precautionsSummary),
      source:
        medicine.leaflet.source === null ? null : escapeMarkdownText(medicine.leaflet.source),
    },
    batches: medicine.batches.map((batch) => ({
      ...batch,
      lotNumber:
        batch.lotNumber === null ? null : escapeMarkdownText(batch.lotNumber),
      storageLocation:
        batch.storageLocation === null
          ? null
          : escapeMarkdownText(batch.storageLocation),
    })),
    dosageNotes: (medicine.dosageNotes ?? []).map((note) => ({
      ...note,
      content: escapeMarkdownText(note.content),
    })),
  }));

  const buckets: Record<ExportSection, typeof escaped> = {
    active: [],
    expired: [],
    exhausted: [],
    missing_date: [],
    archived: [],
  };
  for (const medicine of escaped) {
    buckets[partitionMedicine(medicine)].push(medicine);
  }

  const lines: string[] = [];
  lines.push("# 家庭药箱库存清单", "", `> ${DISCLAIMER}`, "");
  lines.push(`- 导出时间：${now.toISOString()}`);
  lines.push(`- 药品总数：${escaped.length}`);
  lines.push(
    options.includePersonalDosage
      ? "- 个人剂量备注：已包含（仅含你有权查看的备注）"
      : "- 个人剂量备注：未包含",
  );
  lines.push(
    options.includeStorageLocation
      ? "- 存放位置：已包含"
      : "- 存放位置：未包含",
  );

  const orderedSections: ExportSection[] = [
    "active",
    "expired",
    "exhausted",
    "missing_date",
    "archived",
  ];
  for (const section of orderedSections) {
    const bucket = buckets[section];
    if (bucket.length === 0) continue;
    if (section === "archived") {
      lines.push("", "## 已归档", "以下药品已归档，不计入日常库存管理。");
      for (const medicine of bucket) {
        lines.push(`### ${medicine.name}（已归档）`);
      }
      continue;
    }
    lines.push("", SECTION_HEADERS[section], SECTION_NOTES[section], "");
    for (const medicine of bucket) {
      lines.push(...renderMedicine(medicine, options, now), "");
    }
  }

  if (escaped.length === 0) {
    lines.push("", "## 在用库存", "药箱还没有记录，先从手动录入一盒药开始。");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
