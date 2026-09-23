import type { HealthStatus } from "@home-medicine/contracts";
import type { FastifyInstance } from "fastify";

export interface HealthDatabase {
  query(sql: string): Promise<unknown>;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  database: HealthDatabase,
): Promise<void> {
  app.get<{ Reply: HealthStatus }>("/api/v1/health/live", async () => ({ status: "ok" }));

  app.get<{ Reply: HealthStatus }>("/api/v1/health/ready", async (request, reply) => {
    try {
      await database.query("SELECT 1");
      return { status: "ok", database: "connected" };
    } catch (error) {
      // Server-side log only; the response stays generic to avoid leaking details.
      request.log.error({ err: error }, "Database readiness check failed");
      return reply.code(503).send({ status: "unavailable", database: "disconnected" });
    }
  });
}
