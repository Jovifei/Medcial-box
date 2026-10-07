import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

test("release candidate hardening audit reports repository-side gates only", async () => {
  const { stdout } = await run(process.execPath, ["scripts/release-candidate-hardening.mjs"], { cwd: process.cwd() });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.limitations.some((item) => item.includes("WeChat backend")), true);
  assert.equal(result.limitations.some((item) => item.includes("two-device")), true);
});
