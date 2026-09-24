// 家庭端点：创建（创建即 owner，一账号一家庭）与当前家庭查询。
import type { FastifyInstance } from "fastify";
import type { Database } from "../types.js";
import { errorBody, toIso } from "../types.js";
import { requireFamily } from "../auth/session.js";
import {
  asMemberRole,
  createFamilyWithOwner,
  findFamilyById,
  findMembershipByUserId,
  listMembersByFamily,
} from "../repositories/families.js";

export async function registerFamilyRoutes(
  app: FastifyInstance,
  database: Database,
): Promise<void> {
  app.post("/api/v1/families", async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "") {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "家庭名称不能为空"));
    }

    // 每账号仅一个家庭：预检 + 数据库 user_id 唯一约束兜底。
    const existing = await findMembershipByUserId(database, auth.userId);
    if (existing !== null) {
      return reply
        .code(409)
        .send(errorBody("ALREADY_IN_FAMILY", "已属于一个家庭，如需更换请先由 owner 移除"));
    }

    const { family, membership } = await createFamilyWithOwner(database, name, auth.userId);
    return reply.code(201).send({
      family: { id: family.id, name: family.name },
      membership: {
        id: membership.id,
        role: asMemberRole(membership.role),
        joinedAt: toIso(membership.joined_at),
      },
    });
  });

  app.get("/api/v1/families/current", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const auth = request.auth;

    const family = await findFamilyById(database, ctx.familyId);
    if (family === null) {
      return reply.code(404).send(errorBody("FAMILY_NOT_FOUND", "家庭不存在"));
    }
    const members = await listMembersByFamily(database, ctx.familyId);
    return {
      family: {
        id: family.id,
        name: family.name,
        role: asMemberRole(auth?.role ?? "member"),
        members: members.map((member) => ({
          id: member.id,
          role: asMemberRole(member.role),
          joinedAt: toIso(member.joined_at),
        })),
      },
    };
  });
}
