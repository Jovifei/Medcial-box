// POST /api/v1/auth/wechat — 微信登录：code 换 openid，签发随机令牌（仅存哈希）。
import { randomBytes, randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../types.js";
import { errorBody, toIso } from "../types.js";
import type { WechatGateway } from "../auth/wechat.js";
import { WechatCodeError } from "../auth/wechat.js";
import {
  issueSessionToken,
  parseBearerToken,
  revokeSessionToken,
  SESSION_TTL_MS,
  sha256Hex,
} from "../auth/session.js";
import { findUserById, findUserByOpenid, insertUser, updateUserNickname } from "../repositories/users.js";
import {
  asMemberRole,
  findFamilyById,
  findMembershipByUserId,
} from "../repositories/families.js";
import { clientAddress, createRateLimiter } from "../rate-limit.js";

const MAX_NICKNAME_LENGTH = 40;

export interface AuthRouteDeps {
  database: Database;
  wechatGateway: WechatGateway;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRouteDeps,
): Promise<void> {
  const { database, wechatGateway } = deps;
  const loginRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });
  const deviceStartRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });
  const deviceApproveRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });
  const deviceExchangeRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });

  app.post("/api/v1/auth/device-links", async (request, reply) => {
    if (!deviceStartRateLimit(clientAddress(request))) {
      return reply.code(429).send(errorBody("RATE_LIMITED", "设备连接请求过于频繁，请稍后重试"));
    }
    const link = await database.withTransaction(async (tx) => {
      const now = new Date();
      await tx.query(
        "DELETE FROM device_link_requests WHERE expires_at <= ($1::timestamptz - interval '1 day')",
        [now],
      );
      const attemptedCodes = new Set<string>();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = String(randomInt(10_000_000, 100_000_000));
        if (attemptedCodes.has(code)) continue;
        attemptedCodes.add(code);
        const pollToken = randomBytes(32).toString("hex");
        const expiresAt = new Date(now.getTime() + 5 * 60_000);
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO device_link_requests (code_hash, poll_token_hash, expires_at)
           VALUES ($1, $2, $3) ON CONFLICT (code_hash) DO NOTHING RETURNING id`,
          [sha256Hex(code), sha256Hex(pollToken), expiresAt],
        );
        if (inserted.rowCount !== 0) return { code, pollToken, expiresAt };
      }
      return null;
    });
    if (link === null) return reply.code(503).send(errorBody("INTERNAL_ERROR", "连接码生成暂不可用，请稍后重试"));
    return reply.code(201).send({ code: link.code, pollToken: link.pollToken, expiresAt: link.expiresAt.toISOString() });
  });

  app.post("/api/v1/auth/device-links/approve", async (request, reply) => {
    if (!deviceApproveRateLimit(clientAddress(request))) {
      return reply.code(429).send(errorBody("RATE_LIMITED", "设备确认请求过于频繁，请稍后重试"));
    }
    const auth = request.auth;
    if (auth === null || auth.familyId === null) {
      return reply.code(404).send(errorBody("FAMILY_NOT_FOUND", "请先登录并加入家庭"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^\d{8}$/.test(code)) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "连接码格式不正确"));
    }
    const approved = await database.withTransaction(async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE device_link_requests
         SET status = 'approved', user_id = $2, family_id = $3, approved_at = now()
         WHERE code_hash = $1 AND status = 'pending' AND expires_at > now() AND attempts < 10
         RETURNING id`,
        [sha256Hex(code), auth.userId, auth.familyId],
      );
      return result.rowCount !== 0;
    });
    if (!approved) return reply.code(404).send(errorBody("NOT_FOUND", "连接码无效、已过期或已使用"));
    return { approved: true as const };
  });

  app.post("/api/v1/auth/device-links/exchange", async (request, reply) => {
    if (!deviceExchangeRateLimit(clientAddress(request))) {
      return reply.code(429).send(errorBody("RATE_LIMITED", "设备连接查询过于频繁，请稍后重试"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const pollToken = typeof body.pollToken === "string" ? body.pollToken.trim() : "";
    if (!/^[a-f0-9]{64}$/i.test(pollToken)) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "设备连接凭据格式不正确"));
    }
    const result = await database.withTransaction(async (tx) => {
      const lookup = await tx.query<{
        id: string;
        status: "pending" | "approved" | "exchanged";
        user_id: string | null;
        family_id: string | null;
        expires_at: Date | string;
      }>(
        "SELECT id, status, user_id, family_id, expires_at FROM device_link_requests WHERE poll_token_hash = $1 FOR UPDATE",
        [sha256Hex(pollToken)],
      );
      const link = lookup.rows[0];
      if (link === undefined || new Date(toIso(link.expires_at)).getTime() <= Date.now() || link.status === "exchanged") {
        return { state: "expired" as const };
      }
      if (link.status === "pending" || link.user_id === null) {
        return { state: "pending" as const };
      }
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      const consumed = await tx.query<{ id: string }>(
        "UPDATE device_link_requests SET status = 'exchanged', exchanged_at = now() WHERE id = $1 AND status = 'approved' AND expires_at > now() RETURNING id",
        [link.id],
      );
      if (consumed.rowCount === 0) return { state: "expired" as const };
      const membership = await findMembershipByUserId(tx, link.user_id);
      if (membership === null || membership.family_id !== link.family_id) return { state: "expired" as const };
      await tx.query(
        "INSERT INTO sessions (user_id, token_hash, expires_at, client_kind) VALUES ($1, $2, $3, 'android')",
        [link.user_id, sha256Hex(token), expiresAt],
      );
      return {
        state: "approved" as const,
        token,
        expiresAt: expiresAt.toISOString(),
        user: { id: link.user_id, hasFamily: true },
      };
    });
    return reply.code(200).send(result);
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    }

    const user = await findUserById(database, auth.userId);
    if (user === null) {
      return reply
        .code(401)
        .send(errorBody("UNAUTHORIZED", "登录状态无效，请重新登录"));
    }

    const family = auth.familyId === null ? null : await findFamilyById(database, auth.familyId);
    return {
      user: {
        id: user.id,
        nickname: user.nickname,
        hasFamily: family !== null,
      },
      family:
        family === null
          ? null
          : {
              id: family.id,
              name: family.name,
              role: asMemberRole(auth.role ?? "member"),
            },
    };
  });

  app.get("/api/v1/auth/devices", async (request, reply) => {
    const auth = request.auth;
    if (auth === null) return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    const result = await database.query<{
      id: string;
      client_kind: "miniprogram" | "android";
      created_at: Date | string;
      expires_at: Date | string;
    }>(
      "SELECT id, client_kind, created_at, expires_at FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY created_at, id",
      [auth.userId],
    );
    return {
      devices: result.rows.map((session) => ({
        id: session.id,
        clientKind: session.client_kind,
        createdAt: toIso(session.created_at),
        expiresAt: toIso(session.expires_at),
        isCurrent: session.id === auth.sessionId,
      })),
    };
  });

  app.post<{ Params: { sessionId: string } }>("/api/v1/auth/devices/:sessionId/revoke", async (request, reply) => {
    const auth = request.auth;
    if (auth === null) return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    if (!/^[0-9a-f-]{36}$/i.test(request.params.sessionId)) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "设备会话 ID 格式不正确"));
    }
    if (request.params.sessionId === auth.sessionId) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "当前设备请使用退出登录"));
    }
    const revoked = await database.query<{ id: string }>(
      "DELETE FROM sessions WHERE id = $1 AND user_id = $2 AND client_kind = 'android' RETURNING id",
      [request.params.sessionId, auth.userId],
    );
    if (revoked.rowCount === 0) return reply.code(404).send(errorBody("NOT_FOUND", "Android 设备会话不存在"));
    return { revoked: true as const };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = parseBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "缺少登录凭据，请先登录"));
    }
    await revokeSessionToken(database, token);
    return { revoked: true as const };
  });

  const updateNickname = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.auth;
    if (auth === null) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const rawNickname = body.nickname;
    if (rawNickname !== null && typeof rawNickname !== "string") {
      return reply
        .code(400)
        .send(errorBody("VALIDATION_ERROR", "昵称必须是文本或 null"));
    }
    const nickname = typeof rawNickname === "string" ? rawNickname.trim() : null;
    if (nickname !== null && Array.from(nickname).length > MAX_NICKNAME_LENGTH) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION_ERROR", `昵称不能超过 ${MAX_NICKNAME_LENGTH} 个字符`));
    }

    const user = await updateUserNickname(database, auth.userId, nickname === "" ? null : nickname);
    if (user === null) {
      return reply
        .code(401)
        .send(errorBody("UNAUTHORIZED", "登录状态无效，请重新登录"));
    }
    return { user: { id: user.id, nickname: user.nickname } };
  };

  // 保留 REST PATCH 契约；微信小程序客户端使用 POST 兼容入口，
  // 因为部分 wx.request 运行时不接受 PATCH 作为 method。
  app.patch("/api/v1/users/me", updateNickname);
  app.post("/api/v1/users/me/nickname", updateNickname);

  app.post("/api/v1/auth/wechat", async (request, reply) => {
    if (!loginRateLimit(clientAddress(request))) {
      return reply.code(429).send(errorBody("RATE_LIMITED", "登录请求过于频繁，请稍后重试"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (code === "") {
      return reply
        .code(400)
        .send(errorBody("VALIDATION_ERROR", "缺少微信登录 code"));
    }

    let openid: string;
    try {
      const session = await wechatGateway.code2Session(code);
      openid = session.openid;
    } catch (error) {
      // Gateway details stay server-side; the response is generic.
      request.log.warn({ err: error }, "wechat code exchange failed");
      if (error instanceof WechatCodeError) {
        return reply
          .code(401)
          .send(errorBody("WECHAT_EXCHANGE_FAILED", "微信登录凭据无效，请重新登录"));
      }
      return reply
        .code(502)
        .send(errorBody("WECHAT_GATEWAY_ERROR", "微信服务暂时不可用，请稍后重试"));
    }

    let user = await findUserByOpenid(database, openid);
    if (user === null) {
      user = await insertUser(database, openid);
    }

    const membership = await findMembershipByUserId(database, user.id);
    const issued = await issueSessionToken(database, user.id);
    return {
      token: issued.token,
      expiresAt: toIso(issued.expiresAt),
      user: { id: user.id, hasFamily: membership !== null },
    };
  });
}
