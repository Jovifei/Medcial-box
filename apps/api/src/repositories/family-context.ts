import type { QueryRunner } from "../types.js";

export interface FamilyContextRow {
  family_id: string;
  user_id: string;
  role: string;
}

export async function findActiveFamilyContext(
  database: QueryRunner,
  userId: string,
): Promise<FamilyContextRow | null> {
  const result = await database.query<FamilyContextRow>(
    `SELECT family_id, user_id, role
       FROM family_members
      WHERE user_id = $1 AND is_active_context = true
      ORDER BY joined_at, id
      LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function activateFamilyContext(
  database: QueryRunner,
  userId: string,
  familyId: string,
): Promise<FamilyContextRow | null> {
  return database.withTransaction(async (tx) => {
    const member = await tx.query<FamilyContextRow>(
      `SELECT family_id, user_id, role
         FROM family_members
        WHERE user_id = $1 AND family_id = $2
        FOR UPDATE`,
      [userId, familyId],
    );
    if (member.rows[0] === undefined) return null;

    await tx.query(
      `UPDATE family_members
          SET is_active_context = false
        WHERE user_id = $1`,
      [userId],
    );
    await tx.query(
      `UPDATE family_members
          SET is_active_context = true
        WHERE user_id = $1 AND family_id = $2`,
      [userId, familyId],
    );
    return member.rows[0];
  });
}
