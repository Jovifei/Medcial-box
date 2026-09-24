// Shared infrastructure types: database abstraction, auth context and the
// unified error body used by every API route.
import type { ApiErrorCode } from "@home-medicine/contracts";

export type { ApiErrorCode };

export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

/**
 * 最小查询面：仓储层只依赖它。pg.Pool 与事务客户端都满足该结构，
 * 保证多步写入可以通过同一连接执行（见 Database.withTransaction）。
 */
export interface QueryRunner {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/**
 * 数据库抽象。`pg.Pool` 满足该结构（连接池实现 withTransaction 时绑定
 * 单个 PoolClient）；合成测试注入的假池同样实现 withTransaction。
 */
export interface Database extends QueryRunner {
  /**
   * 在绑定单一连接的事务中执行 `fn`：BEGIN → fn → COMMIT，异常时 ROLLBACK。
   * 任何多步写入（建家庭、接受邀请、转让所有权、药品+批次）都必须走本接口，
   * 禁止用多次 pool.query 手工拼 BEGIN/COMMIT（连接池会把语句分散到不同连接）。
   */
  withTransaction<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T>;
}

export interface AuthContext {
  userId: string;
  familyId: string | null;
  role: "owner" | "member" | null;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

/** Build the unified error response body: { error: { code, message } }. */
export function errorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

/** Normalize pg Date / string / number timestamps into ISO strings. */
export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  return new Date(String(value)).toISOString();
}

/** jsonb arrays arrive either pre-parsed (pg) or as text (synthetic rows). */
export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      // Fall through to the empty default below.
    }
  }
  return [];
}

/** 事务内业务冲突：回滚事务后由路由映射为对应的 4xx 响应。 */
export class TransactionConflictError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.error.message);
  }
}
