import Fastify from "fastify";
import type { HealthDatabase } from "./routes/health.js";
import { registerHealthRoutes } from "./routes/health.js";

export interface BuildServerOptions {
  database: HealthDatabase;
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions) {
  const app = Fastify({ logger: options.logger ?? true });
  await registerHealthRoutes(app, options.database);
  return app;
}
