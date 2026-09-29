import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import type { FamilyMedicineBackup, BackupPreviewResponse, BackupRestoreResponse } from "@home-medicine/contracts";
import { requireFamily, sha256Hex } from "../auth/session.js";
import { createRateLimiter } from "../rate-limit.js";
import { insertBatch } from "../repositories/batches.js";
import { archiveMedicine, insertMedicine, listMedicines } from "../repositories/medicines.js";
import { validateMedicineInput } from "../inputs.js";
import { buildFamilyMedicineSummaries } from "./medicines.js";
import { hashFamilyMedicineBackup, validateFamilyMedicineBackup } from "../services/backup-snapshot.js";
import type { Database } from "../types.js";
import { errorBody, TransactionConflictError } from "../types.js";

const NOT_FOUND = errorBody("NOT_FOUND", "家庭数据不存在或不可访问");
const BACKUP_ALREADY_IMPORTED = errorBody("BACKUP_ALREADY_IMPORTED", "这份备份已导入过，未重复写入");

export async function registerBackupRoutes(app: FastifyInstance, database: Database): Promise<void> {
  const previewLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 8 });
  const restoreLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 4 });
  app.post("/api/v1/backups/json", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const family = await database.query<{ name: string }>("SELECT name FROM families WHERE id = $1", [ctx.familyId]);
    const familyName = family.rows[0]?.name;
    if (familyName === undefined) return reply.code(404).send(NOT_FOUND);
    const rows = await listMedicines(database, ctx.familyId, true);
    const medicines = await buildFamilyMedicineSummaries(database, ctx.familyId, rows);
    const settings = await database.query<{ stocktake_interval: "weekly" | "monthly" | "disabled"; last_stocktake_at: Date | string | null }>(
      "SELECT stocktake_interval, last_stocktake_at FROM family_inventory_settings WHERE family_id = $1",
      [ctx.familyId],
    );
    const setting = settings.rows[0];
    const inventorySettings = {
      stocktakeInterval: setting?.stocktake_interval ?? "monthly",
      lastStocktakeAt: setting?.last_stocktake_at == null ? null : new Date(setting.last_stocktake_at).toISOString(),
      nextStocktakeAt: null,
    } as const;
    const snapshot: FamilyMedicineBackup = {
      schemaVersion: 1,
      backupId: crypto.randomUUID(),
      exportedAt: new Date().toISOString(),
      familyName,
      inventorySettings,
      medicines: medicines.map((medicine) => ({
        name: medicine.name,
        specification: medicine.specification,
        manufacturer: medicine.manufacturer,
        approvalNumber: medicine.approvalNumber,
        barcodeValue: medicine.barcodeValue,
        activeIngredients: medicine.activeIngredients,
        purposeCategory: medicine.purposeCategory,
        leaflet: medicine.leaflet,
        lowStockThreshold: medicine.lowStockThreshold,
        isArchived: medicine.isArchived,
        batches: medicine.batches.map((batch) => ({
          lotNumber: batch.lotNumber,
          expiry: batch.expiry,
          quantity: batch.quantity,
          unit: batch.unit,
          confirmedUnitsPerPackage: batch.confirmedUnitsPerPackage,
          storageLocation: batch.storageLocation,
          openedState: batch.openedState,
          openedAt: batch.openedAt,
          afterOpeningLimit: batch.afterOpeningLimit,
        })),
      })),
    };
    return snapshot;
  });

  app.post("/api/v1/backups/preview", { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    if (!previewLimit(ctx.userId)) return reply.code(429).send(errorBody("RATE_LIMITED", "备份预览过于频繁，请稍后重试"));
    const body = request.body as { backup?: unknown } | null;
    const validation = validateFamilyMedicineBackup(body?.backup);
    if (!validation.ok) {
      const response: BackupPreviewResponse = {
        valid: false,
        duplicateBackup: false,
        medicineCount: 0,
        likelyMatches: [],
        errors: validation.errors,
      };
      return response;
    }
    const existingReceipt = await database.query<{ backup_id: string }>(
      "SELECT backup_id FROM backup_restore_receipts WHERE family_id = $1 AND backup_id = $2",
      [ctx.familyId, validation.value.backupId],
    );
    let confirmationToken: string | undefined;
    if (existingReceipt.rowCount === 0) {
      const issuedToken = randomBytes(32).toString("hex");
      confirmationToken = issuedToken;
      const payloadHash = hashFamilyMedicineBackup(validation.value);
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      await database.withTransaction(async (tx) => {
        await tx.query(
          "DELETE FROM backup_restore_previews WHERE family_id = $1 AND (expires_at <= now() OR (consumed_at IS NOT NULL AND created_at < now() - interval '1 day'))",
          [ctx.familyId],
        );
        await tx.query(
          `INSERT INTO backup_restore_previews
           (family_id, user_id, backup_id, payload_hash, confirmation_token_hash, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [ctx.familyId, ctx.userId, validation.value.backupId, payloadHash, sha256Hex(issuedToken), expiresAt],
        );
      });
    }
    const existing = await listMedicines(database, ctx.familyId, true);
    const likelyMatches: BackupPreviewResponse["likelyMatches"] = [];
    for (const imported of validation.value.medicines) {
      const match = existing.find((item) =>
        (imported.approvalNumber !== null && item.approval_number === imported.approvalNumber) ||
        (item.name.trim().toLocaleLowerCase() === imported.name.trim().toLocaleLowerCase() &&
          (item.specification ?? "").trim().toLocaleLowerCase() === (imported.specification ?? "").trim().toLocaleLowerCase()),
      );
      if (match !== undefined) {
        likelyMatches.push({ importedName: imported.name, existingMedicineId: match.id, existingName: match.name });
      }
    }
    return {
      valid: true,
      duplicateBackup: existingReceipt.rowCount !== 0,
      ...(confirmationToken === undefined ? {} : { confirmationToken }),
      inventorySettings: validation.value.inventorySettings,
      medicineCount: validation.value.medicines.length,
      likelyMatches,
      errors: [],
    } satisfies BackupPreviewResponse;
  });

  app.post("/api/v1/backups/restore", { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    if (request.auth?.role !== "owner") return reply.code(403).send(errorBody("OWNER_ONLY", "只有家庭管理员可以恢复备份"));
    if (!restoreLimit(ctx.userId)) return reply.code(429).send(errorBody("RATE_LIMITED", "备份恢复过于频繁，请稍后重试"));
    const body = request.body as { backup?: unknown; confirmed?: unknown; confirmationToken?: unknown } | null;
    if (body?.confirmed !== true) return reply.code(400).send(errorBody("VALIDATION_ERROR", "恢复前必须确认导入预览"));
    const confirmationToken = typeof body.confirmationToken === "string" ? body.confirmationToken.trim() : "";
    if (!/^[a-f0-9]{64}$/i.test(confirmationToken)) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "缺少有效的恢复预览凭据，请重新预览备份"));
    }
    const validation = validateFamilyMedicineBackup(body.backup);
    if (!validation.ok) return reply.code(400).send(errorBody("VALIDATION_ERROR", validation.errors.join("；")));
    try {
      const restoredCount = await database.withTransaction(async (tx) => {
        const priorReceipt = await tx.query<{ backup_id: string }>(
          "SELECT backup_id FROM backup_restore_receipts WHERE family_id = $1 AND backup_id = $2",
          [ctx.familyId, validation.value.backupId],
        );
        if (priorReceipt.rowCount !== 0) throw new TransactionConflictError(409, BACKUP_ALREADY_IMPORTED);
        const preview = await tx.query<{ id: string }>(
          `SELECT id FROM backup_restore_previews
           WHERE family_id = $1 AND user_id = $2 AND backup_id = $3 AND payload_hash = $4
             AND confirmation_token_hash = $5 AND expires_at > now() AND consumed_at IS NULL
           FOR UPDATE`,
          [ctx.familyId, ctx.userId, validation.value.backupId, hashFamilyMedicineBackup(validation.value), sha256Hex(confirmationToken)],
        );
        const previewId = preview.rows[0]?.id;
        if (previewId === undefined) {
          throw new TransactionConflictError(409, errorBody("VALIDATION_ERROR", "预览凭据已过期或内容已变化，请重新预览备份"));
        }
        await tx.query(
          "UPDATE backup_restore_previews SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL",
          [previewId],
        );
        const receipt = await tx.query<{ backup_id: string }>(
          `INSERT INTO backup_restore_receipts (family_id, backup_id, restored_by, imported_medicine_count)
           VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING RETURNING backup_id`,
          [ctx.familyId, validation.value.backupId, ctx.userId],
        );
        if (receipt.rowCount === 0) throw new TransactionConflictError(409, BACKUP_ALREADY_IMPORTED);
        let count = 0;
        for (const rawMedicine of validation.value.medicines) {
          const parsed = validateMedicineInput(rawMedicine);
          if (!parsed.ok) throw new TransactionConflictError(400, errorBody("VALIDATION_ERROR", parsed.message));
          const medicine = await insertMedicine(tx, ctx.familyId, parsed.value, ctx.userId);
          for (const fields of parsed.value.batches) {
            await insertBatch(tx, medicine.id, ctx.familyId, fields, ctx.userId);
          }
          if (rawMedicine.isArchived) {
            await archiveMedicine(tx, medicine.id, ctx.familyId, ctx.userId);
          }
          count += 1;
        }
        await tx.query(
          "UPDATE backup_restore_receipts SET imported_medicine_count = $3 WHERE family_id = $1 AND backup_id = $2",
          [ctx.familyId, validation.value.backupId, count],
        );
        return count;
      });
      const response: BackupRestoreResponse = { restoredCount, backupId: validation.value.backupId };
      return reply.code(201).send(response);
    } catch (error) {
      if (error instanceof TransactionConflictError) return reply.code(error.statusCode).send(error.body);
      throw error;
    }
  });
}
