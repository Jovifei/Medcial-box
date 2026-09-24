// 药品端点（家庭作用域）：列表、详情、新建、编辑（version → 409）、归档。
import type { FastifyInstance } from "fastify";
import type { MedicationBatchSummary, MedicationSummary } from "@home-medicine/contracts";
import type { Database } from "../types.js";
import { errorBody } from "../types.js";
import { requireFamily } from "../auth/session.js";
import {
  archiveMedicine,
  findMedicineInFamily,
  insertMedicine,
  listMedicines,
  toMedicineSummary,
  updateMedicine,
  type MedicineRow,
} from "../repositories/medicines.js";
import {
  insertBatch,
  listBatchesByFamily,
  listBatchesByMedicine,
  toBatchSummary,
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
  return medicineRows.map((row) => toMedicineSummary(row, byMedicine.get(row.id) ?? []));
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

    const medicine = await insertMedicine(database, ctx.familyId, parsed.value, ctx.userId);
    const batches: MedicationBatchSummary[] = [];
    for (const batchFields of parsed.value.batches) {
      const batchRow = await insertBatch(
        database,
        medicine.id,
        ctx.familyId,
        batchFields,
        ctx.userId,
      );
      batches.push(toBatchSummary(batchRow));
    }
    return reply.code(201).send(toMedicineSummary(medicine, batches));
  });

  app.get("/api/v1/medicines/:medicineId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId } = request.params as { medicineId: string };

    const medicine = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (medicine === null) return reply.code(404).send(NOT_FOUND_BODY);
    const batchRows = await listBatchesByMedicine(database, medicineId, ctx.familyId);
    return toMedicineSummary(medicine, batchRows.map((row) => toBatchSummary(row)));
  });

  app.put("/api/v1/medicines/:medicineId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId } = request.params as { medicineId: string };
    const parsed = validateMedicineUpdateInput(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", parsed.message));
    }

    // 先确认存在 + 归属（跨家庭 → 404），再按版本更新（不匹配 → 409）。
    const existing = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (existing === null) return reply.code(404).send(NOT_FOUND_BODY);
    const updated = await updateMedicine(
      database,
      medicineId,
      ctx.familyId,
      parsed.value,
      ctx.userId,
      parsed.value.version,
    );
    if (updated === null) return reply.code(409).send(CONFLICT_BODY);

    const batchRows = await listBatchesByMedicine(database, medicineId, ctx.familyId);
    return toMedicineSummary(updated, batchRows.map((row) => toBatchSummary(row)));
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
