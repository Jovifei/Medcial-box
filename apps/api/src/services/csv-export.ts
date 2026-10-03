import type { InventoryExportSnapshot } from "./export-snapshot.js";

export const EXPORT_COLUMNS = ["药品", "规格", "厂家", "批准文号", "条码", "成分", "用途", "人群标签", "用途标签", "标签来源", "归档", "库存状态", "低库存阈值", "批次", "数量", "单位", "包装换算数量", "换算目标单位", "位置", "包装有效期", "日期精度", "开封状态", "开封日期", "开封期限", "开封到期日", "管理到期日", "处理状态", "说明书用途", "包装用法", "禁忌", "注意事项", "说明书来源", "核对状态", "可见个人备注"];

export function inventoryExportRows(snapshot: InventoryExportSnapshot): string[][] {
 return snapshot.medicines.flatMap((medicine) => (medicine.batches.length === 0 ? [null] : medicine.batches).map((batch) => [
  medicine.name, medicine.specification ?? "", medicine.manufacturer ?? "", medicine.approvalNumber ?? "", medicine.barcodeValue ?? "", medicine.activeIngredients.join("；"), medicine.purposeCategory ?? "", (medicine.populationTags ?? []).join("；"), (medicine.purposeTags ?? []).join("；"), medicine.tagSource ?? "", medicine.isArchived ? "是" : "否", medicine.stockStatus?.state ?? "unknown", medicine.lowStockThreshold ? `${medicine.lowStockThreshold.quantity} ${medicine.lowStockThreshold.unit}` : "",
  batch?.lotNumber ?? "", batch?.quantity === null || batch === null ? "未知" : String(batch.quantity), batch?.unit ?? "", batch?.confirmedUnitsPerPackage == null ? "" : String(batch.confirmedUnitsPerPackage), batch?.conversionUnit ?? (batch?.unit === "box" && batch.confirmedUnitsPerPackage !== null ? "tablet" : ""), snapshot.options.includeStorageLocation ? batch?.storageLocation ?? "" : "", batch?.expiry.value ?? "", batch?.expiry.precision ?? "unknown", batch?.openedState ?? "unknown", batch?.openedAt ?? "", batch?.afterOpeningLimit ? JSON.stringify(batch.afterOpeningLimit) : "", batch?.openedExpiryDate ?? "", batch?.managementExpiryDate ?? "", batch?.dispositionStatus ?? "",
  medicine.leaflet.purposeSummary ?? "", medicine.leaflet.packageUsageSummary ?? "", medicine.leaflet.contraindicationsSummary ?? "", medicine.leaflet.precautionsSummary ?? "", medicine.leaflet.source ?? "", medicine.leaflet.reviewStatus,
  snapshot.options.includePersonalDosage ? (medicine.dosageNotes ?? []).map((note) => note.content).join("；") : "",
 ]));
}

/** Quote every field; neutralize spreadsheet formula prefixes including whitespace. */
export function csvCell(value: string): string {
 const prefix = [...value].find((character) => character.charCodeAt(0) > 31 && !/\s/.test(character));
 const safe = prefix !== undefined && "=+@-".includes(prefix) ? `'${value}` : value;
 return `"${safe.replaceAll('"', '""')}"`;
}
export function renderCsvExport(snapshot: InventoryExportSnapshot): string {
 return "\ufeff" + [EXPORT_COLUMNS, ...inventoryExportRows(snapshot)].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
