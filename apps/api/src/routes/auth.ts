// POST /api/v1/auth/wechat — 微信登录：code 换 openid，签发随机令牌（仅存哈希）。
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../types.js";
import { errorBody, toIso } from "../types.js";
import type { WechatGateway } from "../auth/wechat.js";
import { WechatCodeError } from "../auth/wechat.js";
import {
  issueSessionToken,
  parseBearerToken,
  revokeSessionToken,
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
