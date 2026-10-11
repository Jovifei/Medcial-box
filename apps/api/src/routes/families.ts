// 家庭端点：多家庭列表、显式切换和当前家庭查询。
import type { FastifyInstance } from "fastify";
import type { Database } from "../types.js";
import { errorBody, toIso } from "../types.js";
import { requireFamily } from "../auth/session.js";
import {
  asMemberRole,
  createFamilyWithOwner,
  findFamilyById,
  findMembershipByUserId,
  listMembersWithIdentity,
} from "../repositories/families.js";
import {
  activateFamilyContext,
  findActiveFamilyContext,
  listFamilyContextsByUserId,
} from "../repositories/family-context.js";

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

    // 多家庭阶段：允许同一账号拥有多个 membership，不再用旧单家庭预检阻断。
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

  app.get("/api/v1/families", async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    }
    const current = await findActiveFamilyContext(database, auth.userId);
    const families = await listFamilyContextsByUserId(database, auth.userId);
    return {
      families: families.map((family) => ({
        familyId: family.family_id,
        role: asMemberRole(family.role),
        isCurrent: current?.family_id === family.family_id,
      })),
    };
  });

  app.post("/api/v1/families/:familyId/switch", async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "请先登录"));
    }
    const { familyId } = request.params as { familyId: string };
    const switched = await activateFamilyContext(database, auth.userId, familyId);
    if (switched === null) {
      return reply.code(404).send(errorBody("FAMILY_NOT_FOUND", "不是该家庭成员"));
    }
    return {
      familyId: switched.family_id,
      role: asMemberRole(switched.role),
    };
  });

  app.get("/api/v1/families/current", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const auth = request.auth;

    const family = await findFamilyById(database, ctx.familyId);
    if (family === null) {
      return reply.code(404).send(errorBody("FAMILY_NOT_FOUND", "家庭不存在"));
    }
    const members = await listMembersWithIdentity(database, ctx.familyId);
    return {
      family: {
        id: family.id,
        name: family.name,
        role: asMemberRole(auth?.role ?? "member"),
        members: members.map((member, index) => ({
          id: member.id,
          userId: member.user_id,
          role: asMemberRole(member.role),
          displayName: member.nickname ?? `成员 ${index + 1}`,
          isSelf: auth !== null && member.user_id === auth.userId,
          joinedAt: toIso(member.joined_at),
        })),
      },
    };
  });
}
