// Shared infrastructure types: database abstraction, auth context and the
// unified error body used by every API route.
import type { ApiErrorCode } from "@home-medicine/contracts";

export type { ApiErrorCode };

export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

/**
 * Minimal database surface used by repositories. `pg.Pool` satisfies this
 * structurally; synthetic tests inject a scripted fake pool instead.
 */
export interface Database {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
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
