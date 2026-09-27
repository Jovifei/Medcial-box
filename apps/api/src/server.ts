import { buildServer } from "./app.js";
import { createDatabaseAdapter, createDatabasePool } from "./db.js";
import { applyMigrations } from "./db/migrations.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !process.env.PGHOST) {
    throw new Error("Configure DATABASE_URL or the PGHOST/PGUSER/PGPASSWORD/PGDATABASE variables.");
  }

  const pool = createDatabasePool(databaseUrl);
  try {
    await applyMigrations(pool);
    const database = createDatabaseAdapter(pool);
    const app = await buildServer({ database });
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
