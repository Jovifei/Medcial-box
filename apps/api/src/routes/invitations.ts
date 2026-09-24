// P2 家庭共享端点（错误语义与 B1/B2 一致）：
// - POST /api/v1/families/invitations       仅 owner；明文邀请码只返回一次，服务端只存 sha256；
// - POST /api/v1/families/invitations/accept 已登录用户凭明文加入；已有家庭 409；过期/已用 410；无效 404；
// - DELETE /api/v1/families/members/{id}    仅 owner；不能移除自己/owner；移除后成员关系消失，
//   被移除者的后续请求在认证 preHandler 查不到成员关系 → 404 FAMILY_NOT_FOUND（会话本身不撤销，
//   从其设计文档 §5 的安排）。
// - POST /api/v1/families/leave             成员自助退出（Jovi 决策 D3）；owner 不能直接退出，
//   需先转让所有权；仅剩 owner 的家庭其解散/数据删除在 P4 定义前不可退出。
// - POST /api/v1/families/members/{id}/transfer-ownership 仅 owner；目标必须是本家庭的普通成员；
//   事务内双方角色互换，任一失败整体回滚。
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "../types.js";
import { errorBody, toIso, TransactionConflictError } from "../types.js";
import { sha256Hex } from "../auth/session.js";
import { requireFamily } from "../auth/session.js";
import {
  asMemberRole,
  countMembersByFamily,
  deleteMemberById,
  deleteMembershipByUserId,
  findFamilyById,
  findMemberById,
  findMembershipByUserId,
  insertFamilyMember,
  updateMemberRole,
  updateMemberRoleByUserId,
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

    // 事务绑定同一连接：先建成员关系，再原子消费邀请；消费失败（并发复用）整体回滚。
    try {
      return await database.withTransaction(async (tx) => {
        const membership = await insertFamilyMember(tx, invite.family_id, auth.userId, "member");
        const consumed = await consumeInvite(tx, tokenHash, auth.userId);
        if (consumed === null) {
          throw new TransactionConflictError(
            410,
            errorBody("INVITATION_USED", "邀请码已被使用，请向 owner 重新索取"),
          );
        }
        const family = await findFamilyById(tx, invite.family_id);
        if (family === null) {
          throw new TransactionConflictError(
            404,
            errorBody("NOT_FOUND", "邀请对应的家庭不存在"),
          );
        }
        return {
          family: { id: family.id, name: family.name },
          membership: {
            id: membership.id,
            role: asMemberRole(membership.role),
            joinedAt: toIso(membership.joined_at),
          },
        };
      });
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        return reply.code(error.statusCode).send(error.body);
      }
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
      // 自助退出走 POST /api/v1/families/leave，本端点面向 owner 移除他人。
      return reply.code(403).send(errorBody("FORBIDDEN", "不能移除自己；如需退出请使用“退出家庭”"));
    }
    if (target.role === "owner") {
      return reply.code(403).send(errorBody("FORBIDDEN", "不能移除家庭 owner"));
    }

    const deleted = await deleteMemberById(database, memberId, ctx.familyId);
    if (!deleted) return reply.code(404).send(NOT_FOUND_BODY);
    return reply.code(204).send();
  });

  // 成员自助退出（D3）：普通成员立即删除自己的成员关系，
  // 后续请求在认证 preHandler 查不到成员关系 → 404 FAMILY_NOT_FOUND。
  app.post("/api/v1/families/leave", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const auth = request.auth;
    if (auth === null) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    }
    if (auth.role !== "owner") {
      const deleted = await deleteMembershipByUserId(database, auth.userId);
      if (!deleted) return reply.code(404).send(NOT_FOUND_BODY);
      return reply.code(204).send();
    }
    // owner 退出需先转让所有权；仅剩 owner 时解散/数据删除在 P4 定义前不可用。
    const memberCount = await countMembersByFamily(database, ctx.familyId);
    if (memberCount > 1) {
      return reply
        .code(409)
        .send(errorBody("OWNER_CANNOT_LEAVE", "owner 不能直接退出：请先把所有权转让给其他成员"));
    }
    return reply
      .code(409)
      .send(
        errorBody("OWNER_CANNOT_LEAVE", "解散家庭与数据删除将在后续版本提供，当前无法退出仅剩自己的家庭"),
      );
  });

  // 转让所有权（D3 配套）：owner 把家庭让给一名普通成员。
  // 并发保护（审核修复 #4）：事务绑定同一连接；FOR UPDATE 锁家庭行串行化
  // 并发转让；事务内重验双方角色；先降级后升级（配合 004 的单 owner 唯一索引，
  // 避免瞬态双 owner 触发约束冲突）。
  app.post("/api/v1/families/members/:memberId/transfer-ownership", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const auth = request.auth;
    if (auth === null || auth.role !== "owner") {
      return reply.code(403).send(OWNER_ONLY_BODY);
    }
    const { memberId } = request.params as { memberId: string };

    try {
      return await database.withTransaction(async (tx) => {
        const locked = await tx.query<{ id: string }>(
          "SELECT id FROM families WHERE id = $1 FOR UPDATE",
          [ctx.familyId],
        );
        if (locked.rowCount === 0) {
          throw new TransactionConflictError(
            404,
            errorBody("FAMILY_NOT_FOUND", "家庭不存在"),
          );
        }
        // 事务内重验当前用户仍是 owner（preHandler 之后可能发生并发转让）。
        const current = await tx.query<{ role: string }>(
          "SELECT role FROM family_members WHERE user_id = $1 AND family_id = $2 FOR UPDATE",
          [ctx.userId, ctx.familyId],
        );
        if (current.rows[0]?.role !== "owner") {
          throw new TransactionConflictError(
            409,
            errorBody("VERSION_CONFLICT", "家庭成员状态已变化，请刷新后重试"),
          );
        }
        const target = await findMemberById(tx, memberId, ctx.familyId);
        if (target === null) {
          throw new TransactionConflictError(404, NOT_FOUND_BODY);
        }
        if (target.user_id === ctx.userId) {
          throw new TransactionConflictError(
            400,
            errorBody("VALIDATION_ERROR", "不能把所有权转让给自己"),
          );
        }
        if (target.role !== "member") {
          throw new TransactionConflictError(
            400,
            errorBody("VALIDATION_ERROR", "目标成员已是 owner"),
          );
        }
        const demoted = await updateMemberRoleByUserId(tx, ctx.userId, ctx.familyId, "member");
        if (demoted === null) {
          throw new TransactionConflictError(
            404,
            errorBody("FAMILY_NOT_FOUND", "当前成员关系不存在"),
          );
        }
        const promoted = await updateMemberRole(tx, memberId, ctx.familyId, "owner");
        if (promoted === null) {
          throw new TransactionConflictError(404, NOT_FOUND_BODY);
        }
        return {
          membership: {
            id: promoted.id,
            role: asMemberRole(promoted.role),
            joinedAt: toIso(promoted.joined_at),
          },
        };
      });
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        return reply.code(error.statusCode).send(error.body);
      }
      throw error;
    }
  });
}
