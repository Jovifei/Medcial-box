import { Pool } from "pg";
import type { Database, QueryResult, QueryRunner } from "./types.js";

export function createDatabasePool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/**
 * 生产数据库适配器（审核修复 #6）：把 Pool 包装成 Database——
 * withTransaction 绑定单个 PoolClient 执行 BEGIN/fn/COMMIT/ROLLBACK，
 * server.ts 与真实 PostgreSQL 集成测试共用同一实现，保证事务语义一致。
 */
export function createDatabaseAdapter(pool: Pool): Database {
  return {
    query: async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
      const result = await pool.query(sql, params);
      return result as QueryResult<T>;
    },
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
}
