import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authenticateRequest, requireFamily } from "../auth/session.js";
import { findMedicineInFamily, lockMedicineInFamily } from "../repositories/medicines.js";
import { privatePhotoStorageKey, PrivatePhotoStore } from "../services/private-photo-store.js";
import { isCanonicalBase64 } from "../services/base64-validation.js";
import type { PrivatePhotoType } from "../services/private-photo-store.js";
import type { Database } from "../types.js";
import { errorBody, toIso } from "../types.js";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_FAMILY_PHOTOS = 100;
const MAX_FAMILY_PHOTO_BYTES = 64 * 1024 * 1024;
const UPLOAD_WINDOW_MS = 60_000;
const MAX_UPLOADS_PER_USER_PER_WINDOW = 10;
const NOT_FOUND = errorBody("NOT_FOUND", "说明书图片不存在或不在当前家庭中");
const uploadWindows = new Map<string, { startedAt: number; count: number }>();

interface PhotoUsageRow {
  photo_count: number | string;
  total_bytes: number | string;
}

class PhotoQuotaExceededError extends Error {}
class PhotoFamilyNotFoundError extends Error {}
class PhotoStoreRemovalError extends Error {}
class PhotoMedicineNotFoundError extends Error {}
class PhotoBatchNotFoundError extends Error {}
class PhotoNotEligibleAsCoverError extends Error {}
class PhotoReservationMissingError extends Error {}
class PhotoIntentConflictError extends Error {}

function allowUpload(userId: string, now = Date.now()): boolean {
  if (uploadWindows.size >= 1000) {
    for (const [key, candidate] of uploadWindows) {
      if (now - candidate.startedAt >= UPLOAD_WINDOW_MS) uploadWindows.delete(key);
    }
    if (uploadWindows.size >= 1000) uploadWindows.delete(uploadWindows.keys().next().value as string);
  }
  let window = uploadWindows.get(userId);
  if (window === undefined || now - window.startedAt >= UPLOAD_WINDOW_MS) {
    window = { startedAt: now, count: 0 };
  }
  if (window.count >= MAX_UPLOADS_PER_USER_PER_WINDOW) {
    uploadWindows.set(userId, window);
    return false;
  }
  window.count += 1;
  uploadWindows.set(userId, window);
  return true;
}

async function photoUsage(query: { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> }, familyId: string) {
  const result = await query.query<PhotoUsageRow>(
    `SELECT count(*)::int AS photo_count, COALESCE(sum(size_bytes), 0)::bigint AS total_bytes
     FROM medicine_leaflet_photos WHERE family_id = $1 AND storage_removed_at IS NULL`,
    [familyId],
  );
  return {
    count: Number(result.rows[0]?.photo_count ?? 0),
    bytes: Number(result.rows[0]?.total_bytes ?? 0),
  };
}

function exceedsFamilyPhotoQuota(count: number, bytes: number, incomingBytes: number): boolean {
  return count >= MAX_FAMILY_PHOTOS || bytes + incomingBytes > MAX_FAMILY_PHOTO_BYTES;
}

async function markPhotoStorageRemoved(database: Database, familyId: string, photoId: string): Promise<void> {
  await database.withTransaction(async (tx) => {
    const family = await tx.query<{ id: string }>(
      "SELECT id FROM families WHERE id = $1 FOR UPDATE",
      [familyId],
    );
    if (family.rowCount === 0) throw new PhotoFamilyNotFoundError();
    await tx.query(
      `UPDATE medicine_leaflet_photos SET storage_removed_at = now(),
           upload_intent_key = CASE WHEN upload_completed_at IS NULL THEN NULL ELSE upload_intent_key END
       WHERE id = $1 AND family_id = $2 AND storage_removed_at IS NULL
         AND (deleted_at IS NOT NULL OR upload_completed_at IS NULL)`,
      [photoId, familyId],
    );
  });
}

async function purgePendingPhotoStorage(
  database: Database,
  store: PrivatePhotoStore,
  familyId: string,
  onlyPhotoId?: string,
): Promise<void> {
  const pending = await database.query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM medicine_leaflet_photos
     WHERE family_id = $1 AND storage_removed_at IS NULL
       AND (deleted_at IS NOT NULL OR (upload_completed_at IS NULL AND
         ($2::uuid IS NOT NULL OR created_at < now() - interval '5 minutes')))
       AND ($2::uuid IS NULL OR id = $2)
     ORDER BY deleted_at, id LIMIT 100`,
    [familyId, onlyPhotoId ?? null],
  );
  for (const photo of pending.rows) {
    try {
      await store.remove(photo.storage_key);
    } catch {
      throw new PhotoStoreRemovalError();
    }
    await markPhotoStorageRemoved(database, familyId, photo.id);
  }
}


function imageBytes(value: unknown, type: unknown): { contentType: PrivatePhotoType; bytes: Buffer } | null {
  if ((type !== "image/jpeg" && type !== "image/png") || typeof value !== "string" || value.length === 0) return null;
  if (value.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4 || !isCanonicalBase64(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) return null;
  if (type === "image/jpeg") {
    if (bytes.length < 8 || !bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
        !bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) return null;
  } else {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const end = Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]);
    if (bytes.length < 20 || !bytes.subarray(0, 8).equals(signature) || bytes.lastIndexOf(end) < bytes.length - 32) return null;
  }
  return { contentType: type, bytes };
}

interface LeafletPhotoRow {
  id: string;
  medicine_id: string;
  content_type: PrivatePhotoType;
  size_bytes: number;
  source: string;
  purpose: string;
  batch_id: string | null;
  storage_key: string;
  created_at: Date | string;
}

/** 照片用途白名单；说明书是默认值，保持旧客户端上传行为不变。 */
const PHOTO_PURPOSES = ["box_front", "expiry", "leaflet"] as const;
type PhotoPurposeValue = (typeof PHOTO_PURPOSES)[number];

function readPurpose(value: unknown): PhotoPurposeValue {
  return typeof value === "string" && (PHOTO_PURPOSES as readonly string[]).includes(value)
    ? (value as PhotoPurposeValue)
    : "leaflet";
}

function summary(row: LeafletPhotoRow) {
  return {
    id: row.id,
    medicineId: row.medicine_id,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    source: row.source,
    purpose: readPurpose(row.purpose),
    batchId: row.batch_id ?? null,
    createdAt: toIso(row.created_at),
    url: `/api/v1/medicines/${row.medicine_id}/leaflet-photos/${row.id}`,
  };
}

export async function registerLeafletPhotoRoutes(
  app: FastifyInstance,
  database: Database,
  store: PrivatePhotoStore = new PrivatePhotoStore(),
): Promise<void> {
  app.post<{ Params: { medicineId: string } }>(
    "/api/v1/medicines/:medicineId/leaflet-photos",
    {
      bodyLimit: 12 * 1024 * 1024,
      onRequest: async (request, reply) => {
        await authenticateRequest(request, reply, database);
        if (reply.sent) return;
        const ctx = requireFamily(request, reply);
        if (ctx === null) return;
        if (!allowUpload(ctx.userId)) {
          return reply.code(429).send(errorBody("RATE_LIMITED", "说明书图片上传过于频繁，请稍后重试"));
        }
      },
    },
    async (request, reply) => {
      const ctx = requireFamily(request, reply);
      if (ctx === null) return;
      const body = request.body as Record<string, unknown> | null;
      const photo = imageBytes(body?.imageBase64, body?.mimeType);
      if (photo === null) return reply.code(400).send(errorBody("VALIDATION_ERROR", "仅支持不超过 8 MB 的有效 JPEG 或 PNG 图片"));
      const source = typeof body?.source === "string" && body.source.trim() !== ""
        ? body.source.trim().slice(0, 80)
        : "package_leaflet";
      const purpose = readPurpose(body?.purpose);
      const requestedBatchId = typeof body?.batchId === "string" && body.batchId.trim() !== ""
        ? body.batchId.trim()
        : null;
      const uploadIntentKey = body?.uploadIntentKey;
      if (uploadIntentKey !== undefined &&
          (typeof uploadIntentKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(uploadIntentKey))) {
        return reply.code(400).send(errorBody("VALIDATION_ERROR", "照片上传标识格式不正确"));
      }
      const uploadPayloadHash = typeof uploadIntentKey === "string"
        ? createHash("sha256")
            .update(photo.bytes)
            .update(JSON.stringify([ctx.familyId, ctx.userId, request.params.medicineId,
              photo.contentType, source, purpose, requestedBatchId]))
            .digest("hex") : null;
      // 有效期照片必须说清对应哪一盒库存记录。
      if (purpose === "expiry" && requestedBatchId === null) {
        return reply.code(400).send(errorBody("VALIDATION_ERROR", "有效期照片需要绑定具体的库存批次"));
      }
      const id = randomUUID();
      const storageKey = privatePhotoStorageKey({
        familyId: ctx.familyId,
        medicineId: request.params.medicineId,
        photoId: id,
        contentType: photo.contentType,
      });
      try {
        await purgePendingPhotoStorage(database, store, ctx.familyId);
      } catch {
        request.log.error("pending private leaflet photo cleanup failed");
        return reply.code(503).send(errorBody("INTERNAL_ERROR", "历史图片清理未完成，请稍后重试；没有上传新图片"));
      }

      let previousPhoto: LeafletPhotoRow | null = null;
      let pendingIntent = false;
      try {
        await database.withTransaction(async (tx) => {
          const lockedFamily = await tx.query<{ id: string }>(
            "SELECT id FROM families WHERE id = $1 FOR UPDATE",
            [ctx.familyId],
          );
          if (lockedFamily.rowCount === 0) throw new PhotoFamilyNotFoundError();
          const medicine = await lockMedicineInFamily(tx, request.params.medicineId, ctx.familyId);
          if (medicine === null) throw new PhotoMedicineNotFoundError();
          // The family lock serializes both new reservations and retries from this household.
          // Read the completed receipt BEFORE quota checks: replay must not allocate any bytes.
          if (typeof uploadIntentKey === "string") {
            const receipts = await tx.query<LeafletPhotoRow & {
              upload_payload_hash: string | null;
              upload_completed_at: Date | null;
              deleted_at: Date | null;
              storage_removed_at: Date | null;
            }>(
              `SELECT id, medicine_id, content_type, size_bytes, source, purpose, batch_id,
                      storage_key, created_at, upload_payload_hash, upload_completed_at,
                      deleted_at, storage_removed_at
                 FROM medicine_leaflet_photos
                WHERE family_id=$1 AND created_by=$2 AND upload_intent_key=$3
                FOR UPDATE`,
              [ctx.familyId, ctx.userId, uploadIntentKey],
            );
            const receipt = receipts.rows[0];
            if (receipt) {
              if (receipt.medicine_id !== medicine.id || receipt.upload_payload_hash !== uploadPayloadHash ||
                  receipt.deleted_at !== null || receipt.storage_removed_at !== null) {
                throw new PhotoIntentConflictError();
              }
              if (receipt.upload_completed_at === null) pendingIntent = true;
              else previousPhoto = receipt;
              return;
            }
          }
          const usage = await photoUsage(tx, ctx.familyId);
          if (exceedsFamilyPhotoQuota(usage.count, usage.bytes, photo.bytes.length)) {
            throw new PhotoQuotaExceededError();
          }
          let batchId: string | null = null;
          if (requestedBatchId !== null) {
            const batch = await tx.query<{ id: string }>(
              `SELECT id FROM medicine_batches
               WHERE id = $1 AND medicine_id = $2 AND family_id = $3 AND deleted_at IS NULL`,
              [requestedBatchId, medicine.id, ctx.familyId],
            );
            if (batch.rowCount === 0) throw new PhotoBatchNotFoundError();
            batchId = requestedBatchId;
          }
          const reservation = await tx.query<{ id: string }>(
            `INSERT INTO medicine_leaflet_photos
             (id, family_id, medicine_id, storage_key, content_type, size_bytes, source, purpose,
              batch_id, created_by, upload_intent_key, upload_payload_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [id, ctx.familyId, medicine.id, storageKey, photo.contentType, photo.bytes.length,
              source, purpose, batchId, ctx.userId, uploadIntentKey ?? null, uploadPayloadHash],
          );
          if (reservation.rowCount === 0) throw new PhotoReservationMissingError();
        });
      } catch (error) {
        if (error instanceof PhotoIntentConflictError) {
          return reply.code(409).send(errorBody("VERSION_CONFLICT", "该照片上传标识已用于不同内容或已删除的图片，请核对记录"));
        }
        if (error instanceof PhotoQuotaExceededError) {
          return reply.code(413).send(errorBody("VALIDATION_ERROR", "家庭说明书图片空间已满，请先移除旧图片"));
        }
        if (error instanceof PhotoFamilyNotFoundError) {
          return reply.code(404).send(errorBody("FAMILY_NOT_FOUND", "家庭不存在或无法访问"));
        }
        if (error instanceof PhotoMedicineNotFoundError) return reply.code(404).send(NOT_FOUND);
        if (error instanceof PhotoBatchNotFoundError) {
          return reply.code(404).send(errorBody("NOT_FOUND", "库存批次不存在或不属于该药品"));
        }
        throw error;
      }

      if (previousPhoto !== null) return reply.code(200).send({ photo: summary(previousPhoto) });
      if (pendingIntent) return reply.code(503).send(errorBody(
        "PHOTO_UPLOAD_PENDING", "同一照片上传尚未完成，请稍后按原提交标识重试",
      ));

      try {
        const savedKey = await store.save({
          familyId: ctx.familyId,
          medicineId: request.params.medicineId,
          photoId: id,
          contentType: photo.contentType,
          bytes: photo.bytes,
        });
        if (savedKey !== storageKey) {
          await store.remove(savedKey).catch(() => undefined);
          throw new Error("private photo store returned a mismatched key");
        }
      } catch {
        await purgePendingPhotoStorage(database, store, ctx.familyId, id).catch(() => {
          request.log.error("reserved private leaflet photo cleanup failed");
        });
        request.log.error("private leaflet photo write failed");
        return reply.code(503).send(errorBody("INTERNAL_ERROR", "图片保存失败，请稍后重试；存储配额未被释放"));
      }

      try {
        const inserted = await database.withTransaction(async (tx) => {
          const lockedFamily = await tx.query<{ id: string }>(
            "SELECT id FROM families WHERE id = $1 FOR UPDATE",
            [ctx.familyId],
          );
          if (lockedFamily.rowCount === 0) throw new PhotoFamilyNotFoundError();
          const medicine = await lockMedicineInFamily(tx, request.params.medicineId, ctx.familyId);
          if (medicine === null) throw new PhotoMedicineNotFoundError();
          const activated = await tx.query<LeafletPhotoRow>(
            `UPDATE medicine_leaflet_photos SET upload_completed_at = now()
             WHERE id = $1 AND family_id = $2 AND medicine_id = $3
               AND deleted_at IS NULL AND upload_completed_at IS NULL AND storage_removed_at IS NULL
             RETURNING id, medicine_id, content_type, size_bytes, source, purpose, batch_id, storage_key, created_at`,
            [id, ctx.familyId, medicine.id],
          );
          if (activated.rowCount === 0) throw new PhotoReservationMissingError();
          return activated;
        });
        return reply.code(201).send({ photo: summary(inserted.rows[0]) });
      } catch (error) {
        await purgePendingPhotoStorage(database, store, ctx.familyId, id).catch(() => {
          request.log.error("reserved private leaflet photo cleanup failed");
        });
        if (error instanceof PhotoMedicineNotFoundError) return reply.code(404).send(NOT_FOUND);
        if (error instanceof PhotoBatchNotFoundError) {
          return reply.code(404).send(errorBody("NOT_FOUND", "库存批次不存在或不属于该药品"));
        }
        if (error instanceof PhotoFamilyNotFoundError) return reply.code(404).send(errorBody("FAMILY_NOT_FOUND", "家庭不存在或无法访问"));
        if (error instanceof PhotoStoreRemovalError) {
          return reply.code(503).send(errorBody("INTERNAL_ERROR", "未完成的图片已隐藏，服务器清理待重试；容量未释放"));
        }
        request.log.error("private leaflet photo metadata activation failed");
        return reply.code(503).send(errorBody("INTERNAL_ERROR", "图片记录保存失败，系统正在清理未完成的上传"));
      }
    },
  );

  app.get<{ Params: { medicineId: string }; Querystring: { purpose?: string } }>(
    "/api/v1/medicines/:medicineId/leaflet-photos",
    async (request, reply) => {
      const ctx = requireFamily(request, reply);
      if (ctx === null) return;
      const medicine = await findMedicineInFamily(database, request.params.medicineId, ctx.familyId);
      if (medicine === null) return reply.code(404).send(NOT_FOUND);
      const purposeFilter = typeof request.query.purpose === "string" &&
        (PHOTO_PURPOSES as readonly string[]).includes(request.query.purpose)
        ? request.query.purpose
        : null;
      const result = await database.query<LeafletPhotoRow>(
        `SELECT id, medicine_id, content_type, size_bytes, source, purpose, batch_id, storage_key, created_at
         FROM medicine_leaflet_photos WHERE family_id = $1 AND medicine_id = $2
           AND deleted_at IS NULL AND upload_completed_at IS NOT NULL
           AND ($3::text IS NULL OR purpose = $3)
         ORDER BY created_at DESC, id`,
        [ctx.familyId, medicine.id, purposeFilter],
      );
      const cover = await database.query<{ cover_photo_id: string | null }>(
        "SELECT cover_photo_id FROM medicines WHERE id = $1 AND family_id = $2",
        [medicine.id, ctx.familyId],
      );
      return { photos: result.rows.map(summary), coverPhotoId: cover.rows[0]?.cover_photo_id ?? null };
    },
  );

  // 设置或取消药盒封面：只接受该药品自己的"药盒正面"照片。
  // 说明书与有效期照片都不能充当封面，避免把"用了多久"错当成"这是什么药"。
  app.post<{ Params: { medicineId: string } }>(
    "/api/v1/medicines/:medicineId/cover-photo",
    async (request, reply) => {
      const ctx = requireFamily(request, reply);
      if (ctx === null) return;
      const body = request.body as Record<string, unknown> | null;
      const raw = body?.photoId;
      if (raw !== undefined && raw !== null && typeof raw !== "string") {
        return reply.code(400).send(errorBody("VALIDATION_ERROR", "photoId 需为照片 id 或 null"));
      }
      const photoId = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      try {
        const coverPhotoId = await database.withTransaction(async (tx) => {
          const medicine = await lockMedicineInFamily(tx, request.params.medicineId, ctx.familyId);
          if (medicine === null) throw new PhotoMedicineNotFoundError();
          if (photoId !== null) {
            const photo = await tx.query<{ id: string }>(
              `SELECT id FROM medicine_leaflet_photos
               WHERE id = $1 AND family_id = $2 AND medicine_id = $3 AND purpose = 'box_front'
                 AND deleted_at IS NULL AND upload_completed_at IS NOT NULL`,
              [photoId, ctx.familyId, medicine.id],
            );
            if (photo.rowCount === 0) throw new PhotoNotEligibleAsCoverError();
          }
          // 回读实际写入值：只有数据库确实更新成功才向客户端报告已设置封面，
          // 避免"界面说设好了、其实没有"。
          const updated = await tx.query<{ cover_photo_id: string | null }>(
            `UPDATE medicines SET cover_photo_id = $3, updated_by = $4, version = version + 1, updated_at = now()
             WHERE id = $1 AND family_id = $2 RETURNING cover_photo_id`,
            [medicine.id, ctx.familyId, photoId, ctx.userId],
          );
          if (updated.rowCount === 0) throw new PhotoMedicineNotFoundError();
          return updated.rows[0].cover_photo_id ?? null;
        });
        return { coverPhotoId };
      } catch (error) {
        if (error instanceof PhotoMedicineNotFoundError) return reply.code(404).send(NOT_FOUND);
        if (error instanceof PhotoNotEligibleAsCoverError) {
          return reply.code(400).send(errorBody("VALIDATION_ERROR", "只有该药品自己的药盒正面照片可以设为封面"));
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { medicineId: string; photoId: string } }>(
    "/api/v1/medicines/:medicineId/leaflet-photos/:photoId",
    async (request, reply) => {
      const ctx = requireFamily(request, reply);
      if (ctx === null) return;
      const medicine = await findMedicineInFamily(database, request.params.medicineId, ctx.familyId);
      if (medicine === null) return reply.code(404).send(NOT_FOUND);
      const result = await database.query<LeafletPhotoRow>(
        `SELECT id, medicine_id, content_type, size_bytes, source, purpose, batch_id, storage_key, created_at
         FROM medicine_leaflet_photos
         WHERE id = $1 AND family_id = $2 AND medicine_id = $3
           AND deleted_at IS NULL AND upload_completed_at IS NOT NULL`,
        [request.params.photoId, ctx.familyId, medicine.id],
      );
      const row = result.rows[0];
      if (row === undefined) return reply.code(404).send(NOT_FOUND);
      let bytes: Buffer;
      try {
        bytes = await store.read(row.storage_key);
      } catch {
        request.log.error("private leaflet photo read failed");
        return reply.code(404).send(NOT_FOUND);
      }
      return reply
        .header("content-type", row.content_type)
        .header("content-length", String(bytes.length))
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .send(bytes);
    },
  );

  app.delete<{ Params: { medicineId: string; photoId: string } }>(
    "/api/v1/medicines/:medicineId/leaflet-photos/:photoId",
    async (request, reply) => {
      const ctx = requireFamily(request, reply);
      if (ctx === null) return;
      try {
        const deleted = await database.withTransaction(async (tx) => {
          const family = await tx.query<{ id: string }>(
            "SELECT id FROM families WHERE id = $1 FOR UPDATE",
            [ctx.familyId],
          );
          if (family.rowCount === 0) throw new PhotoFamilyNotFoundError();
          const selected = await tx.query<{ id: string }>(
            `SELECT id FROM medicine_leaflet_photos
             WHERE id = $1 AND family_id = $2 AND medicine_id = $3
               AND deleted_at IS NULL AND upload_completed_at IS NOT NULL
             FOR UPDATE`,
            [request.params.photoId, ctx.familyId, request.params.medicineId],
          );
          if (selected.rows[0] === undefined) return false;
          const updated = await tx.query<{ id: string }>(
            `UPDATE medicine_leaflet_photos SET deleted_at = now(), deleted_by = $4
             WHERE id = $1 AND family_id = $2 AND medicine_id = $3
               AND deleted_at IS NULL AND upload_completed_at IS NOT NULL
             RETURNING id`,
            [request.params.photoId, ctx.familyId, request.params.medicineId, ctx.userId],
          );
          return updated.rowCount !== 0;
        });
        if (!deleted) return reply.code(404).send(NOT_FOUND);
        try {
          await purgePendingPhotoStorage(database, store, ctx.familyId, request.params.photoId);
        } catch {
          // The row remains hidden but keeps consuming quota until a later upload retries cleanup.
          request.log.warn("leaflet photo cleanup is pending; storage quota was not released");
        }
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof PhotoFamilyNotFoundError) {
          return reply.code(404).send(errorBody("FAMILY_NOT_FOUND", "家庭不存在或无法访问"));
        }
        throw error;
      }
    },
  );
}
