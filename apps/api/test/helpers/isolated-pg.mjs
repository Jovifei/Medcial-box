import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { Pool } from "pg";
import { createDatabaseAdapter } from "../../dist/db.js";

export async function bounded(promise, label, milliseconds = 8000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function signal() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// No DATABASE_URL fallback, no public-schema changes, no pre-existing-schema cleanup.
export async function isolatedPostgres(connectionString) {
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required");
  const parsedUrl = new URL(connectionString);
  // pg parses URL options after Pool options; remove them to enforce isolation.
  parsedUrl.searchParams.delete("options");
  connectionString = parsedUrl.toString();
  const schema = `medbox_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000,
    options: "-c search_path=pg_catalog -c statement_timeout=10000" });
  let owned = false;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    owned = true;
    pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=10000 -c lock_timeout=10000` });
    const production = createDatabaseAdapter(pool);
    const fixture = {
      schema, pool, observe: null,
      database: {
        query: (...args) => production.query(...args),
        withTransaction: (fn) => production.withTransaction(async (tx) => {
          const pid = fixture.observe ? (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid : null;
          return fn({ query: (sql, params) => fixture.observe
            ? fixture.observe({ sql, params, pid, run: () => tx.query(sql, params) })
            : tx.query(sql, params) });
        }),
      },
      async close() {
        fixture.observe = null;
        await pool.end();
        // This name is generated here and owned only after CREATE SCHEMA succeeds.
        try { if (owned) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
        finally { owned = false; await admin.end(); }
      },
    };
    return fixture;
  } catch (error) {
    if (pool) await pool.end();
    try { if (owned) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
    throw error;
  }
}

// Hold the first real row lock, start the second real SQL query, and require
// PostgreSQL itself to report its blocking PID before releasing the first.
export async function contend(fixture, pattern, leader, follower) {
  const acquired = signal();
  const attempted = signal();
  const release = signal();
  let firstPid;
  let secondPid;
  let seen = 0;
  const requests = [];
  fixture.observe = async ({ sql, pid, run }) => {
    if (!pattern.test(sql)) return run();
    const order = ++seen;
    if (order === 1) {
      const result = await run();
      firstPid = pid;
      acquired.resolve();
      await bounded(release.promise, "release leader lock");
      return result;
    }
    const pending = run();
    // Attach a rejection handler immediately; cleanup still awaits the request.
    pending.catch(() => {});
    if (order === 2) { secondPid = pid; attempted.resolve(); }
    return pending;
  };
  try {
    requests.push(Promise.resolve().then(leader));
    requests[0].catch(() => {});
    await bounded(acquired.promise, "leader acquires row lock");
    requests.push(Promise.resolve().then(follower));
    requests[1].catch(() => {});
    await bounded(attempted.promise, "follower issues row lock");
    const deadline = Date.now() + 8000;
    while (true) {
        if (Date.now() > deadline) throw new Error("Timed out: PostgreSQL confirms contention");
        const result = await fixture.pool.query("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [firstPid, secondPid]);
        if (result.rows[0].blocked) break;
        await setImmediate();
    }
    release.resolve();
    return await Promise.all(requests);
  } finally {
    release.resolve();
    fixture.observe = null;
    await Promise.allSettled(requests);
  }
}
