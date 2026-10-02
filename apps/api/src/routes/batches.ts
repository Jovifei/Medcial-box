// 批次端点（药品作用域）：列表、新建、编辑（version → 409）、进入回收站。
// 审核修复 #3：批次的增/改/删都在单连接事务内执行，并在成功后递增药品聚合
// 版本——药品整体保存以药品版本为锁，旧页面保存会撞 409，不再静默删除
// 他人并发新增的批次。
import type { FastifyInstance } from "fastify";
import type { Database } from "../types.js";
import { errorBody, TransactionConflictError } from "../types.js";
import { decimalOrNull } from "../domain/decimal.js";
import { requireFamily } from "../auth/session.js";
import {
  deleteBatch,
  decrementUnopenedBatchForSplit,
  findBatchInMedicine,
  insertOpenedBatchSplit,
  insertBatch,
  lockBatchInMedicine,
  listBatchesByMedicine,
  toBatchSummary,
  updateBatch,
} from "../repositories/batches.js";
import { bumpMedicineVersion, findMedicineInFamily, lockMedicineInFamily } from "../repositories/medicines.js";
import { isMeasuredUnit, validateBatchInput, validateBatchSplitInput, validateBatchUpdateInput } from "../inputs.js";

const MEDICINE_NOT_FOUND_BODY = errorBody("NOT_FOUND", "药品不存在或不在当前家庭中");
const BATCH_NOT_FOUND_BODY = errorBody("NOT_FOUND", "批次不存在或不在当前药品下");
const CONFLICT_BODY = errorBody("VERSION_CONFLICT", "记录已被他人修改，请刷新后重试");

export async function registerBatchRoutes(
  app: FastifyInstance,
  database: Database,
): Promise<void> {
  app.get("/api/v1/medicines/:medicineId/batches", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId } = request.params as { medicineId: string };

    const medicine = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (medicine === null) return reply.code(404).send(MEDICINE_NOT_FOUND_BODY);
    const batchRows = await listBatchesByMedicine(database, medicineId, ctx.familyId);
    return { batches: batchRows.map((row) => toBatchSummary(row)) };
  });

  app.post("/api/v1/medicines/:medicineId/batches", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId } = request.params as { medicineId: string };
    const parsed = validateBatchInput(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", parsed.message));
    }

    try {
      const batch = await database.withTransaction(async (tx) => {
        const medicine = await lockMedicineInFamily(tx, medicineId, ctx.familyId);
        if (medicine === null) {
          throw new TransactionConflictError(404, MEDICINE_NOT_FOUND_BODY);
        }
        const batchRow = await insertBatch(tx, medicineId, ctx.familyId, parsed.value, ctx.userId);
        const bumped = await bumpMedicineVersion(tx, medicineId, ctx.familyId, ctx.userId);
        if (!bumped) {
          throw new TransactionConflictError(404, MEDICINE_NOT_FOUND_BODY);
        }
        return batchRow;
      });
      return reply.code(201).send(toBatchSummary(batch));
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        return reply.code(error.statusCode).send(error.body);
      }
      throw error;
    }
  });

  app.put("/api/v1/medicines/:medicineId/batches/:batchId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId, batchId } = request.params as {
      medicineId: string;
      batchId: string;
    };
    const parsed = validateBatchUpdateInput(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", parsed.message));
    }

    try {
      const updated = await database.withTransaction(async (tx) => {
        const medicine = await lockMedicineInFamily(tx, medicineId, ctx.familyId);
        if (medicine === null) {
          throw new TransactionConflictError(404, MEDICINE_NOT_FOUND_BODY);
        }
        const existing = await findBatchInMedicine(tx, batchId, medicineId, ctx.familyId);
        if (existing === null) {
          throw new TransactionConflictError(404, BATCH_NOT_FOUND_BODY);
        }
        const row = await updateBatch(
          tx,
          batchId,
          medicineId,
          ctx.familyId,
          parsed.value,
          ctx.userId,
          parsed.value.version,
        );
        if (row === null) {
          throw new TransactionConflictError(409, CONFLICT_BODY);
        }
        const bumped = await bumpMedicineVersion(tx, medicineId, ctx.familyId, ctx.userId);
        if (!bumped) {
          throw new TransactionConflictError(404, MEDICINE_NOT_FOUND_BODY);
        }
        return row;
      });
      return toBatchSummary(updated);
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        return reply.code(error.statusCode).send(error.body);
      }
      throw error;
    }
  });

  app.post("/api/v1/medicines/:medicineId/batches/:batchId/open-split", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId, batchId } = request.params as { medicineId: string; batchId: string };
    const parsed = validateBatchSplitInput(request.body);
    if (!parsed.ok) return reply.code(400).send(errorBody("VALIDATION_ERROR", parsed.message));

    try {
      const split = await database.withTransaction(async (tx) => {
        // 先锁聚合根再锁批次，与其他批次写操作保持同一锁顺序。
        const medicine = await lockMedicineInFamily(tx, medicineId, ctx.familyId);
        if (medicine === null) throw new TransactionConflictError(404, MEDICINE_NOT_FOUND_BODY);
        if (medicine.is_archived) {
          throw new TransactionConflictError(409, errorBody("VERSION_CONFLICT", "已归档药品不能拆分批次"));
        }

        const existing = await lockBatchInMedicine(tx, batchId, medicineId, ctx.familyId);
        if (existing === null) throw new TransactionConflictError(404, BATCH_NOT_FOUND_BODY);
        if (existing.version !== parsed.value.version) {
          throw new TransactionConflictError(409, CONFLICT_BODY);
        }
        const existingQuantity = decimalOrNull(existing.quantity);
        if (existingQuantity === null || existingQuantity === 0) {
          throw new TransactionConflictError(409, errorBody("VERSION_CONFLICT", "数量未知或为零的批次不能拆分"));
        }
        if (existing.opened_state !== "unopened" || existing.disposition_status !== "active") {
          throw new TransactionConflictError(409, errorBody("VERSION_CONFLICT", "只有未开封且未处理的批次可以拆分"));
        }
        // 计件单位（片/粒/盒…）开封数量必须是整数；毫升批次允许小数（如 2.5ml）。
        if (!isMeasuredUnit(existing.unit) && !Number.isInteger(parsed.value.openedQuantity)) {
          throw new TransactionConflictError(400, errorBody("VALIDATION_ERROR", "开封数量在计件单位下必须是整数"));
        }
        if (parsed.value.openedQuantity >= existingQuantity) {
          throw new TransactionConflictError(400, errorBody("VALIDATION_ERROR", "开封数量必须小于当前批次数量"));
        }

        const remainingBatch = await decrementUnopenedBatchForSplit(
          tx,
          batchId,
          medicineId,
          ctx.familyId,
          parsed.value.openedQuantity,
          parsed.value.version,
          ctx.userId,
        );
        if (remainingBatch === null) throw new TransactionConflictError(409, CONFLICT_BODY);

        const openedBatch = await insertOpenedBatchSplit(
          tx,
          batchId,
          medicineId,
          ctx.familyId,
          remainingBatch.version,
          parsed.value.openedQuantity,
          parsed.value.openedAt,
          parsed.value.afterOpeningLimit,
          ctx.userId,
        );
        if (openedBatch === null) throw new TransactionConflictError(409, CONFLICT_BODY);

        const bumped = await bumpMedicineVersion(tx, medicineId, ctx.familyId, ctx.userId);
        if (!bumped) throw new TransactionConflictError(404, MEDICINE_NOT_FOUND_BODY);

        // 006 的行级触发器会分别记录原批次余量和新批次；此事件将两条记录的
        // 业务关系归并成一个可读的拆分操作，和库存修改同事务提交。
        await tx.query(
          `INSERT INTO audit_events (family_id, actor_id, entity_type, entity_id, action, changes)
           VALUES ($1, $2, 'batch', $3, 'split_opened', $4::jsonb)`,
          [
            ctx.familyId,
            ctx.userId,
            openedBatch.id,
            JSON.stringify({
              sourceBatchId: batchId,
              openedQuantity: parsed.value.openedQuantity,
              remainingQuantity: remainingBatch.quantity,
              unit: existing.unit,
              openedAt: parsed.value.openedAt,
              afterOpeningLimit: parsed.value.afterOpeningLimit,
            }),
          ],
        );

        return { remainingBatch, openedBatch };
      });

      return reply.code(201).send({
        openedBatch: toBatchSummary(split.openedBatch),
        remainingBatch: toBatchSummary(split.remainingBatch),
      });
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        return reply.code(error.statusCode).send(error.body);
      }
      throw error;
    }
  });

  // 删除批次进入 30 天回收站，保留版本与审计记录；同样递增药品聚合版本。
  app.delete("/api/v1/medicines/:medicineId/batches/:batchId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId, batchId } = request.params as {
      medicineId: string;
      batchId: string;
    };

    try {
      const deleted = await database.withTransaction(async (tx) => {
        const medicine = await lockMedicineInFamily(tx, medicineId, ctx.familyId);
        if (medicine === null) {
          throw new TransactionConflictError(404, MEDICINE_NOT_FOUND_BODY);
        }
        const removed = await deleteBatch(tx, batchId, medicineId, ctx.familyId, ctx.userId);
        if (!removed) {
          throw new TransactionConflictError(404, BATCH_NOT_FOUND_BODY);
        }
        const bumped = await bumpMedicineVersion(tx, medicineId, ctx.familyId, ctx.userId);
        if (!bumped) {
          throw new TransactionConflictError(404, MEDICINE_NOT_FOUND_BODY);
        }
        return true;
      });
      if (deleted) return reply.code(204).send();
      return reply.code(404).send(BATCH_NOT_FOUND_BODY);
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        return reply.code(error.statusCode).send(error.body);
      }
      throw error;
    }
  });
}
