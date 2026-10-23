import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { MedicineCandidate } from "@home-medicine/contracts";
import type { MedicineCatalogProvider, MedicineCatalogQuery } from "./medicine-catalog.js";
import { MedicineCatalogUnavailableError } from "./medicine-catalog.js";

export const LOCAL_CATALOG_MAX_BYTES = 5 * 1024 * 1024;
export interface LocalCatalogEntry {
  barcodeValue: string; name: string; brand?: string | null; specification?: string | null;
  manufacturer?: string | null; approvalNumber?: string | null; activeIngredients?: string[];
  source: string; sourceUpdatedAt?: string | null; reviewed: true;
}
export interface LocalCatalogDocument { version: 1; entries: LocalCatalogEntry[] }
const allowed = new Set(["barcodeValue", "name", "brand", "specification", "manufacturer", "approvalNumber", "activeIngredients", "source", "sourceUpdatedAt", "reviewed"]);
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function validateLocalCatalog(value: unknown): LocalCatalogDocument {
  if (!record(value) || value.version !== 1 || Object.keys(value).some(key => !["version", "entries"].includes(key)) || !Array.isArray(value.entries) || value.entries.length > 10000) throw new Error("商品资料库格式不正确");
  const barcodes = new Set<string>();
  const entries = value.entries.map(item => {
    if (!record(item) || Object.keys(item).some(key => !allowed.has(key)) || item.reviewed !== true) throw new Error("商品资料必须人工审核且不得包含家庭资料");
    for (const key of ["barcodeValue", "name", "source"]) if (typeof item[key] !== "string" || !item[key].trim() || item[key].length > 300) throw new Error("商品资料缺少标识或来源");
    const barcode = (item.barcodeValue as string).trim();
    if (!/^[0-9]{8,14}$/.test(barcode) || barcodes.has(barcode)) throw new Error("商品条码无效或重复");
    barcodes.add(barcode);
    for (const key of ["brand", "specification", "manufacturer", "approvalNumber", "sourceUpdatedAt"]) if (item[key] !== undefined && item[key] !== null && (typeof item[key] !== "string" || item[key].length > 300)) throw new Error("商品文字字段格式不正确");
    if (item.activeIngredients !== undefined && (!Array.isArray(item.activeIngredients) || item.activeIngredients.length > 30 || item.activeIngredients.some(part => typeof part !== "string" || part.length > 300))) throw new Error("商品成分格式不正确");
    return { ...item, barcodeValue: barcode, name: (item.name as string).trim(), source: (item.source as string).trim() } as unknown as LocalCatalogEntry;
  });
  return { version: 1, entries };
}
export async function readLocalCatalog(file: string): Promise<LocalCatalogDocument> {
  if (!isAbsolute(file)) throw new Error("商品资料库路径必须为绝对路径");
  if ((await stat(file)).size > LOCAL_CATALOG_MAX_BYTES) throw new Error("商品资料库超过5MB");
  const bytes = await readFile(file);
  if (bytes.length > LOCAL_CATALOG_MAX_BYTES) throw new Error("商品资料库超过5MB");
  return validateLocalCatalog(JSON.parse(bytes.toString("utf8")) as unknown);
}
export function localCandidate(entry: LocalCatalogEntry, matchReasons = ["条码精确一致，仍请核对包装"]): MedicineCandidate {
  return { name: entry.name, barcodeValue: entry.barcodeValue, brand: entry.brand ?? null, specification: entry.specification ?? null, manufacturer: entry.manufacturer ?? null, approvalNumber: entry.approvalNumber ?? null, activeIngredients: entry.activeIngredients ?? [], leaflet: null, source: entry.source, sourceUpdatedAt: entry.sourceUpdatedAt ?? null, matchReasons };
}
export class LocalMedicineCatalogProvider implements MedicineCatalogProvider {
  readonly kind = "local" as const;
  constructor(private readonly file = "") {}
  async search(query: MedicineCatalogQuery) {
    let document: LocalCatalogDocument;
    try { document = this.file ? await readLocalCatalog(this.file) : { version: 1, entries: [] }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") document = { version: 1, entries: [] };
      else throw new MedicineCatalogUnavailableError("local catalog is invalid");
    }
    const matches = document.entries.filter(item => {
      if (query.barcode) return item.barcodeValue === query.barcode.trim();
      if (!query.name && !query.manufacturer && !query.approvalNumber) return false;
      return (!query.name || item.name.toLocaleLowerCase().includes(query.name.trim().toLocaleLowerCase())) &&
        (!query.manufacturer || item.manufacturer === query.manufacturer.trim()) &&
        (!query.approvalNumber || item.approvalNumber === query.approvalNumber.trim()) &&
        (!query.specification || item.specification === query.specification.trim());
    }).slice(0, 5);
    const reasons = query.barcode ? ["条码精确一致，仍请核对包装"] : ["名称或商品标识匹配，请核对厂家和规格"];
    return { candidates: matches.map(entry => localCandidate(entry, reasons)), warnings: [matches.length ? "本机人工审核商品资料仍需对照当前包装核验。" : "本机商品资料库尚未收录，请拍照识别或手动填写；不会联网猜测。"] };
  }
}
