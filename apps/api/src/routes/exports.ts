import type { FastifyInstance } from "fastify";
import type { Database } from "../types.js";
import { errorBody } from "../types.js";
import { requireFamily } from "../auth/session.js";
import type { MarkdownExportOptions } from "../services/markdown-export.js";
import { renderMarkdownExport } from "../services/markdown-export.js";
import { ExportSnapshotStore, readInventoryExportSnapshot } from "../services/export-snapshot.js";
import { renderCsvExport } from "../services/csv-export.js";
import { renderPdfExport } from "../services/pdf-export.js";

function optionsFor(body: Record<string, unknown>): MarkdownExportOptions {
 return { includePersonalDosage: body.includePersonalDosage === true, includeArchived: body.includeArchived === true, includeStorageLocation: body.includeStorageLocation !== false };
}
export async function registerExportRoutes(app: FastifyInstance, database: Database): Promise<void> {
 const store = new ExportSnapshotStore();
 app.addHook("onClose", async () => { store.clear(); });
 for (const format of ["snapshot", "markdown", "csv", "pdf"] as const) {
  app.post(`/api/v1/exports/${format}`, async (request, reply) => {
   const ctx = requireFamily(request, reply); if (ctx === null) return;
   const body = (request.body ?? {}) as Record<string, unknown>;
   if (typeof body !== "object" || Array.isArray(body) || ["includePersonalDosage", "includeArchived", "includeStorageLocation"].some((key) => body[key] !== undefined && typeof body[key] !== "boolean")) return reply.code(400).send(errorBody("VALIDATION_ERROR", "导出选项不合法"));
   const options = optionsFor(body);
   let snapshot;
   if (body.snapshotId !== undefined) {
    if (typeof body.snapshotId !== "string" || format === "snapshot") return reply.code(400).send(errorBody("VALIDATION_ERROR", "快照标识不合法"));
    snapshot = store.get(body.snapshotId, ctx.userId, ctx.familyId);
    if (snapshot === null) return reply.code(404).send(errorBody("NOT_FOUND", "导出快照已失效，请重新生成"));
    if (JSON.stringify(options) !== JSON.stringify(snapshot.options)) return reply.code(400).send(errorBody("VALIDATION_ERROR", "选项已变化，请重新生成导出快照"));
   } else {
    const medicines = await readInventoryExportSnapshot(database, ctx.userId, ctx.familyId, options);
    if (medicines === null) return reply.code(403).send(errorBody("FORBIDDEN", "当前家庭权限已失效"));
    snapshot = store.put(ctx.userId, ctx.familyId, medicines, options);
   }
   if (format === "snapshot") return snapshot;
   const metadata = { generatedAt: snapshot.generatedAt, snapshotId: snapshot.snapshotId };
   if (format === "markdown") return { markdown: renderMarkdownExport(snapshot.medicines, snapshot.options, new Date(snapshot.generatedAt)), ...metadata };
   const date = snapshot.generatedAt.slice(0, 10);
   if (format === "csv") return { content: renderCsvExport(snapshot), fileName: `家庭药箱-${date}.csv`, mimeType: "text/csv; charset=utf-8", ...metadata };
   const content = await renderPdfExport(snapshot);
   return { contentBase64: Buffer.from(content).toString("base64"), fileName: `家庭药箱-${date}.pdf`, mimeType: "application/pdf", ...metadata };
  });
 }
}
