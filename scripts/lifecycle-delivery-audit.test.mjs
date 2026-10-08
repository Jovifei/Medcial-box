import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { inspectLifecycle } from './lifecycle-delivery-audit.mjs';

const exec = promisify(execFile);

test("lifecycle audit separates static syntax from runtime", async () => {
  const { stdout } = await exec(process.execPath, ["scripts/lifecycle-delivery-audit.mjs"]);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.runtimeStatus, 'NOT_RUN');
  assert.equal(result.checks.length, 2);
  assert.ok(result.checks.every(item => item.scope === 'STATIC_SYNTAX' && item.ok));
});

test('comments do not satisfy lifecycle checks', () => {
  assert.equal(inspectLifecycle('// spawn(); fetch(); /api/v1/health/local-app-trial', true), false);
  assert.equal(inspectLifecycle('// process.on(); app.close(); SIGINT SIGTERM', false), false);
  assert.equal(inspectLifecycle('process.on("SIGINT", () => app.close());', false), false);
});
test('unimplemented real runtime mode fails explicitly', async () => {
  await assert.rejects(exec(process.execPath, ['scripts/lifecycle-delivery-audit.mjs'], {
    env: { ...process.env, MEDBOX_LIFECYCLE_REAL: 'true' },
  }), error => JSON.parse(error.stdout).runtimeStatus === 'UNSUPPORTED');
});
