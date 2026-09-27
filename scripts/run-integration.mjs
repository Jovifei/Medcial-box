import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.TEST_DATABASE_URL) {
  console.error("Set TEST_DATABASE_URL to a dedicated PostgreSQL test database.");
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", "apps/api/test/integration-pg.test.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, REQUIRE_POSTGRES_TESTS: "1" },
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
}
