import { createHash } from "node:crypto";
// 药品端点（家庭作用域）：列表、详情、新建、编辑（version → 409）、归档。
// 审核修复 #2/#3：创建（药品+初始批次）与编辑（药品+批次同步）都在
// database.withTransaction 内绑定同一连接执行，任一步失败整体回滚。
import type { FastifyInstance } from "fastify";
import type { MedicationBatchSummary, MedicationSummary } from "@home-medicine/contracts";
import type { Database } from "../types.js";
import { errorBody, TransactionConflictError } from "../types.js";
import { requireFamily } from "../auth/session.js";
import {
  archiveMedicine,
  findMedicineInFamily,
  insertMedicine,
  listMedicines,
  lockMedicineInFamily,
  toMedicineSummary,
  updateMedicine,
  type MedicineRow,
} from "../repositories/medicines.js";
import {
  deleteBatch,
  insertBatch,
  listBatchesByFamily,
  listBatchesByMedicine,
  toBatchSummary,
  updateBatch,
} from "../repositories/batches.js";
import {
  validateMedicineInput,
  validateMedicineUpdateInput,
} from "../inputs.js";

const NOT_FOUND_BODY = errorBody("NOT_FOUND", "药品不存在或不在当前家庭中");
const CONFLICT_BODY = errorBody("VERSION_CONFLICT", "记录已被他人修改，请刷新后重试");

export async function buildFamilyMedicineSummaries(
  database: Database,
  familyId: string,
  medicineRows: MedicineRow[],
  now: Date = new Date(),
): Promise<MedicationSummary[]> {
  const batchRows = await listBatchesByFamily(database, familyId);
  const byMedicine = new Map<string, MedicationBatchSummary[]>();
  for (const row of batchRows) {
    const summary = toBatchSummary(row, now);
    const existing = byMedicine.get(row.medicine_id);
    if (existing === undefined) {
      byMedicine.set(row.medicine_id, [summary]);
    } else {
      existing.push(summary);
    }
  }
  return medicineRows.map((row) => toMedicineSummary(row, byMedicine.get(row.id) ?? [], now));
}

export async function registerMedicineRoutes(
  app: FastifyInstance,
  database: Database,
): Promise<void> {
  app.get("/api/v1/medicines", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const query = (request.query ?? {}) as { includeArchived?: string };
    const includeArchived = query.includeArchived === "true";
    const medicineRows = await listMedicines(database, ctx.familyId, includeArchived);
    const medicines = await buildFamilyMedicineSummaries(database, ctx.familyId, medicineRows);
    return { medicines };
  });

  app.post("/api/v1/medicines", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const parsed = validateMedicineInput(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", parsed.message));
    }

    const key = (request.body as { idempotencyKey?: unknown }).idempotencyKey;
    if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(key))) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "提交标识格式不正确"));
    }
    const hash = createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex");
    try {
      // 药品与初始批次同事务写入：中途失败整体回滚，不会留下半成品记录。
      const created = await database.withTransaction(async (tx) => {
        if (typeof key === "string") {
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([ctx.familyId, ctx.userId, key])]);
          const receipt = await tx.query<{payload_hash: string; response: MedicationSummary}>(
            "SELECT payload_hash, response FROM medicine_create_receipts WHERE family_id=$1 AND user_id=$2 AND request_key=$3", [ctx.familyId, ctx.userId, key]);
          const previous = receipt.rows[0];
          if (previous) {
            if (previous.payload_hash !== hash) throw new TransactionConflictError(409, errorBody("VERSION_CONFLICT", "相同提交标识的内容已改变，请核对已保存记录"));
            return previous.response;
          }
        }
        const medicine = await insertMedicine(tx, ctx.familyId, parsed.value, ctx.userId);
        const batches: MedicationBatchSummary[] = [];
        for (const batchFields of parsed.value.batches) {
          const batchRow = await insertBatch(tx, medicine.id, ctx.familyId, batchFields, ctx.userId);
          batches.push(toBatchSummary(batchRow));
        }
        const summary = toMedicineSummary(medicine, batches);
        if (typeof key === "string") await tx.query("INSERT INTO medicine_create_receipts (family_id,user_id,request_key,payload_hash,response) VALUES ($1,$2,$3,$4,$5)", [ctx.familyId,ctx.userId,key,hash,JSON.stringify(summary)]);
        return summary;
      });
      return reply.code(201).send(created);
    } catch (error) {
      if (error instanceof TransactionConflictError) return reply.code(error.statusCode).send(error.body);
      throw error;
    }
  });

  app.get("/api/v1/medicines/:medicineId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId } = request.params as { medicineId: string };

    const medicine = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (medicine === null) return reply.code(404).send(NOT_FOUND_BODY);
    const batchRows = await listBatchesByMedicine(database, medicineId, ctx.familyId);
    const now = new Date();
    return toMedicineSummary(medicine, batchRows.map((row) => toBatchSummary(row, now)), now);
  });

  app.put("/api/v1/medicines/:medicineId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId } = request.params as { medicineId: string };
    try {
      // 单连接事务：药品版本更新 + 批次同步（按 id 增/改/删）。
      // 页面提交的批次带 id/version；未出现在提交里的已有批次 = 用户已删除。
      const summary = await database.withTransaction(async (tx) => {
        const existing = await lockMedicineInFamily(tx, medicineId, ctx.familyId);
        if (existing === null) {
          throw new TransactionConflictError(404, NOT_FOUND_BODY);
        }
        const existingRows = await listBatchesByMedicine(tx, medicineId, ctx.familyId);
        const parsed = validateMedicineUpdateInput(request.body, existingRows);
        if (!parsed.ok) throw new TransactionConflictError(400, errorBody("VALIDATION_ERROR", parsed.message));
        const updated = await updateMedicine(
          tx,
          medicineId,
          ctx.familyId,
          parsed.value,
          ctx.userId,
          parsed.value.version,
        );
        if (updated === null) {
          throw new TransactionConflictError(409, CONFLICT_BODY);
        }

        const byId = new Map(existingRows.map((row) => [row.id, row]));
        const keptIds = new Set<string>();
        for (const fields of parsed.value.batches) {
          if (fields.id === null) {
            const row = await insertBatch(tx, medicineId, ctx.familyId, fields, ctx.userId);
            keptIds.add(row.id);
            continue;
          }
          const current = byId.get(fields.id);
          if (current === undefined) {
            throw new TransactionConflictError(
              404,
              errorBody("NOT_FOUND", "批次不存在或已被删除，请刷新后重试"),
            );
          }
          // 页面未带版本时退回当前版本（药品级 version 仍是主并发门）。
          const expectedVersion = fields.version ?? current.version;
          const row = await updateBatch(
            tx,
            fields.id,
            medicineId,
            ctx.familyId,
            fields,
            ctx.userId,
            expectedVersion,
          );
          if (row === null) {
            throw new TransactionConflictError(409, CONFLICT_BODY);
          }
          keptIds.add(row.id);
        }
        for (const row of existingRows) {
          if (!keptIds.has(row.id)) {
            const deleted = await deleteBatch(tx, row.id, medicineId, ctx.familyId, ctx.userId);
            if (!deleted) {
              throw new TransactionConflictError(
                404,
                errorBody("NOT_FOUND", "批次不存在或已被删除，请刷新后重试"),
              );
            }
          }
        }

        const batchRows = await listBatchesByMedicine(tx, medicineId, ctx.familyId);
        const now = new Date();
        return toMedicineSummary(updated, batchRows.map((row) => toBatchSummary(row, now)), now);
      });
      return summary;
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        return reply.code(error.statusCode).send(error.body);
      }
      throw error;
    }
  });

  // 归档 = 软删除；幂等：已归档仍返回 204，且不校验 version。
  app.delete("/api/v1/medicines/:medicineId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId } = request.params as { medicineId: string };

    const archived = await archiveMedicine(database, medicineId, ctx.familyId, ctx.userId);
    if (archived) return reply.code(204).send();
    const existing = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (existing === null) return reply.code(404).send(NOT_FOUND_BODY);
    return reply.code(204).send();
  });
}
