// 演示脚本：无需 Docker/PostgreSQL，用内存状态机驱动真实 API 代码
// （buildServer + 认证 + 事务 + 路由 + Markdown 渲染器全部是仓库内真实实现）。
// 运行：node scripts/demo-server.mjs
// 说明：数据库层为合成实现，仅用于演示接口行为；真实 PostgreSQL 验收见
// apps/api/test/integration-pg.test.mjs（设 TEST_DATABASE_URL 自动执行）。
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildServer } from "../apps/api/dist/app.js";
import { FakeWechatGateway } from "../apps/api/dist/auth/wechat.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// 内存状态机：实现 API 实际使用的 SQL 子集（真实数组读写，非脚本回放）。
// ---------------------------------------------------------------------------
const db = {
  users: [],
  sessions: [],
  families: [],
  memberships: [],
  invites: [],
  medicines: [],
  batches: [],
};

const empty = () => ({ rows: [], rowCount: 0 });

const medicineColumns = (m) => ({
  id: m.id,
  name: m.name,
  specification: m.specification,
  manufacturer: m.manufacturer,
  approval_number: m.approval_number,
  active_ingredients: m.active_ingredients,
  purpose_category: m.purpose_category,
  leaflet_purpose_summary: m.leaflet_purpose_summary,
  leaflet_package_usage_summary: m.leaflet_package_usage_summary,
  leaflet_contraindications_summary: m.leaflet_contraindications_summary,
  leaflet_precautions_summary: m.leaflet_precautions_summary,
  leaflet_source: m.leaflet_source,
  leaflet_review_status: m.leaflet_review_status,
  is_archived: m.is_archived,
  version: m.version,
});

const batchColumns = (b) => ({
  id: b.id,
  medicine_id: b.medicine_id,
  lot_number: b.lot_number,
  expiry_value: b.expiry_value,
  expiry_precision: b.expiry_precision,
  quantity: b.quantity,
  unit: b.unit,
  confirmed_units_per_package: b.confirmed_units_per_package,
  storage_location: b.storage_location,
  version: b.version,
});

const handlers = [
  [/^SELECT 1$/i, () => ({ rows: [{ ok: 1 }], rowCount: 1 })],
  [/INSERT INTO sessions/i, (_sql, params) => {
    db.sessions.push({ id: randomUUID(), user_id: params[0], token_hash: params[1], expires_at: params[2] });
    return { rows: [], rowCount: 1 };
  }],
  [/FROM sessions WHERE token_hash/i, (_sql, params) => {
    const session = db.sessions.find((s) => s.token_hash === params[0]);
    return session ? { rows: [session], rowCount: 1 } : empty();
  }],
  [/INSERT INTO users/i, (_sql, params) => {
    const user = { id: randomUUID(), openid: params[0], nickname: params[1] };
    db.users.push(user);
    return { rows: [user], rowCount: 1 };
  }],
  [/FROM users WHERE openid/i, (_sql, params) => {
    const user = db.users.find((u) => u.openid === params[0]);
    return user ? { rows: [user], rowCount: 1 } : empty();
  }],
  [/INSERT INTO families/i, (_sql, params) => {
    const family = { id: randomUUID(), name: params[0], created_by: params[1], created_at: nowIso(), updated_at: nowIso() };
    db.families.push(family);
    return { rows: [family], rowCount: 1 };
  }],
  [/INSERT INTO family_members/i, (_sql, params) => {
    const membership = { id: randomUUID(), family_id: params[0], user_id: params[1], role: params[2], joined_at: nowIso() };
    db.memberships.push(membership);
    return { rows: [membership], rowCount: 1 };
  }],
  [/FROM family_members WHERE user_id/i, (_sql, params) => {
    const membership = db.memberships.find((m) => m.user_id === params[0]);
    return membership ? { rows: [membership], rowCount: 1 } : empty();
  }],
  [/SELECT id FROM families WHERE id = \$1 FOR UPDATE/i, (_sql, params) => {
    const family = db.families.find((f) => f.id === params[0]);
    return family ? { rows: [{ id: family.id }], rowCount: 1 } : empty();
  }],
  [/FROM families WHERE id = \$1/i, (_sql, params) => {
    const family = db.families.find((f) => f.id === params[0]);
    return family ? { rows: [family], rowCount: 1 } : empty();
  }],
  [/INSERT INTO family_invites/i, (_sql, params) => {
    const invite = { id: randomUUID(), family_id: params[0], token_hash: params[1], created_by: params[2], expires_at: params[3], used_at: null, used_by: null, created_at: nowIso() };
    db.invites.push(invite);
    return { rows: [invite], rowCount: 1 };
  }],
  [/FROM family_invites WHERE token_hash/i, (_sql, params) => {
    const invite = db.invites.find((i) => i.token_hash === params[0]);
    return invite ? { rows: [invite], rowCount: 1 } : empty();
  }],
  [/UPDATE family_invites SET used_at/i, (_sql, params) => {
    const invite = db.invites.find(
      (i) => i.token_hash === params[0] && i.used_at === null && new Date(i.expires_at).getTime() > Date.now(),
    );
    if (invite === undefined) return empty();
    invite.used_at = nowIso();
    invite.used_by = params[1];
    return { rows: [invite], rowCount: 1 };
  }],
  [/INSERT INTO medicines/i, (_sql, params) => {
    const [familyId, name, specification, manufacturer, approvalNumber, ingredients, purposeCategory, lp, lpu, lc, lpr, ls, lrs] = params;
    const medicine = {
      id: randomUUID(), family_id: familyId, name, specification, manufacturer,
      approval_number: approvalNumber, active_ingredients: ingredients, purpose_category: purposeCategory,
      leaflet_purpose_summary: lp, leaflet_package_usage_summary: lpu,
      leaflet_contraindications_summary: lc, leaflet_precautions_summary: lpr,
      leaflet_source: ls, leaflet_review_status: lrs, is_archived: false, version: 1, created_at: nowIso(),
    };
    db.medicines.push(medicine);
    return { rows: [medicineColumns(medicine)], rowCount: 1 };
  }],
  [/FROM medicines WHERE family_id/i, (_sql, params) => {
    const rows = db.medicines
      .filter((m) => m.family_id === params[0] && !m.is_archived)
      .map(medicineColumns);
    return { rows, rowCount: rows.length };
  }],
  [/FROM medicines WHERE id = \$1 AND family_id/i, (_sql, params) => {
    const medicine = db.medicines.find((m) => m.id === params[0] && m.family_id === params[1]);
    return medicine ? { rows: [medicineColumns(medicine)], rowCount: 1 } : empty();
  }],
  [/INSERT INTO medicine_batches/i, (_sql, params) => {
    const [medicineId, familyId, lotNumber, expiryValue, expiryPrecision, quantity, unit, confirmedUnits, storageLocation] = params;
    const batch = {
      id: randomUUID(), medicine_id: medicineId, family_id: familyId, lot_number: lotNumber,
      expiry_value: expiryValue, expiry_precision: expiryPrecision, quantity, unit,
      confirmed_units_per_package: confirmedUnits, storage_location: storageLocation,
      version: 1, created_at: nowIso(),
    };
    db.batches.push(batch);
    return { rows: [batchColumns(batch)], rowCount: 1 };
  }],
  [/FROM medicine_batches WHERE family_id/i, (_sql, params) => {
    const rows = db.batches.filter((b) => b.family_id === params[0]).map(batchColumns);
    return { rows, rowCount: rows.length };
  }],
  [/FROM medicine_batches WHERE medicine_id/i, (_sql, params) => {
    const rows = db.batches.filter((b) => b.medicine_id === params[0] && b.family_id === params[1]).map(batchColumns);
    return { rows, rowCount: rows.length };
  }],
];

const database = {
  query: async (sql, params = []) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    const handler = handlers.find(([pattern]) => pattern.test(normalized));
    if (handler === undefined) {
      throw new Error(`demo database: unhandled sql: ${normalized}`);
    }
    return handler[1](normalized, params);
  },
  async withTransaction(fn) {
    return fn(this);
  },
};

// ---------------------------------------------------------------------------
// 演示流程
// ---------------------------------------------------------------------------
function title(text) {
  console.log(`\n—— ${text} ${"—".repeat(Math.max(2, 62 - text.length))}`);
}

async function call(app, method, url, token, payload) {
  const response = await app.inject({
    method,
    url,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload }),
  });
  let body;
  try {
    body = response.json();
  } catch {
    body = null;
  }
  return { status: response.statusCode, body };
}

async function main() {
  const gateway = new FakeWechatGateway()
    .registerCode("demo-code-jovi", "openid-jovi")
    .registerCode("demo-code-wife", "openid-wife");
  const app = await buildServer({ database, wechatGateway: gateway, logger: false });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  console.log("家庭药箱 · 本地运行演示");
  console.log(`API 实际监听：${address}（数据库层=内存状态机；其余全部为真实实现）`);

  title("1/7 健康检查（liveness + readiness）");
  const live = await call(app, "GET", "/api/v1/health/live", null);
  const ready = await call(app, "GET", "/api/v1/health/ready", null);
  console.log(`GET /health/live  → ${live.status} ${JSON.stringify(live.body)}`);
  console.log(`GET /health/ready → ${ready.status} ${JSON.stringify(ready.body)}`);

  title("2/7 微信登录（wx.login code 换会话，令牌仅存哈希）");
  const ownerLogin = await call(app, "POST", "/api/v1/auth/wechat", null, { code: "demo-code-jovi" });
  const ownerToken = ownerLogin.body.token;
  console.log(`POST /auth/wechat → ${ownerLogin.status} user=${ownerLogin.body.user.id} hasFamily=${ownerLogin.body.user.hasFamily}`);
  console.log(`会话令牌（明文只出现一次）：${ownerToken.slice(0, 12)}…（库里只存 sha256）`);
  const ownerSessions = database.query;
  void ownerSessions;

  title("3/7 创建家庭（创建者成为 owner）");
  const family = await call(app, "POST", "/api/v1/families", ownerToken, { name: "Jovi 家的药箱" });
  console.log(`POST /families → ${family.status} ${JSON.stringify(family.body.family)}`);

  title("4/7 邀请家人：owner 生成一次性邀请码 → 成员登录并接受");
  const invitation = await call(app, "POST", "/api/v1/families/invitations", ownerToken);
  console.log(`POST /families/invitations → ${invitation.status} 邀请码=${invitation.body.invitationCode.slice(0, 10)}…（72h 一次性）`);
  const wifeLogin = await call(app, "POST", "/api/v1/auth/wechat", null, { code: "demo-code-wife" });
  const wifeToken = wifeLogin.body.token;
  const accepted = await call(app, "POST", "/api/v1/families/invitations/accept", wifeToken, {
    code: invitation.body.invitationCode,
  });
  console.log(`POST /families/invitations/accept → ${accepted.status} 加入「${accepted.body.family.name}」role=${accepted.body.membership.role}`);

  title("5/7 手动录入药品（药品 + 批次在同一事务写入）");
  const medicines = [
    {
      name: "对乙酰氨基酚片",
      specification: "0.5g×12片",
      manufacturer: "示例制药",
      approvalNumber: "国药准字H20000001",
      activeIngredients: ["对乙酰氨基酚"],
      purposeCategory: "解热镇痛",
      leaflet: {
        purposeSummary: "用于缓解轻至中度疼痛与发热",
        packageUsageSummary: "口服，成人一次 1 片，若持续发热可间隔 4-6 小时重复用药",
        contraindicationsSummary: "对本品过敏者禁用；严重肝肾功能不全者禁用",
        precautionsSummary: "不得与其他含对乙酰氨基酚制剂同服",
        source: "包装内说明书（已拍照）",
        reviewStatus: "user_confirmed",
      },
      batches: [
        { lotNumber: "LOT-A2601", expiry: { value: "2027-06-30", precision: "day" }, quantity: 20, unit: "tablet", storageLocation: "客厅药箱第一层" },
      ],
    },
    {
      name: "布洛芬缓释胶囊",
      specification: "0.3g×20粒",
      manufacturer: "示例制药",
      approvalNumber: "国药准字H20000002",
      activeIngredients: ["布洛芬"],
      purposeCategory: "解热镇痛",
      leaflet: {
        purposeSummary: "缓解轻至中度疼痛",
        packageUsageSummary: "口服，成人一次 1 粒，一日 2 次",
        contraindicationsSummary: "消化道溃疡史者慎用",
        source: "药盒背面",
        reviewStatus: "unverified",
      },
      batches: [
        { lotNumber: "LOT-B2602", expiry: { value: "2026-10-16", precision: "day" }, quantity: 6, unit: "capsule", storageLocation: "客厅药箱第一层" },
      ],
    },
    {
      name: "阿莫西林胶囊",
      specification: "0.25g×24粒",
      manufacturer: "示例制药",
      approvalNumber: "国药准字H20000003",
      activeIngredients: ["阿莫西林"],
      purposeCategory: "抗感染",
      leaflet: {
        purposeSummary: "用于敏感菌所致感染（处方药，遵医嘱）",
        packageUsageSummary: "口服，成人一次 2 粒，每 8 小时一次",
        contraindicationsSummary: "青霉素过敏者禁用",
        source: "包装内说明书",
        reviewStatus: "matched",
      },
      batches: [
        { lotNumber: "LOT-C2603", expiry: { value: "2026-08-10", precision: "day" }, quantity: 1, unit: "box", storageLocation: "冰箱上层" },
      ],
    },
    {
      name: "藿香正气水",
      specification: "10ml×10支",
      manufacturer: null,
      approvalNumber: null,
      activeIngredients: [],
      purposeCategory: "解表化湿",
      leaflet: { purposeSummary: null, packageUsageSummary: null, contraindicationsSummary: null, precautionsSummary: null, source: null, reviewStatus: "unverified" },
      batches: [
        { lotNumber: null, expiry: null, quantity: null, unit: "box", storageLocation: null },
      ],
    },
  ];
  for (const medicine of medicines) {
    const created = await call(app, "POST", "/api/v1/medicines", ownerToken, medicine);
    console.log(
      `POST /medicines → ${created.status} ${created.body.name}（批次 ${created.body.batches.length} 条，版本 v${created.body.version}）`,
    );
  }

  title("6/7 查询家庭药箱（成员视角也可读）");
  const list = await call(app, "GET", "/api/v1/medicines", wifeToken);
  for (const medicine of list.body.medicines) {
    const batch = medicine.batches[0];
    const expiryText = batch === undefined ? "-" : `${batch.expiry.value ?? "待补充"} → ${batch.expiryState.label}`;
    console.log(`  · ${medicine.name}｜${medicine.expiryState.label}｜${expiryText}`);
  }

  title("7/7 导出 Markdown（给外部 AI 的上下文文件）");
  const exported = await call(app, "POST", "/api/v1/exports/markdown", ownerToken, {});
  const outputDir = resolve(ROOT, "demo-output");
  await mkdir(outputDir, { recursive: true });
  const outputFile = resolve(outputDir, "家庭药箱导出演示.md");
  const header = `<!-- 由 scripts/demo-server.mjs 生成于 ${exported.body.generatedAt}；数据为内存合成演示数据 -->\n\n`;
  await writeFile(outputFile, header + exported.body.markdown, "utf8");
  console.log(`POST /exports/markdown → ${exported.status}（UTF-8，${exported.body.markdown.length} 字符）`);
  console.log(`已写出：${outputFile}\n`);
  console.log(exported.body.markdown);

  await app.close();
  console.log("—— 演示结束：以上接口路径、错误语义与小程序调用完全一致；真实 PostgreSQL/微信登录等 Docker 环境就绪后按 README 步骤验收。");
}

main().catch((error) => {
  console.error("演示失败：", error);
  process.exitCode = 1;
});
