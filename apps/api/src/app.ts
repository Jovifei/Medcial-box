import Fastify from "fastify";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "./types.js";
import { errorBody } from "./types.js";
import type { WechatGateway } from "./auth/wechat.js";
import { createDefaultWechatGateway } from "./auth/wechat.js";
import { registerAuth } from "./auth/session.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFamilyRoutes } from "./routes/families.js";
import { registerMedicineRoutes } from "./routes/medicines.js";
import { registerBatchRoutes } from "./routes/batches.js";
import { registerDosageNoteRoutes } from "./routes/dosage-notes.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerInvitationRoutes } from "./routes/invitations.js";

export interface BuildServerOptions {
  database: Database;
  /** Defaults to the real HTTP gateway (env credentials); tests inject a fake. */
  wechatGateway?: WechatGateway;
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions) {
  const app = Fastify({ logger: options.logger ?? true });

  // 统一错误 shape：{ error: { code, message } }；内部细节只进服务端日志。
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error.validation !== undefined || error.statusCode === 400) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "请求格式不正确"));
    }
    request.log.error({ err: error }, "Unhandled request failure");
    return reply.code(500).send(errorBody("INTERNAL_ERROR", "服务暂时不可用，请稍后重试"));
  });

  await registerHealthRoutes(app, options.database);
  await registerAuth(app, options.database);

  const deps = {
    database: options.database,
    wechatGateway: options.wechatGateway ?? createDefaultWechatGateway(),
  };
  await registerAuthRoutes(app, deps);
  await registerFamilyRoutes(app, options.database);
  await registerMedicineRoutes(app, options.database);
  await registerBatchRoutes(app, options.database);
  await registerDosageNoteRoutes(app, options.database);
  await registerExportRoutes(app, options.database);
  await registerInvitationRoutes(app, options.database);

  return app;
}
