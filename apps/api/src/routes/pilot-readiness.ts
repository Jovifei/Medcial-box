import type { FastifyInstance } from "fastify";

/**
 * Read-only deployment gate for family pilot environments.
 * It intentionally reports configuration presence only, never values.
 */
export async function registerPilotReadinessRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/pilot/readiness", async () => ({
    stage: "family-pilot",
    status: "configured",
    checks: {
      api: "ready",
      database: "checked-by-health-ready",
      wechat: process.env.WECHAT_APP_ID ? "configured" : "not_configured",
      recognition: process.env.DASHSCOPE_API_KEY || process.env.OLLAMA_BASE_URL
        ? "configured"
        : "not_configured",
      privatePhotoStore: "runtime_checked",
    },
    release: {
      mergeAllowed: false,
      productionDeployment: false,
    },
  }));
}
