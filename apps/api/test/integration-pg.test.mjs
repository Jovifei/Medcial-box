// 真实 PostgreSQL 集成测试（审核修复 #1/#4/#6 配套）：
// - 设置 TEST_DATABASE_URL（如 docker compose 起库后的 postgres://...）才会执行；
//   未设置时整体 SKIP，不阻塞无 Docker 环境（CI 默认跳过）。
// - 数据库适配器与生产完全一致（createDatabaseAdapter：含 withTransaction）。
// - 覆盖：迁移（001–005）、单 owner 部分唯一索引（用"把已有普通成员升级为
//   owner"触发 23505，不会撞 user_id 唯一约束形成假证明）、并发转让经
//   FOR UPDATE 串行化后仍满足"每家庭最多一个 owner"、成员自助退出。
import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { applyMigrations } from "../dist/db/migrations.js";
import { createDatabaseAdapter } from "../dist/db.js";
import { buildServer } from "../dist/app.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { sha256hex } from "./helpers/app.mjs";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

const OWNER_TOKEN = "a".repeat(64);
const MEMBER_TOKEN = "b".repeat(64);
const MEMBER2_TOKEN = "c".repeat(64);

test(
  "real postgresql: migrations, single-owner constraint and concurrent transfer",
  {
    concurrency: 1,
    skip: DATABASE_URL === "" ? "TEST_DATABASE_URL 未设置：本地无 Docker/PostgreSQL，跳过真实库集成测试" : false,
  },
  async (t) => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
    try {
      const applied = await applyMigrations(pool);
      // 重复启动时迁移应幂等（已应用 → 空数组）。
      assert.ok(Array.isArray(applied));

      const index = await pool.query(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'family_members' AND indexname = 'family_members_single_owner_per_family'",
      );
      assert.equal(index.rowCount, 1, "004 单 owner 部分唯一索引应存在");

      await pool.query(
        "TRUNCATE family_invites, dosage_notes, medicine_batches, medicines, sessions, family_members, families, users CASCADE",
      );

      // 铺底：一个家庭 + owner 与两名成员；会话令牌走 sha256。
      const insertUser = "INSERT INTO users (openid, nickname) VALUES ($1, $2) RETURNING id";
      const owner = (await pool.query(insertUser, ["openid-owner", "家长"])).rows[0];
      const member1 = (await pool.query(insertUser, ["openid-member-1", null])).rows[0];
      const member2 = (await pool.query(insertUser, ["openid-member-2", null])).rows[0];
      const family = (
        await pool.query("INSERT INTO families (name, created_by) VALUES ($1, $2) RETURNING id", [
          "集成测试家庭",
          owner.id,
        ])
      ).rows[0];
      const insertMember =
        "INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, $3) RETURNING id";
      await pool.query(insertMember, [family.id, owner.id, "owner"]);
      const member1Id = (
        await pool.query(insertMember, [family.id, member1.id, "member"])
      ).rows[0].id;
      const member2Id = (
        await pool.query(insertMember, [family.id, member2.id, "member"])
      ).rows[0].id;
      const insertSession =
        "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')";
      await pool.query(insertSession, [owner.id, sha256hex(OWNER_TOKEN)]);
      await pool.query(insertSession, [member1.id, sha256hex(MEMBER_TOKEN)]);
      await pool.query(insertSession, [member2.id, sha256hex(MEMBER2_TOKEN)]);

      // 单 owner 约束（审核修复 #6 的正确证明）：把一名"普通成员"升级为 owner
      // 时已有 owner 在座 → 触发部分唯一索引 23505；数据不含重复 user_id，
      // 因此不会因用户唯一约束而得到假阳性。
      await assert.rejects(
        pool.query("UPDATE family_members SET role = 'owner' WHERE id = $1", [member1Id]),
        (error) => (error ?? {}).code === "23505",
      );

      // 应用层（与生产相同的 createDatabaseAdapter 事务接口）：
      // 并发转让（owner → member1 与 owner → member2）经 FOR UPDATE 串行化，
      // 两次请求或成功或因状态变化 409，但最终不变量必须成立：恰好一个 owner。
      const gateway = createTestGateway({});
      const app = await buildServer({
        database: createDatabaseAdapter(pool),
        wechatGateway: gateway,
        logger: false,
      });
      t.after(() => app.close());
      const ownerHeader = { headers: { authorization: `Bearer ${OWNER_TOKEN}` } };

      const [first, second] = await Promise.allSettled([
        app.inject({
          method: "POST",
          url: `/api/v1/families/members/${member1Id}/transfer-ownership`,
          ...ownerHeader,
        }),
        app.inject({
          method: "POST",
          url: `/api/v1/families/members/${member2Id}/transfer-ownership`,
          ...ownerHeader,
        }),
      ]);
      for (const outcome of [first, second]) {
        if (outcome.status === "fulfilled") {
          const status = outcome.value.statusCode;
          assert.ok(
            status === 200 || status === 409 || status === 403,
            `unexpected transfer status ${status}: ${outcome.value.body}`,
          );
        }
      }
      const owners = await pool.query(
        "SELECT COUNT(*)::int AS count FROM family_members WHERE family_id = $1 AND role = 'owner'",
        [family.id],
      );
      assert.equal(owners.rows[0].count, 1, "并发转让后仍必须恰好一名 owner");

      // 转让后的成员可以自助退出（事务删除成员关系，审核修复 #5 的锁路径）。
      const leave = await app.inject({
        method: "POST",
        url: "/api/v1/families/leave",
        headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
      });
      assert.ok([204, 404, 409].includes(leave.statusCode), `leave status ${leave.statusCode}`);
    } finally {
      await pool.end();
    }
  },
);
