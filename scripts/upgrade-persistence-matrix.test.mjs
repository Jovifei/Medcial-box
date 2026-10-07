import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

test("upgrade matrix separates repository checks from device receipts", async () => {
  const { stdout } = await run(process.execPath, ["scripts/upgrade-persistence-matrix.mjs"], { cwd: process.cwd() });
  const result = JSON.parse(stdout);
  assert.equal(result.cases.some((item) => item.id === "android-install-r"), true);
  assert.equal(result.limits.some((item) => item.includes("real device")), true);
});
