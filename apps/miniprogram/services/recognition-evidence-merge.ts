import type {
  RecognitionEvidence, RecognitionEvidenceBatchSource, RecognitionEvidenceFieldSource,
  RecognitionEvidencePhoto, RecognitionEvidenceSave,
} from "./api-types";

/** Mapping refers to local review IDs, never array indices or guessed server IDs. */
export interface EvidenceUploadedPhoto {
  clientPhotoId: string;
  photoId: string;
  sequence: number;
  review: { status: RecognitionEvidencePhoto["status"]; fields: RecognitionEvidencePhoto["fields"]; warnings?: string[] };
}
export interface EvidenceMergeInput {
  existing: RecognitionEvidence | null;
  uploadedPhotos: EvidenceUploadedPhoto[];
  photoIdMap: Record<string, string>;
  /** photoIds in newly supplied sources are local clientPhotoIds. */
  fieldSources: Record<string, RecognitionEvidenceFieldSource>;
  batchSources: RecognitionEvidenceBatchSource[];
  revision: number;
  medicineVersion: number;
  idempotencyKey: string;
}
export type EvidenceMergeError = "INVALID_INPUT" | "REVISION_MISMATCH" | "INVALID_FIELD" | "INVALID_SOURCE" |
  "INVALID_BATCH_SOURCE" | "MISSING_PHOTO_MAPPING" | "PHOTO_CONFLICT" | "LIMIT_EXCEEDED";
export type EvidenceMergeResult = { ok: true; payload: RecognitionEvidenceSave } | { ok: false; reason: EvidenceMergeError };

const PHOTO_FIELDS = new Set(["name", "brand", "specification", "manufacturer", "approvalNumber", "barcodeValue",
  "activeIngredients", "purposeCategory", "lotNumber", "expiryValue", "expiryPrecision", "populationTags", "purposeTags",
  "leafletText", "rawOcrText", "purposeSummary", "packageUsageSummary", "contraindicationsSummary", "precautionsSummary"]);
const BATCH_ONLY_FIELDS = new Set(["lotNumber", "expiryValue", "expiryPrecision", "leafletText", "rawOcrText"]);
const ARRAY_FIELDS = new Set(["activeIngredients", "populationTags", "purposeTags"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_TYPES = new Set(["manual", "recognized", "catalog", "removed"]);

class MergeFailure extends Error {
  constructor(readonly reason: EvidenceMergeError) { super(reason); }
}
function fail(reason: EvidenceMergeError): never { throw new MergeFailure(reason); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bytes(value: string): number {
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) total++;
    else if (code < 0x800) total += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { total += 4; i++; }
    else total += 3;
  }
  return total;
}
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
function copyPhoto(raw: RecognitionEvidencePhoto, sequence: number): RecognitionEvidencePhoto {
  if (!raw || !UUID.test(raw.photoId) || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 1_000_000 ||
      !["pending", "recognized", "failed"].includes(raw.status) || !isRecord(raw.fields)) fail("INVALID_INPUT");
  if (Object.keys(raw).some(key => !["photoId", "sequence", "status", "fields", "warnings", "available"].includes(key))) fail("INVALID_FIELD");
  const fields: RecognitionEvidencePhoto["fields"] = {};
  for (const [key, value] of Object.entries(raw.fields)) {
    if (!PHOTO_FIELDS.has(key)) fail("INVALID_FIELD");
    if (key === "rawOcrText" && (typeof value !== "string" || value.length === 0)) fail("INVALID_FIELD");
    if (value !== null) {
      if (ARRAY_FIELDS.has(key)) {
        if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== "string" || bytes(item) > 1024)) fail("INVALID_FIELD");
      } else if (typeof value !== "string" || bytes(value) > 32 * 1024) fail("INVALID_FIELD");
    }
    fields[key] = Array.isArray(value) ? [...value] : value;
  }
  if (raw.warnings !== undefined && (!Array.isArray(raw.warnings) || raw.warnings.length > 20 ||
      raw.warnings.some(warning => typeof warning !== "string" || Array.from(warning).length > 500))) fail("INVALID_FIELD");
  const result: RecognitionEvidencePhoto = { photoId: raw.photoId.toLowerCase(), sequence, status: raw.status, fields,
    ...(raw.warnings === undefined ? {} : { warnings: [...raw.warnings] }) };
  if (bytes(JSON.stringify(result)) > 32 * 1024) fail("LIMIT_EXCEEDED");
  return result;
}

function valueKey(photo: RecognitionEvidencePhoto, field: string): string {
  const normalize = (value: string | string[] | null): string | string[] | null => {
    if (typeof value === "string") return value.trim();
    if (!Array.isArray(value)) return null;
    const values = value.map(item => item.trim());
    return field === "populationTags" || field === "purposeTags" ? [...new Set(values)].sort() : values;
  };
  return field === "expiry" ? JSON.stringify([normalize(photo.fields.expiryValue), normalize(photo.fields.expiryPrecision)]) :
    JSON.stringify(normalize(photo.fields[field]));
}
function copySource(raw: RecognitionEvidenceFieldSource, field: string,
  photos: Map<string, RecognitionEvidencePhoto>, map: Record<string, string> | null, batch = false): RecognitionEvidenceFieldSource {
  if (!raw || !SOURCE_TYPES.has(raw.source) || typeof raw.reviewed !== "boolean" || !Array.isArray(raw.photoIds) ||
      raw.photoIds.length > 100 || (raw.source === "recognized" ? raw.photoIds.length === 0 : raw.photoIds.length !== 0)) fail("INVALID_SOURCE");
  const allowed = batch ? ["source", "photoIds", "reviewed", "batchId", "historicalBatchRef", "field", "batchAvailable"] : ["source", "photoIds", "reviewed"];
  if (Object.keys(raw).some(key => !allowed.includes(key))) fail("INVALID_SOURCE");
  const ids: string[] = [];
  let selectedValue: string | undefined;
  for (const id of raw.photoIds) {
    if (typeof id !== "string") fail("INVALID_SOURCE");
    const mapped = map === null ? id : map[id];
    if (typeof mapped !== "string" || !UUID.test(mapped)) fail(map === null ? "INVALID_SOURCE" : "MISSING_PHOTO_MAPPING");
    const photoId = mapped.toLowerCase();
    const photo = photos.get(photoId);
    if (!photo || ids.includes(photoId) || photo.status !== "recognized" ||
        (field === "expiry" ? photo.fields.expiryValue == null || photo.fields.expiryPrecision == null : photo.fields[field] == null)) fail("INVALID_SOURCE");
    const value = valueKey(photo, field);
    if (selectedValue !== undefined && selectedValue !== value) fail("INVALID_SOURCE");
    selectedValue = value;
    ids.push(photoId);
  }
  return { source: raw.source, photoIds: ids, reviewed: raw.reviewed };
}

function batchKey(source: RecognitionEvidenceBatchSource): string {
  return source.batchId === null ? `history:${source.historicalBatchRef}:${source.field}` : `batch:${source.batchId}:${source.field}`;
}
function copyBatchSource(raw: RecognitionEvidenceBatchSource, photos: Map<string, RecognitionEvidencePhoto>,
  mapping: Record<string, string> | null, newSource: boolean): RecognitionEvidenceBatchSource {
  if (!raw || (raw.field !== "expiry" && raw.field !== "lotNumber")) fail("INVALID_BATCH_SOURCE");
  if (raw.batchId === null) {
    if (newSource || typeof raw.historicalBatchRef !== "string" || !UUID.test(raw.historicalBatchRef)) fail("INVALID_BATCH_SOURCE");
  } else if (typeof raw.batchId !== "string" || !UUID.test(raw.batchId) || raw.historicalBatchRef !== undefined) fail("INVALID_BATCH_SOURCE");
  if (newSource && Object.hasOwn(raw, "batchAvailable")) fail("INVALID_BATCH_SOURCE");
  const source = copySource(raw, raw.field, photos, mapping, true);
  return { batchId: raw.batchId === null ? null : raw.batchId.toLowerCase(),
    ...(raw.historicalBatchRef === undefined ? {} : { historicalBatchRef: raw.historicalBatchRef.toLowerCase() }),
    field: raw.field, ...source };
}

/** Builds an immutable request; the server still checks current values, rights and concurrency. */
export function mergeRecognitionEvidence(input: EvidenceMergeInput): EvidenceMergeResult {
  try {
    if (!input || !Array.isArray(input.uploadedPhotos) || !Array.isArray(input.batchSources) || !isRecord(input.photoIdMap) ||
        !isRecord(input.fieldSources) || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision > 2_147_483_646 ||
        !Number.isSafeInteger(input.medicineVersion) || input.medicineVersion < 1 || input.medicineVersion > 2_147_483_647 ||
        typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)) fail("INVALID_INPUT");
    const existing = input.existing;
    if ((existing?.revision ?? 0) !== input.revision) fail("REVISION_MISMATCH");
    if (existing && (existing.schemaVersion !== 1 || !Array.isArray(existing.photos) || !isRecord(existing.fieldSources) ||
        (existing.batchSources !== undefined && !Array.isArray(existing.batchSources)))) fail("INVALID_INPUT");
    const photos: RecognitionEvidencePhoto[] = [];
    const photoMap = new Map<string, RecognitionEvidencePhoto>();
    const sequences = new Set<number>();
    for (const raw of existing?.photos ?? []) {
      const photo = copyPhoto(raw, raw.sequence);
      if (photoMap.has(photo.photoId) || sequences.has(photo.sequence)) fail("PHOTO_CONFLICT");
      photos.push(photo); photoMap.set(photo.photoId, photo); sequences.add(photo.sequence);
    }
    const sequenceBase = Math.max(0, ...sequences);
    const clientIds = new Set<string>();
    const localSequences = new Set<number>();
    for (const raw of [...input.uploadedPhotos].sort((a, b) => a.sequence - b.sequence)) {
      if (!raw || typeof raw.clientPhotoId !== "string" || !raw.clientPhotoId || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1 ||
          clientIds.has(raw.clientPhotoId) || localSequences.has(raw.sequence) || !raw.review) fail("PHOTO_CONFLICT");
      const mapped = input.photoIdMap[raw.clientPhotoId];
      if (typeof mapped !== "string" || !UUID.test(mapped) || typeof raw.photoId !== "string" || mapped.toLowerCase() !== raw.photoId.toLowerCase()) fail("MISSING_PHOTO_MAPPING");
      if (photoMap.has(mapped.toLowerCase())) fail("PHOTO_CONFLICT");
      const photo = copyPhoto({ photoId: mapped, sequence: 1, status: raw.review.status, fields: raw.review.fields,
        ...(raw.review.warnings === undefined ? {} : { warnings: raw.review.warnings }) }, sequenceBase + raw.sequence);
      clientIds.add(raw.clientPhotoId); localSequences.add(raw.sequence); photos.push(photo); photoMap.set(photo.photoId, photo);
    }
    if (photos.length > 100) fail("LIMIT_EXCEEDED");
    const fieldSources: Record<string, RecognitionEvidenceFieldSource> = {};
    for (const [field, source] of Object.entries(existing?.fieldSources ?? {})) {
      // Historical unbound fields can only be carried over verbatim; the API
      // keeps them stale and rejects creating or modifying those old claims.
      if (!PHOTO_FIELDS.has(field) || field === "rawOcrText") fail("INVALID_FIELD");
      fieldSources[field] = copySource(source, field, photoMap, null);
    }
    for (const [field, source] of Object.entries(input.fieldSources)) {
      if (!PHOTO_FIELDS.has(field) || BATCH_ONLY_FIELDS.has(field)) fail("INVALID_FIELD");
      fieldSources[field] = copySource(source, field, photoMap, input.photoIdMap);
    }
    const batchSources: RecognitionEvidenceBatchSource[] = [];
    const batchIndices = new Map<string, number>();
    for (const raw of existing?.batchSources ?? []) {
      const source = copyBatchSource(raw, photoMap, null, false);
      const key = batchKey(source);
      if (batchIndices.has(key)) fail("INVALID_BATCH_SOURCE");
      batchIndices.set(key, batchSources.length); batchSources.push(source);
    }
    const incoming = new Set<string>();
    for (const raw of input.batchSources) {
      const source = copyBatchSource(raw, photoMap, input.photoIdMap, true);
      const key = batchKey(source);
      if (incoming.has(key)) fail("INVALID_BATCH_SOURCE");
      incoming.add(key);
      const index = batchIndices.get(key);
      if (index === undefined) { batchIndices.set(key, batchSources.length); batchSources.push(source); }
      else batchSources[index] = source;
    }
    if (batchSources.length > 1000) fail("LIMIT_EXCEEDED");
    const document = { schemaVersion: 1 as const, photos, fieldSources,
      ...(existing?.batchSources !== undefined || input.batchSources.length > 0 ? { batchSources } : {}) };
    if (bytes(JSON.stringify(document)) > 256 * 1024) fail("LIMIT_EXCEEDED");
    return { ok: true, payload: freezeDeep({ ...document, revision: input.revision,
      medicineVersion: input.medicineVersion, idempotencyKey: input.idempotencyKey }) };
  } catch (error) {
    return { ok: false, reason: error instanceof MergeFailure ? error.reason : "INVALID_INPUT" };
  }
}
