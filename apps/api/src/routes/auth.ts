// POST /api/v1/auth/wechat — 微信登录：code 换 openid，签发随机令牌（仅存哈希）。
import type { FastifyInstance } from "fastify";
import type { Database } from "../types.js";
import { errorBody, toIso } from "../types.js";
import type { WechatGateway } from "../auth/wechat.js";
import { WechatCodeError } from "../auth/wechat.js";
import { issueSessionToken } from "../auth/session.js";
import { findUserByOpenid, insertUser } from "../repositories/users.js";
import { findMembershipByUserId } from "../repositories/families.js";

export interface AuthRouteDeps {
  database: Database;
  wechatGateway: WechatGateway;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRouteDeps,
): Promise<void> {
  const { database, wechatGateway } = deps;

  app.post("/api/v1/auth/wechat", async (request, reply) => {
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
