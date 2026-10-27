import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { bounded, isolatedPostgres, signal } from "./helpers/isolated-pg.mjs";
import { setImmediate } from "node:timers/promises";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";

test("family backup uses a consistent snapshot and rechecks membership", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL");
  const fixture = await isolatedPostgres(url);
  const gateway = createTestGateway();
  let app;
  let watch = null;
  try {
    await applyMigrations(fixture.pool);
    const database = {
      query: (...args) => fixture.database.query(...args),
      withTransaction: (work) => fixture.database.withTransaction((tx) => work({ query: async (sql, params) => {
        const result = await tx.query(sql, params);
        if (watch && /FROM medicines WHERE family_id = \$1 AND deleted_at IS NULL/.test(sql)) {
          const current = watch;
          watch = null;
          current.read.resolve();
          await bounded(current.release.promise, "release backup snapshot");
        }
        return result;
      } })),
    };
    app = await buildServer({ database, wechatGateway: gateway, logger: false });
    async function login() {
      const code = randomUUID();
      gateway.registerCode(code, `backup-snapshot-${code}`);
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } });
      assert.equal(response.statusCode, 200);
      return { token: response.json().token, id: response.json().user.id };
    }
    const call = (user, method, path, payload, headers = {}) => app.inject({ method, url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${user.token}`, ...headers }, ...(payload === undefined ? {} : { payload }) });
    const json = (response, expected) => { assert.equal(response.statusCode, expected, response.body); return response.json(); };
    const owner = await login();
    const family = json(await call(owner, "POST", "/families", { name: "快照合成家庭" }), 201).family;
    const medicine = json(await call(owner, "POST", "/medicines", { name: "旧药名", batches: [{ lotNumber: "旧批次", quantity: 1, unit: "box" }] }), 201);

    await t.test("medicine and batch cannot come from opposite sides of a concurrent commit", async () => {
      const read = signal();
      const release = signal();
      let pending;
      watch = { read, release };
      try {
        pending = call(owner, "POST", "/backups/json", {});
        await bounded(read.promise, "backup reads old medicine");
        await fixture.database.withTransaction(async (tx) => {
          await tx.query("UPDATE medicines SET name=$1,version=version+1 WHERE id=$2", ["新药名", medicine.id]);
          await tx.query("UPDATE medicine_batches SET lot_number=$1,version=version+1 WHERE id=$2", ["新批次", medicine.batches[0].id]);
        });
        release.resolve();
        const backup = json(await pending, 200);
        assert.equal(backup.medicines[0].name, "旧药名");
        assert.equal(backup.medicines[0].batches[0].lotNumber, "旧批次");
      } finally {
        release.resolve();
        watch = null;
        if (pending) await pending.catch(() => undefined);
      }
    });

    await t.test("revocation during the family-lock wait cannot export an old snapshot", async () => {
      const member = await login();
      await fixture.pool.query("INSERT INTO family_members (family_id,user_id,role) VALUES ($1,$2,'member')", [family.id, member.id]);
      await fixture.pool.query("UPDATE sessions SET active_family_id=$1 WHERE user_id=$2", [family.id, member.id]);
      const leader = await fixture.pool.connect();
      let pending;
      try {
        await leader.query("BEGIN");
        const pid = (await leader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await leader.query("SELECT id FROM families WHERE id = $1 FOR UPDATE", [family.id]);
        pending = call(member, "POST", "/backups/json", {});
        const deadline = Date.now() + 8000;
        while (true) {
          if (Date.now() > deadline) throw new Error("backup did not wait on the family lock");
          const blocked = await fixture.pool.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS hit", [pid]);
          if (blocked.rows[0].hit) break;
          await setImmediate();
        }
        await leader.query("DELETE FROM family_members WHERE family_id=$1 AND user_id=$2", [family.id, member.id]);
        await leader.query("COMMIT");
        const denied = await pending;
        assert.ok([404, 503].includes(denied.statusCode), denied.body);
      } finally {
        await leader.query("ROLLBACK").catch(() => undefined);
        leader.release();
        if (pending) await pending.catch(() => undefined);
      }
    });
  } finally {
    if (app) await app.close();
    await fixture.close();
  }
});
