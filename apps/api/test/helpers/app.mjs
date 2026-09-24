// 测试通用脚手架：构造注入合成依赖的 app、模拟登录、常用行构造器。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildServer } from "../../dist/app.js";

export const FUTURE_ISO = new Date(Date.now() + 86_400_000).toISOString();

/** 任意 64 位十六进制令牌：合成会话查询按脚本命中，不校验具体哈希。 */
export const TOKEN = "c".repeat(64);

export function authHeader() {
  return { headers: { authorization: `Bearer ${TOKEN}` } };
}

export function sha256hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 多用户合成会话：按参数（令牌哈希 / openid / userId）动态返回各自的行，
 * 支持同一家庭 owner + 成员并存与"移除后立即失效"场景。
 * users: [{ token, userId, openid, membership }]
 */
export function scriptMultiUserSessions(pool, users) {
  const sessionByHash = new Map();
  const userByOpenid = new Map();
  const membershipByUser = new Map();
  for (const user of users) {
    sessionByHash.set(sha256hex(user.token), {
      id: `session-${user.userId}`,
      user_id: user.userId,
      expires_at: FUTURE_ISO,
    });
    userByOpenid.set(user.openid, { id: user.userId, openid: user.openid, nickname: null });
    membershipByUser.set(user.userId, user.membership ?? null);
  }
  pool.always(/FROM sessions WHERE token_hash/, (sql, params) => {
    const row = sessionByHash.get(params[0]);
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  });
  pool.always(/FROM users WHERE openid/, (sql, params) => {
    const row = userByOpenid.get(params[0]);
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  });
  pool.always(/FROM family_members WHERE user_id/, (sql, params) => {
    const row = membershipByUser.get(params[0]);
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  });
  return {
    removeMembership(userId) {
      membershipByUser.delete(userId);
    },
    sessionHashFor(token) {
      return sha256hex(token);
    },
  };
}

export async function createApp(pool, gateway) {
  return buildServer({ database: pool, wechatGateway: gateway, logger: false });
}

/**
 * 通过 POST /api/v1/auth/wechat 完成一次登录并返回明文令牌。
 * 会注册认证链路所需的粘性脚本（会话查询、成员关系查询），
 * hasFamily 由 options.membership 是否为空决定。
 */
export async function login(app, pool, options = {}) {
  const userId = options.userId ?? "user-1";
  const openid = options.openid ?? "openid-user-1";
  const userExists = options.userExists ?? true;
  const code = options.code ?? "js-code-1";

  if (userExists) {
    pool.always(/FROM users WHERE openid/, {
      rows: [{ id: userId, openid, nickname: null }],
      rowCount: 1,
    });
  } else {
    pool.on(/FROM users WHERE openid/, { rows: [], rowCount: 0 });
    pool.always(/INSERT INTO users/, {
      rows: [{ id: userId, openid, nickname: null }],
      rowCount: 1,
    });
  }
  pool.always(
    /FROM family_members WHERE user_id/,
    options.membership
      ? { rows: [options.membership], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  );
  pool.always(/INSERT INTO sessions/, {
    rows: [{ id: "session-1", expires_at: FUTURE_ISO }],
    rowCount: 1,
  });
  pool.always(/FROM sessions WHERE token_hash/, {
    rows: [{ id: "session-1", user_id: userId, expires_at: FUTURE_ISO }],
    rowCount: 1,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat",
    payload: { code },
  });
  assert.equal(response.statusCode, 200, `login failed: ${response.body}`);
  return response.json().token;
}

export function membershipRow(overrides = {}) {
  return {
    id: "membership-1",
    family_id: "family-1",
    role: "owner",
    joined_at: "2026-09-24T08:00:00Z",
    ...overrides,
  };
}

export function familyRow(overrides = {}) {
  return {
    id: "family-1",
    name: "我的家庭",
    created_by: "user-1",
    created_at: "2026-09-24T08:00:00Z",
    updated_at: "2026-09-24T08:00:00Z",
    ...overrides,
  };
}

export function medicineRow(overrides = {}) {
  return {
    id: "medicine-1",
    name: "布洛芬缓释胶囊",
    specification: "0.3g*20粒",
    manufacturer: "示例药业",
    approval_number: "国药准字H20000000",
    active_ingredients: ["布洛芬"],
    purpose_category: "解热镇痛",
    leaflet_purpose_summary: "用于缓解轻至中度疼痛。",
    leaflet_package_usage_summary: "口服，成人一次1粒。",
    leaflet_contraindications_summary: "对本品过敏者禁用。",
    leaflet_precautions_summary: "不得超量服用。",
    leaflet_source: "包装内说明书",
    leaflet_review_status: "user_confirmed",
    is_archived: false,
    version: 1,
    ...overrides,
  };
}

export function batchRow(overrides = {}) {
  return {
    id: "batch-1",
    medicine_id: "medicine-1",
    lot_number: "LOT-2026-01",
    expiry_value: "2099-12-31",
    expiry_precision: "day",
    quantity: 2,
    unit: "box",
    confirmed_units_per_package: null,
    storage_location: "客厅药箱",
    version: 1,
    ...overrides,
  };
}

export function noteRow(overrides = {}) {
  return {
    id: "note-1",
    medicine_id: "medicine-1",
    user_id: "user-1",
    content: "每日两次，每次1片",
    visibility: "private",
    version: 1,
    ...overrides,
  };
}
