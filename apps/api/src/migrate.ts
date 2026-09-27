import { createDatabasePool } from "./db.js";
import { applyMigrations } from "./db/migrations.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !process.env.PGHOST) {
    throw new Error("Configure DATABASE_URL or the PGHOST/PGUSER/PGPASSWORD/PGDATABASE variables.");
  }

  const pool = createDatabasePool(databaseUrl);
  try {
    const applied = await applyMigrations(pool);
    console.info(applied.length === 0 ? "Database schema is current." : `Applied: ${applied.join(", ")}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Database migration failed", error);
  process.exitCode = 1;
});
