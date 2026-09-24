// POST /api/v1/exports/markdown — Markdown 库存导出。
// - 复用 B1 的会话/家庭校验与仓储；
// - includePersonalDosage 默认 false（true 时仅渲染当前用户有权查看的备注）；
// - includeArchived 默认 false（D4：归档药品显式请求时以"（已归档）"分区输出）；
// - includeStorageLocation 默认 true（D1）。
import type { FastifyInstance } from "fastify";
import type { MedicineRow } from "../repositories/medicines.js";
import { listMedicines } from "../repositories/medicines.js";
import type { Database } from "../types.js";
import { requireFamily } from "../auth/session.js";
import { buildFamilyMedicineSummaries } from "./medicines.js";
import { listVisibleNotes } from "../repositories/notes.js";
import type { ExportMedicine } from "../services/markdown-export.js";
import { renderMarkdownExport } from "../services/markdown-export.js";

export async function registerExportRoutes(
  app: FastifyInstance,
  database: Database,
): Promise<void> {
  app.post("/api/v1/exports/markdown", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const options = {
      includePersonalDosage: body.includePersonalDosage === true,
      includeArchived: body.includeArchived === true,
      includeStorageLocation: body.includeStorageLocation !== false,
    };

    const now = new Date();
    const medicineRows: MedicineRow[] = await listMedicines(
      database,
      ctx.familyId,
      options.includeArchived,
    );
    const summaries = await buildFamilyMedicineSummaries(
      database,
      ctx.familyId,
      medicineRows,
      now,
    );

    let exportMedicines: ExportMedicine[] = summaries;
    if (options.includePersonalDosage) {
      exportMedicines = [];
      for (const summary of summaries) {
        const noteRows = await listVisibleNotes(
          database,
          summary.id,
          ctx.familyId,
          ctx.userId,
        );
        exportMedicines.push({
          ...summary,
          dosageNotes: noteRows.map((row) => ({
            userId: row.user_id,
            isMine: row.user_id === ctx.userId,
            content: row.content,
          })),
        });
      }
    }

    const markdown = renderMarkdownExport(exportMedicines, options, now);
    return { markdown, generatedAt: now.toISOString() };
  });
}
