// family_invites 表仓储（P2）：
// - 明文邀请码只在创建响应出现一次，库存 sha256 哈希；
// - 72 小时失效、一次性消费；
// - 消费走单条原子 UPDATE（used_at IS NULL AND expires_at > now()），rowCount 判定防复用。
import type { Database } from "../types.js";

export interface FamilyInviteRow {
  id: string;
  family_id: string;
  token_hash: string;
  created_by: string;
  expires_at: Date | string;
  used_at: Date | string | null;
  used_by: string | null;
  created_at: Date | string;
}

export async function insertInvite(
  database: Database,
  familyId: string,
  tokenHash: string,
  createdBy: string,
  expiresAt: Date,
): Promise<FamilyInviteRow> {
  const result = await database.query<FamilyInviteRow>(
    "INSERT INTO family_invites (family_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4) RETURNING id, family_id, token_hash, created_by, expires_at, used_at, used_by, created_at",
    [familyId, tokenHash, createdBy, expiresAt],
  );
  return result.rows[0];
}

export async function findInviteByTokenHash(
  database: Database,
  tokenHash: string,
): Promise<FamilyInviteRow | null> {
  const result = await database.query<FamilyInviteRow>(
    "SELECT id, family_id, token_hash, created_by, expires_at, used_at, used_by, created_at FROM family_invites WHERE token_hash = $1",
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Atomic one-time consumption. Returns the consumed row, or null when the
 * invite is already used / expired (caller classifies via findInviteByTokenHash).
 */
export async function consumeInvite(
  database: Database,
  tokenHash: string,
  userId: string,
): Promise<FamilyInviteRow | null> {
  const result = await database.query<FamilyInviteRow>(
    "UPDATE family_invites SET used_at = now(), used_by = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING id, family_id, token_hash, created_by, expires_at, used_at, used_by, created_at",
    [tokenHash, userId],
  );
  return result.rows[0] ?? null;
}
