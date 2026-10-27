import { createHash } from "node:crypto";
import type {
  RecognitionEvidence, RecognitionEvidenceDocument, RecognitionEvidenceField,
  RecognitionEvidenceBatchSource, RecognitionEvidenceFieldSource, RecognitionEvidencePhoto, RecognitionEvidenceSaveRequest,
} from "@home-medicine/contracts";
import type { QueryRunner } from "../types.js";
import { parseJsonArray } from "../types.js";
import type { MedicineRow } from "../repositories/medicines.js";

export const MAX_EVIDENCE_BYTES = 256 * 1024;
export const MAX_EVIDENCE_PHOTO_BYTES = 32 * 1024;
const FIELDS = ["name", "brand", "specification", "manufacturer", "approvalNumber", "barcodeValue",
  "activeIngredients", "purposeCategory", "lotNumber", "expiryValue", "expiryPrecision",
  "populationTags", "purposeTags", "leafletText", "rawOcrText", "purposeSummary", "packageUsageSummary",
  "contraindicationsSummary", "precautionsSummary"] as const satisfies readonly RecognitionEvidenceField[];
const FIELD_SET = new Set<string>(FIELDS);
const ARRAY_FIELDS = new Set<string>(["activeIngredients", "populationTags", "purposeTags"]);
const LEGACY_MEDICINE_FIELDS = new Set<string>(["lotNumber", "expiryValue", "expiryPrecision", "leafletText", "rawOcrText"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Strict whitelist, with no truncation, applies equally to requests and imported backups. */
export function validateRecognitionEvidenceDocument(value: unknown): RecognitionEvidenceDocument | null {
  if (!record(value) || !onlyKeys(value, ["schemaVersion", "photos", "fieldSources", "batchSources"]) ||
      value.schemaVersion !== 1 || !Array.isArray(value.photos) || value.photos.length > 100 || !record(value.fieldSources)) return null;
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const photos: RecognitionEvidencePhoto[] = [];
  for (const raw of value.photos) {
    if (!record(raw) || !onlyKeys(raw, ["photoId", "sequence", "status", "fields", "warnings"]) ||
        typeof raw.photoId !== "string" || !UUID.test(raw.photoId) ||
        !integer(raw.sequence, 1, 1_000_000) ||
        (raw.status !== "pending" && raw.status !== "recognized" && raw.status !== "failed") || !record(raw.fields)) return null;
    const photoId = raw.photoId.toLowerCase();
    if (ids.has(photoId) || numbers.has(raw.sequence)) return null;
    ids.add(photoId);
    numbers.add(raw.sequence);
    const fields: RecognitionEvidencePhoto["fields"] = {};
    for (const key of Object.keys(raw.fields).sort()) {
      if (!FIELD_SET.has(key)) return null;
      const item = raw.fields[key];
      if (key === "rawOcrText" && (typeof item !== "string" || item.length === 0)) return null;
      if (item !== null && (ARRAY_FIELDS.has(key)
        ? !Array.isArray(item) || item.length > 32 || item.some((s: unknown) => typeof s !== "string" || Buffer.byteLength(s, "utf8") > 1024)
        : typeof item !== "string" || Buffer.byteLength(item, "utf8") > MAX_EVIDENCE_PHOTO_BYTES)) return null;
      fields[key as RecognitionEvidenceField] = item as string | string[] | null;
    }
    if (raw.warnings !== undefined && (!Array.isArray(raw.warnings) || raw.warnings.length > 20 ||
        raw.warnings.some((warning: unknown) => typeof warning !== "string" || Array.from(warning).length > 500))) return null;
    const photo: RecognitionEvidencePhoto = { photoId, sequence: raw.sequence, status: raw.status, fields,
      ...(raw.warnings === undefined ? {} : { warnings: raw.warnings as string[] }) };
    if (size(photo) > MAX_EVIDENCE_PHOTO_BYTES) return null;
    photos.push(photo);
  }
  const fieldSources: RecognitionEvidenceDocument["fieldSources"] = {};
  for (const key of Object.keys(value.fieldSources).sort()) {
    if (!FIELD_SET.has(key) || key === "rawOcrText") return null;
    const raw = value.fieldSources[key];
    if (!record(raw) || !onlyKeys(raw, ["source", "photoIds", "reviewed"]) ||
        (raw.source !== "manual" && raw.source !== "recognized" && raw.source !== "catalog" && raw.source !== "removed") ||
        !Array.isArray(raw.photoIds) || typeof raw.reviewed !== "boolean" ||
        raw.photoIds.length > 100 || (raw.source === "recognized" ? raw.photoIds.length === 0 : raw.photoIds.length !== 0)) return null;
    const photoIds: string[] = [];
    for (const item of raw.photoIds) {
      if (typeof item !== "string" || !UUID.test(item)) return null;
      const photoId = item.toLowerCase();
      if (!ids.has(photoId) || photoIds.includes(photoId)) return null;
      const photo = photos.find((entry) => entry.photoId === photoId);
      if (!photo || photo.status !== "recognized" || photo.fields[key as RecognitionEvidenceField] == null) return null;
      photoIds.push(photoId);
    }
    fieldSources[key as RecognitionEvidenceField] = { source: raw.source, photoIds, reviewed: raw.reviewed } satisfies RecognitionEvidenceFieldSource;
  }
  let batchSources: RecognitionEvidenceBatchSource[] | undefined;
  if (value.batchSources !== undefined) {
    if (!Array.isArray(value.batchSources) || value.batchSources.length > 1000) return null;
    batchSources = [];
    const seen = new Set<string>();
    for (const raw of value.batchSources) {
      if (!record(raw) || !onlyKeys(raw, ["batchId", "historicalBatchRef", "field", "source", "photoIds", "reviewed"]) ||
          (raw.field !== "expiry" && raw.field !== "lotNumber") ||
          (raw.source !== "manual" && raw.source !== "recognized" && raw.source !== "catalog" && raw.source !== "removed") ||
          typeof raw.reviewed !== "boolean" || !Array.isArray(raw.photoIds) || raw.photoIds.length > 100 ||
          (raw.source === "recognized" ? raw.photoIds.length === 0 : raw.photoIds.length !== 0)) return null;
      let batchId: string | null;
      let historicalBatchRef: string | undefined;
      if (typeof raw.batchId === "string" && UUID.test(raw.batchId) && raw.historicalBatchRef === undefined) {
        batchId = raw.batchId.toLowerCase();
      } else if (raw.batchId === null && typeof raw.historicalBatchRef === "string" && UUID.test(raw.historicalBatchRef)) {
        batchId = null;
        historicalBatchRef = raw.historicalBatchRef.toLowerCase();
      } else return null;
      const identity = `${batchId === null ? "history:" + historicalBatchRef : "batch:" + batchId}:${raw.field}`;
      if (seen.has(identity)) return null;
      seen.add(identity);
      const photoIds: string[] = [];
      for (const item of raw.photoIds) {
        if (typeof item !== "string" || !UUID.test(item)) return null;
        const photoId = item.toLowerCase();
        const photo = photos.find((entry) => entry.photoId === photoId);
        if (!photo || photoIds.includes(photoId) || photo.status !== "recognized" ||
            (raw.field === "expiry" ? photo.fields.expiryValue == null || photo.fields.expiryPrecision == null : photo.fields.lotNumber == null)) return null;
        photoIds.push(photoId);
      }
      batchSources.push({ batchId, ...(historicalBatchRef === undefined ? {} : { historicalBatchRef }),
        field: raw.field, source: raw.source, photoIds, reviewed: raw.reviewed });
    }
  }
  const document: RecognitionEvidenceDocument = { schemaVersion: 1, photos, fieldSources,
    ...(batchSources === undefined ? {} : { batchSources }) };
  return size(document) <= MAX_EVIDENCE_BYTES ? document : null;
}

export function validateRecognitionEvidenceSave(value: unknown): RecognitionEvidenceSaveRequest | null {
  if (!record(value) || !onlyKeys(value, ["schemaVersion", "photos", "fieldSources", "batchSources", "revision", "medicineVersion", "idempotencyKey"]) ||
      !integer(value.revision, 0, 2_147_483_646) || !integer(value.medicineVersion, 1, 2_147_483_647) ||
      typeof value.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value.idempotencyKey)) return null;
  const document = validateRecognitionEvidenceDocument({ schemaVersion: value.schemaVersion, photos: value.photos, fieldSources: value.fieldSources,
    ...(value.batchSources === undefined ? {} : { batchSources: value.batchSources }) });
  return document ? { ...document, revision: value.revision, medicineVersion: value.medicineVersion, idempotencyKey: value.idempotencyKey } : null;
}

export function recognitionEvidenceHash(value: RecognitionEvidenceSaveRequest): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function hasLegacyMedicineSources(document: RecognitionEvidenceDocument): boolean {
  return Object.keys(document.fieldSources).some((field) => LEGACY_MEDICINE_FIELDS.has(field));
}

export interface EvidenceBatchRow {
  id: string;
  lot_number: string | null;
  expiry_value: string | null;
  expiry_precision: string;
}

export async function loadEvidenceBatches(database: QueryRunner, familyId: string, medicineId: string,
  document: RecognitionEvidenceDocument): Promise<Map<string, EvidenceBatchRow>> {
  const ids = [...new Set((document.batchSources ?? []).flatMap((source) => source.batchId === null ? [] : [source.batchId]))];
  if (ids.length === 0) return new Map();
  const rows = await database.query<EvidenceBatchRow>(
    `SELECT id, lot_number, expiry_value, expiry_precision FROM medicine_batches
      WHERE family_id = $1 AND medicine_id = $2 AND id = ANY($3::uuid[]) AND deleted_at IS NULL`,
    [familyId, medicineId, ids],
  );
  return new Map(rows.rows.map((row) => [row.id, row]));
}

function batchSourceKey(source: RecognitionEvidenceBatchSource): string {
  return `${source.batchId === null ? "history:" + source.historicalBatchRef : "batch:" + source.batchId}:${source.field}`;
}

/** Existing selections can be explicitly replaced, but not silently omitted. */
export function sourceKeysPreserved(previous: RecognitionEvidenceDocument | undefined, document: RecognitionEvidenceDocument): boolean {
  if (!previous) return true;
  if (Object.keys(previous.fieldSources).some((key) => !Object.prototype.hasOwnProperty.call(document.fieldSources, key))) return false;
  const keys = new Set((document.batchSources ?? []).map(batchSourceKey));
  return (previous.batchSources ?? []).every((source) => keys.has(batchSourceKey(source)));
}

/** Old unbound medicine-level batch claims are retained unchanged and stay stale. */
export function legacyMedicineSourcesPreserved(previous: RecognitionEvidenceDocument | undefined, document: RecognitionEvidenceDocument): boolean {
  for (const [key, current] of Object.entries(document.fieldSources)) {
    if (!LEGACY_MEDICINE_FIELDS.has(key)) continue;
    const old = previous?.fieldSources[key as RecognitionEvidenceField];
    if (!old || old.source !== current.source || old.reviewed !== current.reviewed ||
        old.photoIds.length !== current.photoIds.length || old.photoIds.some((id, index) => id !== current.photoIds[index])) return false;
  }
  return true;
}

export function batchSourcesMatch(document: RecognitionEvidenceDocument, batches: ReadonlyMap<string, EvidenceBatchRow>,
  photoBatchIds: ReadonlyMap<string, string | null>): boolean {
  const photos = new Map(document.photos.map((photo) => [photo.photoId, photo]));
  for (const source of document.batchSources ?? []) {
    const batch = source.batchId === null ? undefined : batches.get(source.batchId);
    if (!batch || source.source !== "recognized") continue;
    for (const id of source.photoIds) {
      const photo = photos.get(id);
      if (!photo || photo.status !== "recognized") return false;
      const boundBatch = photoBatchIds.get(id);
      if (boundBatch != null && boundBatch !== source.batchId) return false;
      if (source.field === "expiry") {
        const value = photo.fields.expiryValue;
        const precision = photo.fields.expiryPrecision;
        if (typeof value !== "string" || typeof precision !== "string" ||
            value.trim() !== batch.expiry_value?.trim() || precision.trim() !== batch.expiry_precision.trim()) return false;
      } else {
        const value = photo.fields.lotNumber;
        if (typeof value !== "string" || value.trim() !== batch.lot_number?.trim()) return false;
      }
    }
  }
  return true;
}

export function batchSourcesPreserveHistory(
  previous: RecognitionEvidenceDocument | undefined,
  document: RecognitionEvidenceDocument,
  batches: ReadonlyMap<string, EvidenceBatchRow>,
  availableIds: ReadonlySet<string>,
): "ok" | "invalid" | "conflict" {
  const old = new Map((previous?.batchSources ?? []).map((source) => [batchSourceKey(source), source]));
  for (const source of document.batchSources ?? []) {
    const prior = old.get(batchSourceKey(source));
    const unavailableBatch = source.batchId === null || !batches.has(source.batchId);
    if (unavailableBatch) {
      if (!prior) return "invalid";
      if ((source.reviewed && !prior.reviewed) || (source.source === "recognized" &&
          (prior.source !== "recognized" || source.photoIds.some((id) => !prior.photoIds.includes(id))))) return "conflict";
    }
    if (source.source === "recognized" && source.photoIds.some((id) => !availableIds.has(id))) {
      if (!prior || prior.source !== "recognized" || (source.reviewed && !prior.reviewed) ||
          source.photoIds.some((id) => !availableIds.has(id) && !prior.photoIds.includes(id))) return "conflict";
    }
  }
  return "ok";
}

function normalizedValue(value: string | string[] | null, field: RecognitionEvidenceField): string | string[] | null {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return null;
  const trimmed = value.map((item) => item.trim());
  return field === "populationTags" || field === "purposeTags" ? [...new Set(trimmed)].sort() : trimmed;
}

/** Only selected sources are claims; unselected OCR candidates remain untouched. */
export function recognizedSourcesMatchMedicine(document: RecognitionEvidenceDocument, medicine: MedicineRow): boolean {
  const actual: Partial<Record<RecognitionEvidenceField, string | string[] | null>> = {
    name: medicine.name, brand: medicine.brand ?? null, specification: medicine.specification,
    manufacturer: medicine.manufacturer, approvalNumber: medicine.approval_number,
    barcodeValue: medicine.barcode_value, activeIngredients: parseJsonArray(medicine.active_ingredients),
    purposeCategory: medicine.purpose_category, populationTags: medicine.population_tags ?? [],
    purposeTags: medicine.purpose_tags ?? [], purposeSummary: medicine.leaflet_purpose_summary,
    packageUsageSummary: medicine.leaflet_package_usage_summary,
    contraindicationsSummary: medicine.leaflet_contraindications_summary,
    precautionsSummary: medicine.leaflet_precautions_summary,
  };
  const photos = new Map(document.photos.map((photo) => [photo.photoId, photo]));
  for (const [key, source] of Object.entries(document.fieldSources)) {
    if (source.source !== "recognized") continue;
    const field = key as RecognitionEvidenceField;
    let first: string | undefined;
    for (const id of source.photoIds) {
      const photo = photos.get(id);
      const candidate = photo?.fields[field];
      if (!photo || photo.status !== "recognized" || candidate == null) return false;
      const normalized = JSON.stringify(normalizedValue(candidate, field));
      if (first !== undefined && normalized !== first) return false;
      if (Object.prototype.hasOwnProperty.call(actual, field) && normalized !== JSON.stringify(normalizedValue(actual[field] ?? null, field))) return false;
      first = normalized;
    }
    if (first === undefined) return false;
  }
  return true;
}

/** Deleted/unrestored originals may preserve old claims but cannot create new ones. */
export function unavailableSourcesPreserveHistory(
  previous: RecognitionEvidenceDocument | undefined,
  document: RecognitionEvidenceDocument,
  availableIds: ReadonlySet<string>,
): boolean {
  for (const [key, source] of Object.entries(document.fieldSources)) {
    if (source.source !== "recognized") continue;
    const unavailable = source.photoIds.filter((id) => !availableIds.has(id));
    if (unavailable.length === 0) continue;
    const old = previous?.fieldSources[key as RecognitionEvidenceField];
    if (!old || old.source !== "recognized" || unavailable.some((id) => !old.photoIds.includes(id)) ||
        (source.reviewed && !old.reviewed)) return false;
  }
  return true;
}

export interface EvidenceRow {
  revision: number;
  medicine_version: number | null;
  document: RecognitionEvidenceDocument;
}

export async function evidenceResponse(
  database: QueryRunner, familyId: string, medicineId: string, medicine: MedicineRow, row: EvidenceRow,
): Promise<RecognitionEvidence> {
  const ids = row.document.photos.map((photo) => photo.photoId);
  const available = ids.length === 0 ? [] : (await database.query<{ id: string; batch_id: string | null }>(
    `SELECT id, batch_id FROM medicine_leaflet_photos WHERE family_id = $1 AND medicine_id = $2
       AND id = ANY($3::uuid[]) AND deleted_at IS NULL AND upload_completed_at IS NOT NULL AND storage_removed_at IS NULL`,
    [familyId, medicineId, ids],
  )).rows;
  const availableIds = new Set(available.map((photo) => photo.id));
  const photoBatchIds = new Map(available.map((photo) => [photo.id, photo.batch_id]));
  const unavailableSource = Object.values(row.document.fieldSources).some((source) => source.source === "recognized" &&
    source.photoIds.some((id) => !availableIds.has(id)));
  const batches = await loadEvidenceBatches(database, familyId, medicineId, row.document);
  const unavailableBatch = (row.document.batchSources ?? []).some((source) => source.batchId === null || !batches.has(source.batchId) ||
    (source.source === "recognized" && source.photoIds.some((id) => !availableIds.has(id))));
  return {
    schemaVersion: 1,
    revision: row.revision,
    medicineVersion: row.medicine_version,
    currentMedicineVersion: medicine.version,
    stale: row.medicine_version === null || row.medicine_version !== medicine.version || unavailableSource || unavailableBatch ||
      hasLegacyMedicineSources(row.document) || !recognizedSourcesMatchMedicine(row.document, medicine) || !batchSourcesMatch(row.document, batches, photoBatchIds),
    photos: row.document.photos.map((photo) => ({ ...photo, available: availableIds.has(photo.photoId) })),
    fieldSources: row.document.fieldSources,
    ...(row.document.batchSources === undefined ? {} : { batchSources: row.document.batchSources.map((source) => ({
      ...source, batchAvailable: source.batchId !== null && batches.has(source.batchId),
    })) }),
  };
}
