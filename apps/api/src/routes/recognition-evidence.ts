import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticateRequest, requireFamily } from "../auth/session.js";
import { lockMedicineInFamily } from "../repositories/medicines.js";
import { lockFamilyIdentity } from "../services/locked-family-identity.js";
import { batchSourcesMatch, batchSourcesPreserveHistory, evidenceResponse, legacyMedicineSourcesPreserved, loadEvidenceBatches,
  recognitionEvidenceHash, recognizedSourcesMatchMedicine, sourceKeysPreserved, unavailableSourcesPreserveHistory, validateRecognitionEvidenceSave,
  type EvidenceRow, MAX_EVIDENCE_BYTES } from "../services/recognition-evidence.js";
import type { Database } from "../types.js";
import { errorBody, TransactionConflictError } from "../types.js";

const PATH = "/api/v1/medicines/:medicineId/recognition-evidence";
const NOT_FOUND = errorBody("NOT_FOUND", "药品不存在或不在当前家庭中");
const CONFLICT = errorBody("VERSION_CONFLICT", "来源或药品已改变，请刷新核对后重试");
const INVALID = errorBody("VALIDATION_ERROR", "来源资料格式不正确、超过限制或包含不可用照片");
const RECEIPT_CAP = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof TransactionConflictError) return reply.code(error.statusCode).send(error.body);
  // Do not log database details, SQL parameters, document contents, or recognition text.
  request.log.error("recognition evidence operation failed");
  return reply.code(500).send(errorBody("INTERNAL_ERROR", "来源资料暂时不可用，请稍后重试"));
}

export async function registerRecognitionEvidenceRoutes(app: FastifyInstance, database: Database): Promise<void> {
  app.get<{ Params: { medicineId: string } }>(PATH, async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    if (!UUID.test(request.params.medicineId)) return reply.code(404).send(NOT_FOUND);
    try {
      const evidence = await database.withTransaction(async (tx) => {
        await lockFamilyIdentity(tx, ctx, request);
        const medicine = await lockMedicineInFamily(tx, request.params.medicineId, ctx.familyId);
        if (medicine === null) throw new TransactionConflictError(404, NOT_FOUND);
        const rows = await tx.query<EvidenceRow>(
          "SELECT revision, medicine_version, document FROM medicine_recognition_evidence WHERE family_id = $1 AND medicine_id = $2",
          [ctx.familyId, medicine.id],
        );
        return rows.rows[0] ? evidenceResponse(tx, ctx.familyId, medicine.id, medicine, rows.rows[0]) : null;
      });
      return reply.header("cache-control", "private, no-store").send({
        evidence, capabilities: { coverPhotoVersionGuard: true },
      });
    } catch (error) {
      return handleError(error, request, reply);
    }
  });

  app.post<{ Params: { medicineId: string } }>(PATH, {
    bodyLimit: MAX_EVIDENCE_BYTES + 4096,
    onRequest: async (request, reply) => {
      await authenticateRequest(request, reply, database);
      if (!reply.sent) requireFamily(request, reply);
    },
  }, async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    if (!UUID.test(request.params.medicineId)) return reply.code(404).send(NOT_FOUND);
    const input = validateRecognitionEvidenceSave(request.body);
    if (input === null) return reply.code(400).send(INVALID);
    const hash = recognitionEvidenceHash(input);
    try {
      const evidence = await database.withTransaction(async (tx) => {
        await lockFamilyIdentity(tx, ctx, request);
        const medicine = await lockMedicineInFamily(tx, request.params.medicineId, ctx.familyId);
        if (medicine === null) throw new TransactionConflictError(404, NOT_FOUND);
        const document = { schemaVersion: input.schemaVersion, photos: input.photos, fieldSources: input.fieldSources,
          ...(input.batchSources === undefined ? {} : { batchSources: input.batchSources }) };
        const receipts = await tx.query<{ payload_hash: string; medicine_id: string; revision: number; medicine_version: number }>(
          `SELECT payload_hash, medicine_id, revision, medicine_version
             FROM medicine_recognition_evidence_receipts WHERE family_id = $1 AND user_id = $2 AND request_key = $3`,
          [ctx.familyId, ctx.userId, input.idempotencyKey],
        );
        const receipt = receipts.rows[0];
        if (receipt) {
          if (receipt.medicine_id !== medicine.id || receipt.payload_hash !== hash) throw new TransactionConflictError(409, CONFLICT);
          const current = await tx.query<{ revision: number }>(
            "SELECT revision FROM medicine_recognition_evidence WHERE family_id = $1 AND medicine_id = $2",
            [ctx.familyId, medicine.id],
          );
          const replay = await evidenceResponse(tx, ctx.familyId, medicine.id, medicine, { ...receipt, document });
          // The acknowledgement stays immutable, but must not masquerade as the latest source document.
          return { ...replay, stale: replay.stale || current.rows[0]?.revision !== receipt.revision };
        }
        const existing = await tx.query<EvidenceRow>(
          "SELECT revision, medicine_version, document FROM medicine_recognition_evidence WHERE family_id = $1 AND medicine_id = $2",
          [ctx.familyId, medicine.id],
        );
        const previous = existing.rows[0];
        if ((previous?.revision ?? 0) !== input.revision || medicine.version !== input.medicineVersion) {
          throw new TransactionConflictError(409, CONFLICT);
        }
        if (!sourceKeysPreserved(previous?.document, document)) throw new TransactionConflictError(409, CONFLICT);
        if (!legacyMedicineSourcesPreserved(previous?.document, document)) throw new TransactionConflictError(400, INVALID);
        const oldPhotos = new Map(previous?.document.photos.map((photo) => [photo.photoId, photo]) ?? []);
        const oldSequences = new Map(previous?.document.photos.map((photo) => [photo.sequence, photo.photoId]) ?? []);
        const photoIds = input.photos.map((photo) => photo.photoId);
        const active = photoIds.length === 0 ? [] : (await tx.query<{ id: string; batch_id: string | null }>(
          `SELECT id, batch_id FROM medicine_leaflet_photos WHERE family_id = $1 AND medicine_id = $2
             AND id = ANY($3::uuid[]) AND deleted_at IS NULL AND upload_completed_at IS NOT NULL AND storage_removed_at IS NULL`,
          [ctx.familyId, medicine.id, photoIds],
        )).rows;
        const activeIds = new Set(active.map((photo) => photo.id));
        // Existing historical references can remain unavailable; never accept a new one.
        if (photoIds.some((id) => !activeIds.has(id) && !oldPhotos.has(id))) throw new TransactionConflictError(400, INVALID);
        const submittedPhotos = new Map(input.photos.map((photo) => [photo.photoId, photo]));
        for (const old of oldPhotos.values()) {
          const submitted = submittedPhotos.get(old.photoId);
          if (!submitted || submitted.sequence !== old.sequence ||
              (old.status === "recognized" && submitted.status !== "recognized")) {
            throw new TransactionConflictError(409, CONFLICT);
          }
          for (const [field, value] of Object.entries(old.fields)) {
            const exists = Object.prototype.hasOwnProperty.call(submitted.fields, field);
            const next = submitted.fields[field as keyof typeof submitted.fields];
            const fillsNull = value === null && next != null && old.status !== "recognized" && activeIds.has(old.photoId);
            if (!exists || (!fillsNull && JSON.stringify(next) !== JSON.stringify(value))) {
              throw new TransactionConflictError(409, CONFLICT);
            }
          }
          const warnings = submitted.warnings ?? [];
          const oldWarnings = old.warnings ?? [];
          if (oldWarnings.length > warnings.length || oldWarnings.some((warning, index) => warning !== warnings[index])) {
            throw new TransactionConflictError(409, CONFLICT);
          }
        }
        for (const photo of input.photos) {
          if ((oldPhotos.has(photo.photoId) && oldPhotos.get(photo.photoId)?.sequence !== photo.sequence) ||
              (oldSequences.has(photo.sequence) && oldSequences.get(photo.sequence) !== photo.photoId)) {
            throw new TransactionConflictError(409, CONFLICT);
          }
        }
        for (const photo of input.photos) {
          if (activeIds.has(photo.photoId)) continue;
          const old = oldPhotos.get(photo.photoId);
          const entries = (fields: typeof photo.fields) => Object.entries(fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
          if (!old || old.status !== photo.status || JSON.stringify(entries(old.fields)) !== JSON.stringify(entries(photo.fields)) ||
              JSON.stringify(old.warnings ?? []) !== JSON.stringify(photo.warnings ?? [])) {
            throw new TransactionConflictError(409, CONFLICT);
          }
        }
        if (!recognizedSourcesMatchMedicine(document, medicine)) throw new TransactionConflictError(400, INVALID);
        if (!unavailableSourcesPreserveHistory(previous?.document, document, activeIds)) {
          throw new TransactionConflictError(409, CONFLICT);
        }
        const batches = await loadEvidenceBatches(tx, ctx.familyId, medicine.id, document);
        const history = batchSourcesPreserveHistory(previous?.document, document, batches, activeIds);
        if (history === "invalid") throw new TransactionConflictError(400, INVALID);
        if (history === "conflict") throw new TransactionConflictError(409, CONFLICT);
        if (!batchSourcesMatch(document, batches, new Map(active.map((photo) => [photo.id, photo.batch_id])))) {
          throw new TransactionConflictError(400, INVALID);
        }
        // Retain promised keys, but bound lifetime metadata per family. Replays are checked first.
        const usage = await tx.query<{ total: number | string }>(
          "SELECT count(*)::int AS total FROM medicine_recognition_evidence_receipts WHERE family_id = $1", [ctx.familyId],
        );
        if (Number(usage.rows[0]?.total ?? 0) >= RECEIPT_CAP) {
          throw new TransactionConflictError(429, errorBody("RATE_LIMITED", "该家庭的来源保存记录已达上限，暂时无法新增保存"));
        }
        const revision = input.revision + 1;
        await tx.query(
          `INSERT INTO medicine_recognition_evidence (family_id, medicine_id, revision, medicine_version, document)
           VALUES ($1,$2,$3,$4,$5::jsonb)
           ON CONFLICT (medicine_id) DO UPDATE SET revision = EXCLUDED.revision,
             medicine_version = EXCLUDED.medicine_version, document = EXCLUDED.document, updated_at = now()`,
          [ctx.familyId, medicine.id, revision, input.medicineVersion, JSON.stringify(document)],
        );
        await tx.query(
          `INSERT INTO medicine_recognition_evidence_receipts
           (family_id, user_id, request_key, medicine_id, payload_hash, revision, medicine_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ctx.familyId, ctx.userId, input.idempotencyKey, medicine.id, hash, revision, input.medicineVersion],
        );
        return evidenceResponse(tx, ctx.familyId, medicine.id, medicine,
          { revision, medicine_version: input.medicineVersion, document });
      });
      return reply.header("cache-control", "private, no-store").send({ evidence });
    } catch (error) {
      return handleError(error, request, reply);
    }
  });
}
