import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("lifecycle audit requires executable hooks, not only markers", async () => {
  const { stdout } = await exec(process.execPath, ["scripts/lifecycle-delivery-audit.mjs"]);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.ok(result.checks.some((item) => item.name.includes("spawn-service")));
  assert.ok(result.checks.some((item) => item.name.includes("shutdown-handler")));
  assert.ok(result.checks.some((item) => item.name.includes("resource-close")));
});
