import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Pool } from "pg";

function numericPrefix(name: string): number {
  const match = /^(\d+)_/.exec(name);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Order by numeric filename prefix so 2_x runs before 10_x; ties fall back to
 * lexicographic order. Files without a numeric prefix sort last.
 */
export function orderMigrations(names: readonly string[]): string[] {
  return [...names].sort((a, b) => {
    const order = numericPrefix(a) - numericPrefix(b);
    return order !== 0 ? order : a < b ? -1 : a > b ? 1 : 0;
  });
}

export async function applyMigrations(pool: Pool, directory?: string): Promise<string[]> {
  const migrationDirectory = directory ?? fileURLToPath(new URL("../../db/migrations", import.meta.url));
  const files = (await readdir(migrationDirectory)).filter((name) =>
    /^\d+_[a-z0-9_-]+\.sql$/i.test(name),
  );
  const names = orderMigrations(files);
  const appliedNames: string[] = [];

  for (const name of names) {
    const sql = await readFile(resolve(migrationDirectory, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(1946438225)");
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [name],
      );

      if (existing.rowCount !== 0) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`Applied migration checksum changed: ${name}`);
        }
        await client.query("COMMIT");
        continue;
      }

      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        name,
        checksum,
      ]);
      await client.query("COMMIT");
      appliedNames.push(name);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return appliedNames;
}
