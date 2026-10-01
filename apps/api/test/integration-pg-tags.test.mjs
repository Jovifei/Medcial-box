// R1 人群／用途整理标签的真实 PostgreSQL 验证（独立进程，避免登录限流共享配额）。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { createReminderTemplateConfig } from "../dist/services/subscribe-messages.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres } from "./helpers/isolated-pg.mjs";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
  return expected === 204 ? null : response.json();
}

test("real PostgreSQL: population and purpose tags (R1)", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
  concurrency: 1,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL; real PostgreSQL cannot be skipped");
  const fixture = await isolatedPostgres(url);
  const { pool, database } = fixture;
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(pool);
    app = await buildServer({
      database,
      wechatGateway: gateway,
      reminderTemplateConfig: createReminderTemplateConfig({
        appId: "synthetic-app-id",
        appSecret: "synthetic-secret",
        templateId: "synthetic-reminder-template",
      }),
      logger: { level: "error" },
    });
    const request = (user, method, path, payload) => app.inject({ method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${user.token}` }, ...(payload === undefined ? {} : { payload }) });
    async function family() {
      const code = randomUUID();
      gateway.registerCode(code, `tags-${code}`);
      const auth = status(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      const owner = { token: auth.token, id: auth.user.id };
      const created = status(await request(owner, "POST", "/families", { name: `家庭-${randomUUID()}` }), 201);
      owner.membershipId = created.membership.id;
      return { owner, id: created.family.id };
    }

    await t.test("migration 014 adds tag columns with element whitelists", async () => {
      const columns = await pool.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'medicines' AND column_name = ANY($2::text[])
         ORDER BY column_name`,
        [fixture.schema, ["population_tags", "purpose_tags", "tag_source"]],
      );
      assert.deepEqual(columns.rows.map((row) => row.column_name), ["population_tags", "purpose_tags", "tag_source"]);
      const arrayColumns = columns.rows.filter((row) => row.column_name.endsWith("_tags"));
      assert.equal(arrayColumns.length, 2);
      assert.ok(arrayColumns.every((row) => row.data_type === "ARRAY"), JSON.stringify(arrayColumns));
      assert.equal(columns.rows.find((row) => row.column_name === "tag_source").data_type, "text");

      // 白名单由数据库兜底：绕过 API 直接写非法标签也必须被拒绝。
      const { owner, id: familyId } = await family();
      await assert.rejects(
        pool.query(
          `INSERT INTO medicines (family_id, name, population_tags, created_by, updated_by)
           VALUES ($1, $2, ARRAY['elderly']::text[], $3, $3)`,
          [familyId, "非法人群标签药", owner.id],
        ),
        /population_tags/,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO medicines (family_id, name, purpose_tags, created_by, updated_by)
           VALUES ($1, $2, ARRAY['made-up']::text[], $3, $3)`,
          [familyId, "非法用途标签药", owner.id],
        ),
        /purpose_tags/,
      );
    });

    await t.test("tags round-trip, deduplicate, and stay separate from the legacy free-text purpose", async () => {
      const { owner } = await family();
      const created = status(await request(owner, "POST", "/medicines", {
        name: "儿童退烧药",
        purposeCategory: "自己填的自由文本用途",
        populationTags: ["child", "adult", "child"],
        purposeTags: ["fever", "pain", "fever"],
        batches: [{ quantity: 2, unit: "box" }],
      }), 201);
      assert.deepEqual(created.populationTags, ["child", "adult"], "duplicates collapse, multi-select preserved");
      assert.deepEqual(created.purposeTags, ["fever", "pain"]);
      assert.equal(created.tagSource, "manual");
      // 旧的自由文本用途继续原样返回，不被标签替换。
      assert.equal(created.purposeCategory, "自己填的自由文本用途");

      const reopened = status(await request(owner, "GET", `/medicines/${created.id}`), 200);
      assert.deepEqual(reopened.populationTags, ["child", "adult"]);
      assert.deepEqual(reopened.purposeTags, ["fever", "pain"]);

      // 清空人群标签 = 未标注，且不影响用途与旧文本。
      const cleared = status(await request(owner, "PUT", `/medicines/${created.id}`, {
        ...reopened, populationTags: [], purposeTags: ["cough"],
      }), 200);
      assert.deepEqual(cleared.populationTags, [], "empty array means unlabeled, not 'keep previous'");
      assert.deepEqual(cleared.purposeTags, ["cough"]);
      assert.equal(cleared.purposeCategory, "自己填的自由文本用途", "legacy text survives tag edits");
    });

    await t.test("unknown or malformed tags are rejected with 400", async () => {
      const { owner } = await family();
      const created = status(await request(owner, "POST", "/medicines", {
        name: "标签校验药",
        batches: [{ quantity: 1, unit: "box" }],
      }), 201);
      const badPopulation = await request(owner, "POST", "/medicines", {
        name: "非法人群标签",
        populationTags: ["elderly"],
        batches: [{ quantity: 1, unit: "box" }],
      });
      assert.equal(badPopulation.statusCode, 400, badPopulation.body);

      const current = status(await request(owner, "GET", `/medicines/${created.id}`), 200);
      const badPurpose = await request(owner, "PUT", `/medicines/${created.id}`, { ...current, purposeTags: ["unknown-purpose"] });
      assert.equal(badPurpose.statusCode, 400, badPurpose.body);
      const notArray = await request(owner, "PUT", `/medicines/${created.id}`, { ...current, purposeTags: "fever" });
      assert.equal(notArray.statusCode, 400, notArray.body);
    });

    await t.test("container filters select medicines by population tag", async () => {
      const { owner, id: familyId } = await family();
      status(await request(owner, "POST", "/medicines", {
        name: "成人用药", populationTags: ["adult"], purposeTags: ["pain"], batches: [{ quantity: 1, unit: "box" }],
      }), 201);
      status(await request(owner, "POST", "/medicines", {
        name: "儿童用药", populationTags: ["child"], purposeTags: ["fever"], batches: [{ quantity: 1, unit: "box" }],
      }), 201);
      const adults = (await pool.query(
        "SELECT name FROM medicines WHERE family_id = $1 AND population_tags @> ARRAY['adult']::text[] ORDER BY name",
        [familyId],
      )).rows.map((row) => row.name);
      assert.deepEqual(adults, ["成人用药"], "药箱按人群筛选将复用同一包含语义");
      const fever = (await pool.query(
        "SELECT name FROM medicines WHERE family_id = $1 AND purpose_tags @> ARRAY['fever']::text[] ORDER BY name",
        [familyId],
      )).rows.map((row) => row.name);
      assert.deepEqual(fever, ["儿童用药"]);
    });
  } finally {
    if (app !== undefined) await app.close();
    await fixture.close();
  }
});
