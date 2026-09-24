// 个人剂量备注端点：
// - 列表：本人全部 + 他人 family 可见；
// - 编辑/删除：仅备注所属成员（SQL 绑定 user_id），他人备注不可见即 404；
// - 编辑带 version，不匹配 → 409。
import type { FastifyInstance } from "fastify";
import type { Database } from "../types.js";
import { errorBody } from "../types.js";
import { requireFamily } from "../auth/session.js";
import {
  deleteNote,
  findNoteOwned,
  insertNote,
  listVisibleNotes,
  toNoteSummary,
  updateNote,
} from "../repositories/notes.js";
import { findMedicineInFamily } from "../repositories/medicines.js";
import { validateNoteInput, validateNoteUpdateInput } from "../inputs.js";

const MEDICINE_NOT_FOUND_BODY = errorBody("NOT_FOUND", "药品不存在或不在当前家庭中");
const NOTE_NOT_FOUND_BODY = errorBody("NOT_FOUND", "备注不存在或不可见");
const CONFLICT_BODY = errorBody("VERSION_CONFLICT", "记录已被他人修改，请刷新后重试");

export async function registerDosageNoteRoutes(
  app: FastifyInstance,
  database: Database,
): Promise<void> {
  app.get("/api/v1/medicines/:medicineId/dosage-notes", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId } = request.params as { medicineId: string };

    const medicine = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (medicine === null) return reply.code(404).send(MEDICINE_NOT_FOUND_BODY);
    const noteRows = await listVisibleNotes(
      database,
      medicineId,
      ctx.familyId,
      ctx.userId,
    );
    return { notes: noteRows.map((row) => toNoteSummary(row, ctx.userId)) };
  });

  app.post("/api/v1/medicines/:medicineId/dosage-notes", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId } = request.params as { medicineId: string };
    const parsed = validateNoteInput(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", parsed.message));
    }

    const medicine = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (medicine === null) return reply.code(404).send(MEDICINE_NOT_FOUND_BODY);
    const noteRow = await insertNote(
      database,
      ctx.familyId,
      medicineId,
      ctx.userId,
      parsed.value.content,
      parsed.value.visibility,
    );
    return reply.code(201).send(toNoteSummary(noteRow, ctx.userId));
  });

  app.put("/api/v1/medicines/:medicineId/dosage-notes/:noteId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId, noteId } = request.params as {
      medicineId: string;
      noteId: string;
    };
    const parsed = validateNoteUpdateInput(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", parsed.message));
    }

    const medicine = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (medicine === null) return reply.code(404).send(MEDICINE_NOT_FOUND_BODY);
    const existing = await findNoteOwned(
      database,
      noteId,
      medicineId,
      ctx.familyId,
      ctx.userId,
    );
    if (existing === null) return reply.code(404).send(NOTE_NOT_FOUND_BODY);

    const content = parsed.value.content ?? existing.content;
    const updated = await updateNote(
      database,
      noteId,
      medicineId,
      ctx.familyId,
      ctx.userId,
      content,
      parsed.value.visibility,
      parsed.value.version,
    );
    if (updated === null) return reply.code(409).send(CONFLICT_BODY);
    return toNoteSummary(updated, ctx.userId);
  });

  app.delete("/api/v1/medicines/:medicineId/dosage-notes/:noteId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const { medicineId, noteId } = request.params as {
      medicineId: string;
      noteId: string;
    };

    const medicine = await findMedicineInFamily(database, medicineId, ctx.familyId);
    if (medicine === null) return reply.code(404).send(MEDICINE_NOT_FOUND_BODY);
    const deleted = await deleteNote(
      database,
      noteId,
      medicineId,
      ctx.familyId,
      ctx.userId,
    );
    if (!deleted) return reply.code(404).send(NOTE_NOT_FOUND_BODY);
    return reply.code(204).send();
  });
}
