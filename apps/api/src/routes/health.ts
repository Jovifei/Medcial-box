import type { HealthStatus } from "@home-medicine/contracts";
import type { FastifyInstance } from "fastify";

export interface HealthDatabase {
  query(sql: string): Promise<unknown>;
}

/**
 * Build identity stamped into the production image at build time
 * (Dockerfile ENV from the MEDBOX_* build args). Both fields stay absent
 * when the build did not stamp them (local runs, tests), so health
 * responses never claim a version the build cannot prove.
 */
function readBuildInfo(): Pick<HealthStatus, "version" | "build"> {
  const version = process.env.MEDBOX_VERSION?.trim();
  const build = process.env.MEDBOX_SOURCE_SHA?.trim();
  return {
    ...(version ? { version } : {}),
    ...(build ? { build } : {}),
  };
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  database: HealthDatabase,
): Promise<void> {
  const buildInfo = readBuildInfo();
  app.get<{ Reply: HealthStatus }>("/api/v1/health/live", async () => ({ status: "ok", ...buildInfo }));

  app.get<{ Reply: HealthStatus }>("/api/v1/health/ready", async (request, reply) => {
    try {
      await database.query("SELECT 1");
      return { status: "ok", database: "connected", ...buildInfo };
    } catch (error) {
      // Server-side log only; the response stays generic to avoid leaking details.
      request.log.error({ err: error }, "Database readiness check failed");
      return reply.code(503).send({ status: "unavailable", database: "disconnected" });
    }
  });
}
