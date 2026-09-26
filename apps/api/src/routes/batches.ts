// 批次端点（药品作用域）：列表、新建、编辑（version → 409）、物理删除。
// 审核修复 #3：批次的增/改/删都在单连接事务内执行，并在成功后递增药品聚合
// 版本——药品整体保存以药品版本为锁，旧页面保存会撞 409，不再静默删除
// 他人并发新增的批次。
import type { FastifyInstance } from "fastify";
import type { Database } from "../types.js";
import { errorBody, TransactionConflictError } from "../types.js";
import { requireFamily } from "../auth/session.js";
import {
  deleteBatch,
  findBatchInMedicine,
  insertBatch,
  listBatchesByMedicine,
  toBatchSummary,
  updateBatch,
} from "../repositories/batches.js";
import { bumpMedicineVersion, findMedicineInFamily } from "../repositories/medicines.js";
import { validateBatchInput, validateBatchUpdateInput } from "../inputs.js";

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
        const medicine = await findMedicineInFamily(tx, medicineId, ctx.familyId);
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
        const medicine = await findMedicineInFamily(tx, medicineId, ctx.familyId);
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

  // 批次录错即删：物理删除，无批次版本校验；同样递增药品聚合版本。
  app.delete("/api/v1/medicines/:medicineId/batches/:batchId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId, batchId } = request.params as {
      medicineId: string;
      batchId: string;
    };

    try {
      const deleted = await database.withTransaction(async (tx) => {
        const medicine = await findMedicineInFamily(tx, medicineId, ctx.familyId);
        if (medicine === null) {
          throw new TransactionConflictError(404, MEDICINE_NOT_FOUND_BODY);
        }
        const removed = await deleteBatch(tx, batchId, medicineId, ctx.familyId);
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
