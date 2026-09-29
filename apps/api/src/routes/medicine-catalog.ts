import type { FastifyInstance } from "fastify";
import { requireFamily } from "../auth/session.js";
import { createRateLimiter } from "../rate-limit.js";
import {
  MedicineCatalogUnavailableError,
  type MedicineCatalogProvider,
} from "../services/medicine-catalog.js";
import { errorBody } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIdentifier(body: Record<string, unknown>, field: string): string | undefined | null {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > 160) return null;
  return value.trim();
}

export async function registerMedicineCatalogRoutes(
  app: FastifyInstance,
  provider: MedicineCatalogProvider,
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
    if (body.consentToShare !== true) {
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
      return await provider.search({
        ...(name ? { name } : {}),
        ...(manufacturer ? { manufacturer } : {}),
        ...(approvalNumber ? { approvalNumber } : {}),
        ...(barcode ? { barcode } : {}),
        ...(specification ? { specification } : {}),
        consentToShare: true,
      });
    } catch (error) {
      if (error instanceof MedicineCatalogUnavailableError) {
        request.log.warn({ reason: error.message }, "medicine catalog unavailable");
        return reply.code(503).send(errorBody("MEDICINE_CATALOG_UNAVAILABLE", "药品资料查询暂不可用，请核对包装或稍后重试"));
      }
      request.log.error("medicine catalog adapter failed");
      return reply.code(503).send(errorBody("MEDICINE_CATALOG_UNAVAILABLE", "药品资料查询暂不可用，请核对包装或稍后重试"));
    }
  });
}
