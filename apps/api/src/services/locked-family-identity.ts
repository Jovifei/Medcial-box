import type { FastifyRequest } from "fastify";
import type { FamilyContext } from "../auth/session.js";
import type { QueryRunner } from "../types.js";
import { errorBody, TransactionConflictError } from "../types.js";

/** Family, membership, session order matches revocation and session selection. */
export async function lockFamilyIdentity(tx: QueryRunner, ctx: FamilyContext, request: FastifyRequest): Promise<string> {
  const missing = errorBody("FAMILY_NOT_FOUND", "当前成员关系不存在");
  // Still serializes family membership/removal locks, while allowing the
  // KEY SHARE acquired by audit-row foreign keys during medicine updates.
  const family = await tx.query("SELECT id FROM families WHERE id = $1 FOR NO KEY UPDATE", [ctx.familyId]);
  if (!family.rowCount) throw new TransactionConflictError(404, missing);
  const member = await tx.query<{ role: string }>(
    "SELECT role FROM family_members WHERE family_id = $1 AND user_id = $2 FOR SHARE", [ctx.familyId, ctx.userId],
  );
  if (!member.rows[0]) throw new TransactionConflictError(404, missing);
  const session = await tx.query(
    `SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND expires_at > now()
       AND ($3::boolean OR active_family_id = $4) FOR SHARE`,
    [request.auth?.sessionId, ctx.userId, request.headers["x-family-id"] !== undefined, ctx.familyId],
  );
  if (!session.rowCount) throw new TransactionConflictError(404, missing);
  return member.rows[0].role;
}
