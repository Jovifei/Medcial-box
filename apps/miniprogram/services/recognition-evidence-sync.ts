import { api, captureSessionIdentity, isCurrentSession } from "./api";
import { readSessionScope, scopedStorageKey } from "./session-scope";
import type { LeafletPhotoSummary, MedicationSummary, RecognitionEvidence, RecognitionEvidenceSave } from "./api-types";

export type EvidenceSyncReason = "unsupported" | "network" | "conflict" | "stale" | "receipt_mismatch" |
  "capability_unconfirmed" | "storage_error" | "identity_changed" | "rejected" | "recovery_required" |
  "source_changed" | "photo_unavailable" | "batch_unavailable" | "version_changed" | "current_unavailable";
export interface EvidenceSyncResult {
  status: "synced" | "pending" | "existing" | "storage_failed" | "identity_changed";
  reason?: EvidenceSyncReason;
  acknowledged?: boolean;
}
export interface PendingRecognitionEvidence {
  medicineId: string;
  payload: RecognitionEvidenceSave;
  previousPayloads?: RecognitionEvidenceSave[];
  acknowledgement?: { revision: number; medicineVersion: number };
}

const NAMESPACE = "recognition-evidence-pending-v1";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function keyFor(medicineId: string): string | null {
  const scope = readSessionScope();
  return scope?.userId && scope.familyId && medicineId ? scopedStorageKey(NAMESPACE, medicineId) : null;
}

function readRecord(key: string): PendingRecognitionEvidence | null {
  const value = wx.getStorageSync(key) as unknown;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid pending evidence");
  const record = value as PendingRecognitionEvidence;
  if (typeof record.medicineId !== "string" || !record.payload || typeof record.payload !== "object" ||
      record.payload.schemaVersion !== 1 || typeof record.payload.idempotencyKey !== "string") throw new Error("invalid pending evidence");
  // Do not expose a mutable reference to durable storage or another page's intent.
  return JSON.parse(JSON.stringify(record)) as PendingRecognitionEvidence;
}

/** Returns only the current household's record; storage failures throw rather than hide a pending write. */
export function getPendingRecognitionEvidence(medicineId: string): PendingRecognitionEvidence | null {
  const key = keyFor(medicineId);
  return key ? readRecord(key) : null;
}

/** Content equivalence only: caller must separately verify identity and the POST outcome. */
export function recognitionEvidenceReceiptMatches(payload: RecognitionEvidenceSave, evidence: RecognitionEvidence | null): boolean {
  return receiptMatchesIntent(payload, evidence) && evidence?.stale === false && evidence.currentMedicineVersion === payload.medicineVersion;
}

function receiptMatchesIntent(payload: RecognitionEvidenceSave, evidence: RecognitionEvidence | null): boolean {
  if (!evidence || evidence.schemaVersion !== 1 || evidence.revision !== payload.revision + 1 ||
      evidence.medicineVersion !== payload.medicineVersion || typeof evidence.currentMedicineVersion !== "number") return false;
  if (!Array.isArray(evidence.photos) || (evidence.batchSources !== undefined && !Array.isArray(evidence.batchSources))) return false;
  try {
    const photos = evidence.photos.map(photo => {
      const saved: Record<string, unknown> = { ...photo };
      delete saved.available;
      return saved;
    });
    const expected = { schemaVersion: payload.schemaVersion, photos: payload.photos, fieldSources: payload.fieldSources,
      ...(payload.batchSources === undefined ? {} : { batchSources: payload.batchSources }) };
    const batchSources = evidence.batchSources?.map(source => {
      const saved: Record<string, unknown> = { ...source };
      delete saved.batchAvailable;
      return saved;
    });
    const actual = { schemaVersion: evidence.schemaVersion, photos, fieldSources: evidence.fieldSources,
      ...(batchSources === undefined ? {} : { batchSources }) };
    return canonical(expected) === canonical(actual);
  } catch { return false; }
}

function failureReason(error: unknown): EvidenceSyncReason {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  if (status === 404) return "unsupported";
  if (status === 409) return "conflict";
  if (typeof status === "number" && status >= 400 && status < 500) return "rejected";
  return "network";
}

/** Attempts exactly the persisted intent; later edits never change its idempotency key or body. */
async function attempt(medicineId: string, key: string, record: PendingRecognitionEvidence): Promise<EvidenceSyncResult> {
  const identity = captureSessionIdentity();
  const scope = readSessionScope();
  const current = (): boolean => isCurrentSession(identity) && keyFor(medicineId) === key &&
    scope !== null && readSessionScope()?.userId === scope.userId && readSessionScope()?.familyId === scope.familyId;
  if (!identity.token || !current()) return { status: "identity_changed", reason: "identity_changed" };
  let capability: Awaited<ReturnType<typeof api.getRecognitionEvidence>>;
  try {
    capability = await api.getRecognitionEvidence(medicineId);
  } catch (error) {
    if (!current()) return { status: "identity_changed", reason: "identity_changed" };
    return { status: "pending", reason: failureReason(error) };
  }
  try {
    if (!current()) return { status: "identity_changed", reason: "identity_changed" };
    if (capability.capabilities?.coverPhotoVersionGuard !== true) return { status: "pending", reason: "capability_unconfirmed" };
    // Re-read just before sending: another view must not replace the record silently.
    if (canonical(readRecord(key)) !== canonical(record)) return { status: "pending", reason: "storage_error" };
  } catch {
    return { status: "pending", reason: "storage_error" };
  }
  let result: Awaited<ReturnType<typeof api.saveRecognitionEvidence>>;
  try {
    result = await api.saveRecognitionEvidence(medicineId, record.payload);
  } catch (error) {
    if (!current()) return { status: "identity_changed", reason: "identity_changed" };
    return { status: "pending", reason: failureReason(error) };
  }
  try {
    if (!current()) return { status: "identity_changed", reason: "identity_changed" };
    if (!receiptMatchesIntent(record.payload, result.evidence)) return { status: "pending", reason: "receipt_mismatch" };
    if (result.evidence!.stale !== true && result.evidence!.stale !== false) return { status: "pending", reason: "receipt_mismatch" };
    let latestStillMatches = result.evidence!.stale === false;
    if (result.evidence!.stale === true && result.evidence!.currentMedicineVersion === record.payload.medicineVersion) {
      // Stale can mean either unavailable historical media or a newer source
      // revision. A POST acknowledgement alone cannot distinguish them.
      try {
        const latest = await api.getRecognitionEvidence(medicineId);
        if (!current()) return { status: "identity_changed", reason: "identity_changed" };
        latestStillMatches = latest.capabilities?.coverPhotoVersionGuard === true && receiptMatchesIntent(record.payload, latest.evidence);
      } catch { latestStillMatches = false; }
    }
    if (result.evidence!.currentMedicineVersion !== record.payload.medicineVersion || !latestStillMatches) {
      if (result.evidence!.stale !== true) return { status: "pending", reason: "receipt_mismatch" };
      // Preserve the original request and its receipt marker when it was applied before a later medicine change.
      if (canonical(readRecord(key)) !== canonical(record)) return { status: "pending", reason: "storage_error", acknowledged: true };
      const acknowledged: PendingRecognitionEvidence = { ...record, acknowledgement: { revision: result.evidence!.revision,
        medicineVersion: record.payload.medicineVersion } };
      try { wx.setStorageSync(key, acknowledged); } catch { return { status: "pending", reason: "stale", acknowledged: true }; }
      if (canonical(readRecord(key)) !== canonical(acknowledged)) return { status: "pending", reason: "storage_error", acknowledged: true };
      return { status: "pending", reason: "stale", acknowledged: true };
    }
    if (canonical(readRecord(key)) !== canonical(record)) return { status: "pending", reason: "storage_error" };
    wx.removeStorageSync(key);
    if (readRecord(key) !== null) return { status: "pending", reason: "storage_error" };
    return result.evidence!.stale ? { status: "synced", reason: "stale" } : { status: "synced" };
  } catch {
    if (!current()) return { status: "identity_changed", reason: "identity_changed" };
    return { status: "pending", reason: "storage_error" };
  }
}

/** Stage before dispatch. A pre-existing intent is never overwritten or automatically retried. */
export async function queueRecognitionEvidence(medicineId: string, payload: RecognitionEvidenceSave): Promise<EvidenceSyncResult> {
  const key = keyFor(medicineId);
  const identity = captureSessionIdentity();
  if (!key || !identity.token) return { status: "identity_changed", reason: "identity_changed" };
  let record: PendingRecognitionEvidence;
  try {
    if (readRecord(key)) return { status: "existing" };
    // JSON copy removes references to mutable UI state; the persisted body is the dispatch body.
    record = JSON.parse(JSON.stringify({ medicineId, payload })) as PendingRecognitionEvidence;
    wx.setStorageSync(key, record);
    if (canonical(readRecord(key)) !== canonical(record)) return { status: "storage_failed", reason: "storage_error" };
  } catch {
    return { status: "storage_failed", reason: "storage_error" };
  }
  if (!isCurrentSession(identity) || keyFor(medicineId) !== key) return { status: "identity_changed", reason: "identity_changed" };
  return attempt(medicineId, key, record);
}

/** Called only after an explicit retry action on the photos page. */
export async function retryRecognitionEvidence(medicineId: string): Promise<EvidenceSyncResult> {
  const key = keyFor(medicineId);
  if (!key) return { status: "identity_changed", reason: "identity_changed" };
  try {
    const record = readRecord(key);
    if (!record || record.medicineId !== medicineId) return { status: "pending", reason: "storage_error" };
    return await attempt(medicineId, key, record);
  } catch {
    return { status: "pending", reason: "storage_error" };
  }
}

export type EvidenceRecoveryResult =
  | { status: "ready"; oldMedicineVersion: number; currentMedicineVersion: number; medicine: MedicationSummary }
  | { status: "synced"; reason?: EvidenceSyncReason }
  | { status: "acknowledged" }
  | { status: "blocked"; reason: EvidenceSyncReason }
  | { status: "identity_changed" };

interface RecoverySnapshot { medicine: MedicationSummary; photos: LeafletPhotoSummary[]; evidence: RecognitionEvidence | null }
interface RecoveryProof {
  identity: ReturnType<typeof captureSessionIdentity>;
  record: PendingRecognitionEvidence;
  snapshot: RecoverySnapshot;
}
const recoveryProofs = new Map<string, RecoveryProof>();
let recoveryGeneration = 0;

/** Drop only in-memory review snapshots, including reviews still loading; durable intents are untouched. */
export function clearRecognitionEvidenceRecoveryProofs(): void {
  recoveryGeneration++;
  recoveryProofs.clear();
}

function snapshotKey(snapshot: RecoverySnapshot): string {
  return canonical({ medicine: snapshot.medicine, evidence: snapshot.evidence,
    photos: snapshot.photos.map(photo => ({ id: photo.id, batchId: photo.batchId ?? null })).sort((a, b) => a.id.localeCompare(b.id)) });
}

async function recoverySnapshot(medicineId: string, record: PendingRecognitionEvidence,
  current: () => boolean): Promise<RecoverySnapshot | EvidenceSyncReason> {
  try {
    if (!current()) return "identity_changed";
    const firstEvidence = await api.getRecognitionEvidence(medicineId);
    if (!current()) return "identity_changed";
    if (firstEvidence.capabilities?.coverPhotoVersionGuard !== true) return "capability_unconfirmed";
    const firstMedicine = await api.getMedicine(medicineId);
    if (!current()) return "identity_changed";
    const { photos } = await api.listLeafletPhotos(medicineId);
    if (!current()) return "identity_changed";
    const secondEvidence = await api.getRecognitionEvidence(medicineId);
    if (!current()) return "identity_changed";
    const medicine = await api.getMedicine(medicineId);
    if (!current()) return "identity_changed";
    if (secondEvidence.capabilities?.coverPhotoVersionGuard !== true) return "capability_unconfirmed";
    if (!Number.isSafeInteger(medicine.version) || medicine.version <= record.payload.medicineVersion ||
        canonical(firstMedicine) !== canonical(medicine)) return "version_changed";
    if (!Array.isArray(medicine.batches) || !Array.isArray(photos)) return "version_changed";
    const values: Record<string, unknown> = { name: medicine.name, brand: medicine.brand, specification: medicine.specification,
      manufacturer: medicine.manufacturer, approvalNumber: medicine.approvalNumber, barcodeValue: medicine.barcodeValue,
      activeIngredients: medicine.activeIngredients, purposeCategory: medicine.purposeCategory, populationTags: medicine.populationTags,
      purposeTags: medicine.purposeTags, purposeSummary: medicine.leaflet?.purposeSummary, packageUsageSummary: medicine.leaflet?.packageUsageSummary,
      contraindicationsSummary: medicine.leaflet?.contraindicationsSummary, precautionsSummary: medicine.leaflet?.precautionsSummary };
    if (Object.keys(record.payload.fieldSources).some(field => !Object.hasOwn(values, field) || values[field] === undefined)) return "current_unavailable";
    const evidence = secondEvidence.evidence;
    if (canonical(firstEvidence.evidence) !== canonical(evidence) || (evidence?.revision ?? 0) !== record.payload.revision ||
        (evidence && (evidence.schemaVersion !== 1 || evidence.currentMedicineVersion !== medicine.version))) return "source_changed";
    const originals = new Map(photos.map(photo => [photo.id, photo]));
    if (record.payload.photos.some(photo => !originals.has(photo.photoId)) ||
        evidence?.photos.some(photo => !photo.available)) return "photo_unavailable";
    for (const source of record.payload.batchSources ?? []) {
      const batch = medicine.batches.find(item => item.id === source.batchId);
      if (!source.batchId || !batch || (source.field === "expiry" && (!batch.expiry || batch.expiry.precision === undefined)) ||
          (source.field === "lotNumber" && batch.lotNumber === undefined)) return "batch_unavailable";
      for (const photoId of source.photoIds) {
        const associated = originals.get(photoId)?.batchId;
        if (associated && associated !== source.batchId) return "batch_unavailable";
      }
    }
    if (evidence?.batchSources?.some(source => !source.batchAvailable || !source.batchId)) return "batch_unavailable";
    return { medicine, photos, evidence };
  } catch (error) { return failureReason(error); }
}

/** Explicit review starts by replaying the original key; a 409 alone never replaces the stored request. */
export async function prepareRecognitionEvidenceRecovery(medicineId: string): Promise<EvidenceRecoveryResult> {
  const key = keyFor(medicineId);
  if (!key) return { status: "identity_changed" };
  recoveryProofs.delete(key);
  const identity = captureSessionIdentity();
  const generation = recoveryGeneration;
  const current = (): boolean => generation === recoveryGeneration && isCurrentSession(identity) && keyFor(medicineId) === key;
  if (!identity.token || !current()) return { status: "identity_changed" };
  let record: PendingRecognitionEvidence | null;
  try { record = readRecord(key); } catch { return { status: "blocked", reason: "storage_error" }; }
  if (!record || record.medicineId !== medicineId) return { status: "blocked", reason: "storage_error" };
  const replay = await attempt(medicineId, key, record);
  if (!current()) return { status: "identity_changed" };
  if (replay.status === "synced") return { status: "synced", reason: replay.reason };
  if (replay.acknowledged) {
    // The POST itself proved this exact intent was committed. Clear only when the
    // latest document still contains that same revision and body; otherwise keep it inspectable.
    try {
      const acknowledged = readRecord(key);
      const latest = await api.getRecognitionEvidence(medicineId);
      if (!current()) return { status: "identity_changed" };
      if (acknowledged && acknowledged.acknowledgement && latest.capabilities?.coverPhotoVersionGuard === true &&
          latest.evidence?.stale === true && receiptMatchesIntent(acknowledged.payload, latest.evidence) &&
          canonical(readRecord(key)) === canonical(acknowledged)) {
        wx.removeStorageSync(key);
        if (readRecord(key) === null) return { status: "synced", reason: "stale" };
      }
    } catch { /* Keep the original request available if verification or storage fails. */ }
    return { status: "acknowledged" };
  }
  if (replay.reason !== "conflict") return { status: "blocked", reason: replay.reason ?? "recovery_required" };
  const snapshot = await recoverySnapshot(medicineId, record, current);
  if (!current()) return { status: "identity_changed" };
  if (typeof snapshot === "string") return { status: "blocked", reason: snapshot };
  try { if (canonical(readRecord(key)) !== canonical(record)) return { status: "blocked", reason: "storage_error" }; }
  catch { return { status: "blocked", reason: "storage_error" }; }
  recoveryProofs.set(key, { identity, record, snapshot });
  return { status: "ready", oldMedicineVersion: record.payload.medicineVersion, currentMedicineVersion: snapshot.medicine.version,
    medicine: snapshot.medicine };
}

/** User confirmation follows a visible review; every precondition is read again before durable replacement. */
export async function confirmRecognitionEvidenceRecovery(medicineId: string): Promise<EvidenceSyncResult> {
  const key = keyFor(medicineId);
  if (!key) return { status: "identity_changed", reason: "identity_changed" };
  const proof = recoveryProofs.get(key);
  recoveryProofs.delete(key);
  if (!proof || !isCurrentSession(proof.identity)) return { status: "identity_changed", reason: "identity_changed" };
  const generation = recoveryGeneration;
  const current = (): boolean => generation === recoveryGeneration && isCurrentSession(proof.identity) && keyFor(medicineId) === key;
  const snapshot = await recoverySnapshot(medicineId, proof.record, current);
  if (!current()) return { status: "identity_changed", reason: "identity_changed" };
  if (typeof snapshot === "string") return { status: "pending", reason: snapshot };
  if (snapshotKey(snapshot) !== snapshotKey(proof.snapshot)) return { status: "pending", reason: "version_changed" };
  try {
    if (canonical(readRecord(key)) !== canonical(proof.record)) return { status: "pending", reason: "storage_error" };
    const oldKeys = new Set([proof.record.payload, ...(proof.record.previousPayloads ?? [])].map(payload => payload.idempotencyKey));
    let newKey = "";
    for (let i = 0; i < 5 && (!newKey || oldKeys.has(newKey)); i++) {
      newKey = `evidence-retry-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    }
    if (!newKey || oldKeys.has(newKey)) return { status: "pending", reason: "storage_error" };
    const next: PendingRecognitionEvidence = { medicineId, payload: { ...proof.record.payload,
      medicineVersion: snapshot.medicine.version, idempotencyKey: newKey },
      previousPayloads: [...(proof.record.previousPayloads ?? []), proof.record.payload] };
    wx.setStorageSync(key, next);
    if (canonical(readRecord(key)) !== canonical(next)) return { status: "storage_failed", reason: "storage_error" };
    if (!current()) return { status: "identity_changed", reason: "identity_changed" };
    return await attempt(medicineId, key, next);
  } catch { return current() ? { status: "storage_failed", reason: "storage_error" } : { status: "identity_changed", reason: "identity_changed" }; }
}
