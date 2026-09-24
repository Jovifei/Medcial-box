// families / family_members 表仓储。
// 不变量：每账号仅一个家庭（family_members.user_id UNIQUE），
// 服务端在创建/加入前先显式预检，数据库约束兜底。
import type { Database } from "../types.js";

export type MemberRole = "owner" | "member";

export function asMemberRole(role: string): MemberRole {
  return role === "owner" ? "owner" : "member";
}

export interface FamilyRow {
  id: string;
  name: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface MembershipRow {
  id: string;
  family_id: string;
  user_id?: string;
  role: string;
  joined_at: Date | string;
}

export async function findMembershipByUserId(
  database: Database,
  userId: string,
): Promise<MembershipRow | null> {
  const result = await database.query<MembershipRow>(
    "SELECT id, family_id, role, joined_at FROM family_members WHERE user_id = $1",
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function findFamilyById(
  database: Database,
  familyId: string,
): Promise<FamilyRow | null> {
  const result = await database.query<FamilyRow>(
    "SELECT id, name, created_by, created_at, updated_at FROM families WHERE id = $1",
    [familyId],
  );
  return result.rows[0] ?? null;
}

export async function listMembersByFamily(
  database: Database,
  familyId: string,
): Promise<MembershipRow[]> {
  const result = await database.query<MembershipRow>(
    "SELECT id, family_id, user_id, role, joined_at FROM family_members WHERE family_id = $1 ORDER BY joined_at, id",
    [familyId],
  );
  return result.rows;
}

export async function findMemberById(
  database: Database,
  memberId: string,
  familyId: string,
): Promise<MembershipRow | null> {
  const result = await database.query<MembershipRow>(
    "SELECT id, family_id, user_id, role, joined_at FROM family_members WHERE id = $1 AND family_id = $2",
    [memberId, familyId],
  );
  return result.rows[0] ?? null;
}

export async function deleteMemberById(
  database: Database,
  memberId: string,
  familyId: string,
): Promise<boolean> {
  const result = await database.query<{ id: string }>(
    "DELETE FROM family_members WHERE id = $1 AND family_id = $2 RETURNING id",
    [memberId, familyId],
  );
  return result.rowCount !== 0;
}

export async function deleteMembershipByUserId(
  database: Database,
  userId: string,
): Promise<boolean> {
  const result = await database.query<{ id: string }>(
    "DELETE FROM family_members WHERE user_id = $1 RETURNING id",
    [userId],
  );
  return result.rowCount !== 0;
}

export async function countMembersByFamily(
  database: Database,
  familyId: string,
): Promise<number> {
  const result = await database.query<{ count: number | string }>(
    "SELECT COUNT(*)::int AS count FROM family_members WHERE family_id = $1",
    [familyId],
  );
  const raw = result.rows[0]?.count;
  return typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "0"), 10);
}

export async function updateMemberRole(
  database: Database,
  memberId: string,
  familyId: string,
  role: MemberRole,
): Promise<MembershipRow | null> {
  const result = await database.query<MembershipRow>(
    "UPDATE family_members SET role = $3 WHERE id = $1 AND family_id = $2 RETURNING id, family_id, user_id, role, joined_at",
    [memberId, familyId, role],
  );
  return result.rows[0] ?? null;
}

export async function updateMemberRoleByUserId(
  database: Database,
  userId: string,
  familyId: string,
  role: MemberRole,
): Promise<MembershipRow | null> {
  const result = await database.query<MembershipRow>(
    "UPDATE family_members SET role = $3 WHERE user_id = $1 AND family_id = $2 RETURNING id, family_id, user_id, role, joined_at",
    [userId, familyId, role],
  );
  return result.rows[0] ?? null;
}

export async function insertFamily(
  database: Database,
  name: string,
  createdBy: string,
): Promise<FamilyRow> {
  const result = await database.query<FamilyRow>(
    "INSERT INTO families (name, created_by) VALUES ($1, $2) RETURNING id, name, created_by, created_at, updated_at",
    [name, createdBy],
  );
  return result.rows[0];
}

export async function insertFamilyMember(
  database: Database,
  familyId: string,
  userId: string,
  role: MemberRole,
): Promise<MembershipRow> {
  const result = await database.query<MembershipRow>(
    "INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, $3) RETURNING id, family_id, user_id, role, joined_at",
    [familyId, userId, role],
  );
  return result.rows[0];
}

/**
 * 创建家庭 + owner 成员关系：同一事务内完成，失败即整体回滚。
 */
export async function createFamilyWithOwner(
  database: Database,
  name: string,
  ownerId: string,
): Promise<{ family: FamilyRow; membership: MembershipRow }> {
  await database.query("BEGIN");
  try {
    const family = await insertFamily(database, name, ownerId);
    const membership = await insertFamilyMember(database, family.id, ownerId, "owner");
    await database.query("COMMIT");
    return { family, membership };
  } catch (error) {
    await database.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
