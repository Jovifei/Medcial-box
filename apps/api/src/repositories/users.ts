// users 表仓储：微信 openid 为登录幂等键。
import type { Database } from "../types.js";

export interface UserRow {
  id: string;
  openid: string;
  nickname: string | null;
}

export async function findUserByOpenid(
  database: Database,
  openid: string,
): Promise<UserRow | null> {
  const result = await database.query<UserRow>(
    "SELECT id, openid, nickname FROM users WHERE openid = $1",
    [openid],
  );
  return result.rows[0] ?? null;
}

export async function insertUser(
  database: Database,
  openid: string,
  nickname: string | null = null,
): Promise<UserRow> {
  const result = await database.query<UserRow>(
    "INSERT INTO users (openid, nickname) VALUES ($1, $2) RETURNING id, openid, nickname",
    [openid, nickname],
  );
  return result.rows[0];
}
