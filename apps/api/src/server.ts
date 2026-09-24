import { buildServer } from "./app.js";
import { createDatabasePool } from "./db.js";
import { applyMigrations } from "./db/migrations.js";
import type { Database, QueryResult, QueryRunner } from "./types.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be configured by the local environment or container.");
  }

  const pool = createDatabasePool(databaseUrl);
  try {
    await applyMigrations(pool);
    const database: Database = {
      query: async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
        const result = await pool.query(sql, params);
        return result as QueryResult<T>;
      },
      // 事务绑定单个连接：pool.connect 后同一 PoolClient 执行 BEGIN/语句/COMMIT，
      // 避免连接池把多步写入分散到不同连接导致事务失效。
      withTransaction: async <T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          try {
            const result = await fn(client as unknown as QueryRunner);
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          }
        } finally {
          client.release();
        }
      },
    };
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
