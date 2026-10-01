import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.TEST_DATABASE_URL) {
  console.error("Set TEST_DATABASE_URL to a dedicated PostgreSQL test database.");
  process.exitCode = 1;
} else {
  // 每个文件独立进程运行：登录速率限制器是进程本地的，合并会耗尽共享配额。
  const suites = [
    "apps/api/test/integration-pg.test.mjs",
    "apps/api/test/integration-pg-reminders.test.mjs",
    "apps/api/test/integration-pg-quantity.test.mjs",
    "apps/api/test/integration-pg-tags.test.mjs",
    "apps/api/test/integration-pg-photos.test.mjs",
    "apps/api/test/integration-pg-plans.test.mjs",
    "apps/api/test/integration-pg-dose-reminders.test.mjs",
  ];
  let status = 0;
  for (const suite of suites) {
    const result = spawnSync(process.execPath, ["--test", suite], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, REQUIRE_POSTGRES_TESTS: "1" },
      stdio: "inherit",
    });
    status = status === 0 ? (result.status ?? 1) : status;
  }
  process.exitCode = status;
}
