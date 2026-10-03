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
import { createRateLimiter } from "../rate-limit.js";
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
import { cancelDeliveriesForMember } from "../jobs/reminder-scheduler.js";
import { cancelDoseReminders, cancelDoseRemindersForMember } from "../jobs/dose-reminder-scheduler.js";

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
  const previewRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });
  const acceptRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });

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

  app.post("/api/v1/families/invitations/preview", async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    }
    if (!previewRateLimit(auth.userId)) {
      return reply.code(429).send(errorBody("RATE_LIMITED", "邀请码查询过于频繁，请稍后重试"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = validateCode(body.invitationCode);
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

    const family = await findFamilyById(database, invite.family_id);
    if (family === null) {
      return reply.code(404).send(errorBody("NOT_FOUND", "邀请对应的家庭不存在"));
    }

    // 预览只读取邀请码与家庭最小信息，绝不消费邀请码或返回成员/库存。
    return {
      family: { id: family.id, name: family.name },
      expiresAt: toIso(invite.expires_at),
    };
  });

  app.post("/api/v1/families/invitations/accept", async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    }
    if (!acceptRateLimit(auth.userId)) {
      return reply.code(429).send(errorBody("RATE_LIMITED", "加入请求过于频繁，请稍后重试"));
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

    // 与转让/退出共用家庭行锁串行化（审核修复 #5），事务内复核：
    // 自己仍是 owner、目标仍是普通成员，删除才生效。
    try {
      await database.withTransaction(async (tx) => {
        const locked = await tx.query<{ id: string }>(
          "SELECT id FROM families WHERE id = $1 FOR UPDATE",
          [ctx.familyId],
        );
        if (locked.rowCount === 0) {
          throw new TransactionConflictError(404, errorBody("FAMILY_NOT_FOUND", "家庭不存在"));
        }
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
            403,
            errorBody("FORBIDDEN", "不能移除自己；如需退出请使用“退出家庭”"),
          );
        }
        if (target.role !== "member") {
          throw new TransactionConflictError(
            403,
            errorBody("FORBIDDEN", "不能移除家庭 owner"),
          );
        }
        const removedUserId = target.user_id ?? "";
        if (removedUserId === "") {
          throw new TransactionConflictError(404, NOT_FOUND_BODY);
        }
        const careOwned = await tx.query(`SELECT id FROM care_profiles WHERE family_id=$1 AND linked_user_id IS NULL AND COALESCE(managed_by,created_by)=$2 AND archived_at IS NULL FOR UPDATE`, [ctx.familyId, removedUserId]);
        if ((careOwned.rowCount ?? 0) > 0) throw new TransactionConflictError(409, errorBody("CARE_HANDOVER_REQUIRED", "请先交接或归档本人管理的照护对象，再退出或移除成员"));
        const deleted = await deleteMemberById(tx, memberId, ctx.familyId);
        if (!deleted) {
          throw new TransactionConflictError(404, NOT_FOUND_BODY);
        }
        // 同一事务内作废被移除成员的排队提醒与授权（A07）：离开即不该再收到消息。
        await cancelDeliveriesForMember(tx, ctx.familyId, removedUserId);
        // B07：撤销其照护授权与未来服药投递——重新加入不复活旧权限。
        await tx.query(
          "DELETE FROM care_grants WHERE family_id = $1 AND member_user_id = $2",
          [ctx.familyId, removedUserId],
        );
        await cancelDoseRemindersForMember(tx, ctx.familyId, removedUserId);
        // Archive profiles rather than resurrecting creator authority on rejoin.
        await tx.query(`UPDATE care_profiles SET archived_at=now()
          WHERE family_id=$1 AND linked_user_id=$2 AND archived_at IS NULL`, [ctx.familyId, removedUserId]);
        await tx.query(`UPDATE medication_plans SET status='ended', version=version+1, updated_at=now()
          WHERE family_id=$1 AND care_profile_id IN (SELECT id FROM care_profiles WHERE family_id=$1 AND archived_at IS NOT NULL) AND status <> 'ended'`, [ctx.familyId]);
        await cancelDoseReminders(tx, "family_id=$1 AND plan_id IN (SELECT p.id FROM medication_plans p JOIN care_profiles c ON c.id=p.care_profile_id WHERE c.archived_at IS NOT NULL)", [ctx.familyId]);
      });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        return reply.code(error.statusCode).send(error.body);
      }
      throw error;
    }
  });

  // 成员自助退出（D3）：与转让/移除共用家庭行锁串行化（审核修复 #5），
  // 事务内复核自己的当前角色——若并发转让已把普通成员提升为 owner，
  // 这里会按 owner 规则拒绝，而不是删掉唯一的 owner。
  app.post("/api/v1/families/leave", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const auth = request.auth;
    if (auth === null) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    }
    try {
      await database.withTransaction(async (tx) => {
        const locked = await tx.query<{ id: string }>(
          "SELECT id FROM families WHERE id = $1 FOR UPDATE",
          [ctx.familyId],
        );
        if (locked.rowCount === 0) {
          throw new TransactionConflictError(404, errorBody("FAMILY_NOT_FOUND", "家庭不存在"));
        }
        const current = await tx.query<{ id: string; role: string }>(
          "SELECT id, role FROM family_members WHERE user_id = $1 AND family_id = $2 FOR UPDATE",
          [ctx.userId, ctx.familyId],
        );
        const role = current.rows[0]?.role;
        if (role === undefined) {
          throw new TransactionConflictError(
            404,
            errorBody("FAMILY_NOT_FOUND", "当前成员关系不存在"),
          );
        }
        if (role === "owner") {
          const memberCount = await countMembersByFamily(tx, ctx.familyId);
          if (memberCount > 1) {
            throw new TransactionConflictError(
              409,
              errorBody("OWNER_CANNOT_LEAVE", "owner 不能直接退出：请先把所有权转让给其他成员"),
            );
          }
          throw new TransactionConflictError(
            409,
            errorBody(
              "OWNER_CANNOT_LEAVE",
              "解散家庭与数据删除将在后续版本提供，当前无法退出仅剩自己的家庭",
            ),
          );
        }
        const careOwned = await tx.query(`SELECT id FROM care_profiles WHERE family_id=$1 AND linked_user_id IS NULL AND COALESCE(managed_by,created_by)=$2 AND archived_at IS NULL FOR UPDATE`, [ctx.familyId, auth.userId]);
        if ((careOwned.rowCount ?? 0) > 0) throw new TransactionConflictError(409, errorBody("CARE_HANDOVER_REQUIRED", "请先交接或归档本人管理的照护对象，再退出或移除成员"));
        const deleted = await deleteMembershipByUserId(tx, auth.userId);
        if (!deleted) {
          throw new TransactionConflictError(404, NOT_FOUND_BODY);
        }
        // 退出即取消本人待发提醒与授权（A07）。
        await cancelDeliveriesForMember(tx, ctx.familyId, auth.userId);
        // B07：退出同样撤销其照护授权与未来服药投递；重入不复活。
        await tx.query(
          "DELETE FROM care_grants WHERE family_id = $1 AND member_user_id = $2",
          [ctx.familyId, auth.userId],
        );
        await cancelDoseRemindersForMember(tx, ctx.familyId, auth.userId);
        // Archive profiles rather than resurrecting creator authority on rejoin.
        await tx.query(`UPDATE care_profiles SET archived_at=now()
          WHERE family_id=$1 AND linked_user_id=$2 AND archived_at IS NULL`, [ctx.familyId, auth.userId]);
        await tx.query(`UPDATE medication_plans SET status='ended', version=version+1, updated_at=now()
          WHERE family_id=$1 AND care_profile_id IN (SELECT id FROM care_profiles WHERE family_id=$1 AND archived_at IS NOT NULL) AND status <> 'ended'`, [ctx.familyId]);
        await cancelDoseReminders(tx, "family_id=$1 AND plan_id IN (SELECT p.id FROM medication_plans p JOIN care_profiles c ON c.id=p.care_profile_id WHERE c.archived_at IS NOT NULL)", [ctx.familyId]);
      });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        return reply.code(error.statusCode).send(error.body);
      }
      throw error;
    }
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
