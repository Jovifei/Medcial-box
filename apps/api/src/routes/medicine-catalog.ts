import type { FastifyInstance } from "fastify";
import { requireFamily } from "../auth/session.js";
import { createRateLimiter } from "../rate-limit.js";
import {
  MedicineCatalogUnavailableError,
  type MedicineCatalogProvider,
} from "../services/medicine-catalog.js";
import { errorBody, type QueryRunner } from "../types.js";
import { localCandidate, type LocalCatalogEntry } from "../services/local-medicine-catalog.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIdentifier(body: Record<string, unknown>, field: string): string | undefined | null {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > 160) return null;
  return value.trim() || undefined;
}

export async function registerMedicineCatalogRoutes(
  app: FastifyInstance,
  provider: MedicineCatalogProvider,
  database?: QueryRunner,
): Promise<void> {
  const limitByUser = createRateLimiter({ windowMs: 60_000, maxRequests: 12 });

  app.post("/api/v1/medicine-catalog/candidates", async (request, reply) => {
    const context = requireFamily(request, reply);
    if (context === null) return;
    if (!limitByUser(context.userId)) {
      return reply.code(429).send(errorBody("RATE_LIMITED", "资料查询过于频繁，请稍后重试"));
    }
    if (!isRecord(request.body)) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "请求体必须是对象"));
    }
    const body = request.body;
    if (body.consentToShare !== true && provider.kind !== "local" && !body.barcode) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "联网查询前请确认允许发送药品标识"));
    }
    const name = readIdentifier(body, "name");
    const manufacturer = readIdentifier(body, "manufacturer");
    const approvalNumber = readIdentifier(body, "approvalNumber");
    const barcode = readIdentifier(body, "barcode");
    const specification = readIdentifier(body, "specification");
    if ([name, manufacturer, approvalNumber, barcode, specification].includes(null)) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "药品查询条件格式不正确"));
    }
    if (name === undefined && manufacturer === undefined && approvalNumber === undefined && barcode === undefined) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "请提供药名、厂家、批准文号或条码"));
    }

    try {
      if (database) {
        const params: unknown[] = [context.familyId];
        const conditions: string[] = [];
        if (barcode) { params.push(barcode); conditions.push("barcode_value = $2"); }
        else {
          if (name) { params.push(name); conditions.push(`strpos(lower(name), lower($${params.length})) > 0`); }
          for (const [column, value] of [["manufacturer", manufacturer], ["approval_number", approvalNumber], ["specification", specification]] as const) {
            if (value) { params.push(value); conditions.push(`${column} = $${params.length}`); }
          }
        }
        const result = await database.query<LocalCatalogEntry>(
          `SELECT name, barcode_value AS "barcodeValue", brand, specification, manufacturer,
                  approval_number AS "approvalNumber", active_ingredients AS "activeIngredients"
           FROM medicines WHERE family_id = $1 AND ${conditions.join(" AND ")} AND deleted_at IS NULL AND is_archived = FALSE ORDER BY created_at LIMIT 5`,
          params,
        );
        if (result.rows.length) return { candidates: result.rows.map(row => localCandidate({ ...row, source: "当前家庭已保存资料", reviewed: true }, barcode ? ["条码精确一致，仍请核对包装"] : ["当前家庭名称或商品标识匹配，请核对包装"])), warnings: ["当前家庭已有资料仅作候选，请核对本次包装。"] };
      }
      if (provider.kind !== "local" && body.consentToShare !== true) return reply.code(400).send(errorBody("VALIDATION_ERROR", "联网查询前请确认允许发送药品标识"));
      return await provider.search({
        ...(name ? { name } : {}),
        ...(manufacturer ? { manufacturer } : {}),
        ...(approvalNumber ? { approvalNumber } : {}),
        ...(barcode ? { barcode } : {}),
        ...(specification ? { specification } : {}),
        consentToShare: body.consentToShare === true,
      });
    } catch (error) {
      if (error instanceof MedicineCatalogUnavailableError) {
        request.log.warn({ reason: error.reason }, "medicine catalog unavailable");
        if (error.reason === "not_configured") {
          return reply.code(503).send(errorBody("MEDICINE_CATALOG_NOT_CONFIGURED", "药品资料查询服务尚未配置，请核对包装手动填写"));
        }
        return reply.code(503).send(errorBody("MEDICINE_CATALOG_UNAVAILABLE", "药品资料查询暂不可用，请核对包装或稍后重试"));
      }
      request.log.error("medicine catalog adapter failed");
      return reply.code(503).send(errorBody("MEDICINE_CATALOG_UNAVAILABLE", "药品资料查询暂不可用，请核对包装或稍后重试"));
    }
  });
}
