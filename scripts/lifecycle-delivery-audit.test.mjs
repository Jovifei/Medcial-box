import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("lifecycle audit reports repository lifecycle boundaries", async () => {
  const { stdout } = await exec(process.execPath, ["scripts/lifecycle-delivery-audit.mjs"]);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.limits.length, 2);
});
