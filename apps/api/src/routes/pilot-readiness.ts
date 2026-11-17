import type { FastifyInstance } from "fastify";

function configured(value: string | undefined): "configured" | "not_configured" {
  return value && value.trim().length > 0 ? "configured" : "not_configured";
}

/**
 * Family pilot gate.
 * This is deliberately not a deployment health replacement. It reports
 * evidence currently available from configuration only and leaves runtime
 * probes to health/ready and authenticated pilot checks.
 */
export async function registerPilotReadinessRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/pilot/readiness", async () => {
    const recognitionProvider = process.env.MEDICINE_RECOGNITION_PROVIDER;
    const recognitionConfiguration = recognitionProvider === "tokenhub"
      ? process.env.TOKENHUB_API_KEY ?? process.env.TOKENHUB_BASE_URL
      : recognitionProvider === "moma"
        ? process.env.MOMA_API_KEY ?? process.env.MOMA_BASE_URL
        : process.env.DASHSCOPE_API_KEY ?? process.env.OLLAMA_BASE_URL;
    return {
      stage: "family-pilot",
      status: "evidence_only",
      checks: {
        database: "use_health_ready",
        wechat: {
          configuration: configured(process.env.WECHAT_APP_ID),
          oauthProbe: "not_run",
        },
        recognition: {
          configuration: configured(recognitionConfiguration),
          providerProbe: "not_run",
        },
        privatePhotoStore: "not_run",
      },
      release: {
        mergeAllowed: false,
        productionDeployment: false,
      },
    };
  });
}
