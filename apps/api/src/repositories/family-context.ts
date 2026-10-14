import type { QueryRunner, Database } from "../types.js";
import type { MembershipRow } from "./families.js";

export interface FamilyContextRow extends MembershipRow { name: string }
export async function listFamilyContextsByUserId(database: QueryRunner, userId: string): Promise<FamilyContextRow[]> {
  const result = await database.query<FamilyContextRow>(
    `SELECT fm.id, fm.family_id, fm.user_id, fm.role, fm.joined_at, f.name
     FROM family_members fm JOIN families f ON f.id = fm.family_id
     WHERE fm.user_id = $1 ORDER BY fm.joined_at, fm.id`, [userId]);
  return result.rows;
}
export async function findMembershipInFamily(database: QueryRunner, userId: string, familyId: string): Promise<MembershipRow | null> {
  const result = await database.query<MembershipRow>(
    "SELECT id, family_id, user_id, role, joined_at FROM family_members WHERE user_id = $1 AND family_id = $2", [userId, familyId]);
  return result.rows[0] ?? null;
}
/** Caller owns the transaction when passing QueryRunner. Never change other sessions. */
export async function selectSessionFamily(tx: QueryRunner, userId: string, sessionId: string, familyId: string): Promise<MembershipRow | null> {
  const member = await tx.query<MembershipRow>(
    "SELECT id, family_id, user_id, role, joined_at FROM family_members WHERE user_id = $1 AND family_id = $2 FOR SHARE", [userId, familyId]);
  if (!member.rows[0]) return null;
  const changed = await tx.query("UPDATE sessions SET active_family_id = $3 WHERE id = $1 AND user_id = $2 RETURNING id", [sessionId, userId, familyId]);
  return changed.rowCount ? member.rows[0] : null;
}
export async function activateFamilyContext(database: Database, userId: string, sessionId: string, familyId: string): Promise<MembershipRow | null> {
  return database.withTransaction(tx => selectSessionFamily(tx, userId, sessionId, familyId));
}
