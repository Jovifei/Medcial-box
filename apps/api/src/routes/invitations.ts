// P2 家庭共享端点（错误语义与 B1/B2 一致）：
// - POST /api/v1/families/invitations       仅 owner；明文邀请码只返回一次，服务端只存 sha256；
// - POST /api/v1/families/invitations/accept 已登录用户凭明文加入；已有家庭 409；过期/已用 410；无效 404；
// - DELETE /api/v1/families/members/{id}    仅 owner；不能移除自己/owner；移除后成员关系消失，
//   被移除者的后续请求在认证 preHandler 查不到成员关系 → 404 FAMILY_NOT_FOUND（会话本身不撤销，
//   从其设计文档 §5 的安排）。
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "../types.js";
import { errorBody, toIso } from "../types.js";
import { sha256Hex } from "../auth/session.js";
import { requireFamily } from "../auth/session.js";
import {
  asMemberRole,
  deleteMemberById,
  findFamilyById,
  findMemberById,
  findMembershipByUserId,
  insertFamilyMember,
} from "../repositories/families.js";
import { consumeInvite, findInviteByTokenHash, insertInvite } from "../repositories/invites.js";

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

const OWNER_ONLY_BODY = errorBody("OWNER_ONLY", "仅家庭 owner 可以执行此操作");
const NOT_FOUND_BODY = errorBody("NOT_FOUND", "成员不存在或不在当前家庭中");

function validateCode(raw: unknown): string | null {
  const code = typeof raw === "string" ? raw.trim() : "";
  return code === "" ? null : code;
}

export async function registerInvitationRoutes(
  app: FastifyInstance,
  database: Database,
): Promise<void> {
  app.post("/api/v1/families/invitations", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const auth = request.auth;
    if (auth === null || auth.role !== "owner") {
      return reply.code(403).send(OWNER_ONLY_BODY);
    }

    const invitationCode = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await insertInvite(database, ctx.familyId, sha256Hex(invitationCode), ctx.userId, expiresAt);
    return reply.code(201).send({
      invitationCode,
      expiresAt: toIso(expiresAt),
    });
  });

  app.post("/api/v1/families/invitations/accept", async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = validateCode(body.code);
    if (code === null) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "邀请码不能为空"));
    }

    const tokenHash = sha256Hex(code);
    const invite = await findInviteByTokenHash(database, tokenHash);
    if (invite === null) {
      return reply.code(404).send(errorBody("NOT_FOUND", "邀请码无效或已被撤销"));
    }
    if (new Date(toIso(invite.expires_at)).getTime() <= Date.now()) {
      return reply.code(410).send(errorBody("INVITATION_EXPIRED", "邀请码已过期，请向 owner 重新索取"));
    }
    if (invite.used_at !== null) {
      return reply.code(410).send(errorBody("INVITATION_USED", "邀请码已被使用"));
    }

    // 已有家庭的用户不得加入第二个家庭（不自动搬移/合并药品）。
    const existingMembership = await findMembershipByUserId(database, auth.userId);
    if (existingMembership !== null) {
      return reply
        .code(409)
        .send(errorBody("ALREADY_IN_FAMILY", "已属于一个家庭，如需更换请先由 owner 移除"));
    }

    // 事务内：先建成员关系，再原子消费邀请；消费失败（并发复用）整体回滚。
    await database.query("BEGIN");
    try {
      const membership = await insertFamilyMember(database, invite.family_id, auth.userId, "member");
      const consumed = await consumeInvite(database, tokenHash, auth.userId);
      if (consumed === null) {
        await database.query("ROLLBACK");
        return reply
          .code(410)
          .send(errorBody("INVITATION_USED", "邀请码已被使用，请向 owner 重新索取"));
      }
      const family = await findFamilyById(database, invite.family_id);
      if (family === null) {
        await database.query("ROLLBACK");
        return reply.code(404).send(errorBody("NOT_FOUND", "邀请对应的家庭不存在"));
      }
      await database.query("COMMIT");
      return {
        family: { id: family.id, name: family.name },
        membership: {
          id: membership.id,
          role: asMemberRole(membership.role),
          joinedAt: toIso(membership.joined_at),
        },
      };
    } catch (error) {
      await database.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });

  app.delete("/api/v1/families/members/:memberId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const auth = request.auth;
    if (auth === null || auth.role !== "owner") {
      return reply.code(403).send(OWNER_ONLY_BODY);
    }
    const { memberId } = request.params as { memberId: string };

    const target = await findMemberById(database, memberId, ctx.familyId);
    if (target === null) {
      return reply.code(404).send(NOT_FOUND_BODY);
    }
    if (target.user_id === ctx.userId) {
      // D3：本轮不提供自助退出，owner 移除自己属 backlog。
      return reply.code(403).send(errorBody("FORBIDDEN", "不能移除自己；如需退出家庭请联系后续版本支持"));
    }
    if (target.role === "owner") {
      return reply.code(403).send(errorBody("FORBIDDEN", "不能移除家庭 owner"));
    }

    const deleted = await deleteMemberById(database, memberId, ctx.familyId);
    if (!deleted) return reply.code(404).send(NOT_FOUND_BODY);
    return reply.code(204).send();
  });
}
