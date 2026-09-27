// users 表仓储：微信 openid 为登录幂等键。
import type { QueryRunner } from "../types.js";

export interface UserRow {
  id: string;
  openid: string;
  nickname: string | null;
}

export async function findUserByOpenid(
  database: QueryRunner,
  openid: string,
): Promise<UserRow | null> {
  const result = await database.query<UserRow>(
    "SELECT id, openid, nickname FROM users WHERE openid = $1",
    [openid],
  );
  return result.rows[0] ?? null;
}

export async function findUserById(
  database: QueryRunner,
  userId: string,
): Promise<UserRow | null> {
  const result = await database.query<UserRow>(
    "SELECT id, openid, nickname FROM users WHERE id = $1",
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function insertUser(
  database: QueryRunner,
  openid: string,
  nickname: string | null = null,
): Promise<UserRow> {
  const result = await database.query<UserRow>(
    "INSERT INTO users (openid, nickname) VALUES ($1, $2) RETURNING id, openid, nickname",
    [openid, nickname],
  );
  return result.rows[0];
}

export async function updateUserNickname(
  database: QueryRunner,
  userId: string,
  nickname: string | null,
): Promise<UserRow | null> {
  const result = await database.query<UserRow>(
    "UPDATE users SET nickname = $2, updated_at = now() WHERE id = $1 RETURNING id, openid, nickname",
    [userId, nickname],
  );
  return result.rows[0] ?? null;
}
