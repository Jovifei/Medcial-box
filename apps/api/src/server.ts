import { buildServer } from "./app.js";
import { createDatabasePool } from "./db.js";
import { applyMigrations } from "./db/migrations.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be configured by the local environment or container.");
  }

  const pool = createDatabasePool(databaseUrl);
  try {
    await applyMigrations(pool);
    const app = await buildServer({ database: { query: (sql) => pool.query(sql) } });
    app.addHook("onClose", async () => pool.end());
    const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
    // Local development defaults to loopback; containers set API_HOST=0.0.0.0.
    const host = process.env.API_HOST ?? "127.0.0.1";
    await app.listen({ host, port });
  } catch (error) {
    await pool.end();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error("API startup failed", error);
  process.exitCode = 1;
});
