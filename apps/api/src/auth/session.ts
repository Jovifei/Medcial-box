// 会话令牌与认证 preHandler：
// - 明文令牌由 crypto.randomBytes 生成，仅在登录响应出现一次；
// - 数据库只存 sha256 哈希与过期时间；
// - 每个受保护请求在 preHandler 中解析 Bearer 令牌并注入 request.auth。
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext, Database } from "../types.js";
import { errorBody, toIso } from "../types.js";
import {
  asMemberRole,
  findMembershipByUserId,
} from "../repositories/families.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

/** Issue a fresh opaque token and persist only its sha256 hash. */
export async function issueSessionToken(
  database: Database,
  userId: string,
  now: Date = new Date(),
): Promise<IssuedSession> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await database.query(
    "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, sha256Hex(token), expiresAt],
  );
  return { token, expiresAt };
}

export function parseBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

const PUBLIC_PATHS = new Set<string>(["/api/v1/auth/wechat"]);

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith("/api/v1/health");
}

interface SessionLookupRow {
  id: string;
  user_id: string;
  expires_at: Date | string;
}

export async function registerAuth(
  app: FastifyInstance,
  database: Database,
): Promise<void> {
  app.decorateRequest("auth", null);
  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (isPublicPath(path)) return;

    const token = parseBearerToken(request.headers.authorization);
    if (token === null) {
      reply.code(401).send(errorBody("UNAUTHORIZED", "缺少登录凭据，请先登录"));
      return;
    }

    const sessions = await database.query<SessionLookupRow>(
      "SELECT id, user_id, expires_at FROM sessions WHERE token_hash = $1",
      [sha256Hex(token)],
    );
    const session = sessions.rows[0];
    if (session === undefined) {
      reply.code(401).send(errorBody("UNAUTHORIZED", "登录状态无效，请重新登录"));
      return;
    }
    if (new Date(toIso(session.expires_at)).getTime() <= Date.now()) {
      reply.code(401).send(errorBody("SESSION_EXPIRED", "登录已过期，请重新登录"));
      return;
    }

    // 成员关系每次请求都查库：owner 移除成员后其会话立即失去家庭数据访问。
    const membership = await findMembershipByUserId(database, session.user_id);
    const auth: AuthContext = {
      userId: session.user_id,
      familyId: membership === null ? null : membership.family_id,
      role: membership === null ? null : asMemberRole(membership.role),
    };
    request.auth = auth;
  });
}

export interface FamilyContext {
  familyId: string;
  userId: string;
}

/**
 * Guard for endpoints that require family membership. A session without a
 * family gets 404 FAMILY_NOT_FOUND (guides the client to onboarding) — 401 is
 * reserved for token problems only.
 */
export function requireFamily(
  request: FastifyRequest,
  reply: FastifyReply,
): FamilyContext | null {
  const auth = request.auth;
  if (auth === null || auth.familyId === null) {
    reply.code(404).send(errorBody("FAMILY_NOT_FOUND", "尚未创建或加入家庭"));
    return null;
  }
  return { familyId: auth.familyId, userId: auth.userId };
}
