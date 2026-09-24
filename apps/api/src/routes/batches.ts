// 批次端点（药品作用域）：列表、新建、编辑（version → 409）、物理删除。
import type { FastifyInstance } from "fastify";
import type { Database } from "../types.js";
import { errorBody } from "../types.js";
import { requireFamily } from "../auth/session.js";
import {
  deleteBatch,
  findBatchInMedicine,
  insertBatch,
  listBatchesByMedicine,
  toBatchSummary,
  updateBatch,
} from "../repositories/batches.js";
import { findMedicineInFamily } from "../repositories/medicines.js";
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

    const medicine = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (medicine === null) return reply.code(404).send(MEDICINE_NOT_FOUND_BODY);
    const batchRow = await insertBatch(
      database,
      medicineId,
      ctx.familyId,
      parsed.value,
      ctx.userId,
    );
    return reply.code(201).send(toBatchSummary(batchRow));
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

    const medicine = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (medicine === null) return reply.code(404).send(MEDICINE_NOT_FOUND_BODY);
    const existing = await findBatchInMedicine(
      database,
      batchId,
      medicineId,
      ctx.familyId,
    );
    if (existing === null) return reply.code(404).send(BATCH_NOT_FOUND_BODY);
    const updated = await updateBatch(
      database,
      batchId,
      medicineId,
      ctx.familyId,
      parsed.value,
      ctx.userId,
      parsed.value.version,
    );
    if (updated === null) return reply.code(409).send(CONFLICT_BODY);
    return toBatchSummary(updated);
  });

  // 批次录错即删：物理删除，无版本校验。
  app.delete("/api/v1/medicines/:medicineId/batches/:batchId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId, batchId } = request.params as {
      medicineId: string;
      batchId: string;
    };

    const medicine = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (medicine === null) return reply.code(404).send(MEDICINE_NOT_FOUND_BODY);
    const deleted = await deleteBatch(database, batchId, medicineId, ctx.familyId);
    if (!deleted) return reply.code(404).send(BATCH_NOT_FOUND_BODY);
    return reply.code(204).send();
  });
}
