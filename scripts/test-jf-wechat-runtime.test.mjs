import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, validateSourceApi, parseToolResult, runtimeFlagsExpression, extractRuntimeFlags, validSitemap, fullVerificationStatus } from './test-jf-wechat-runtime.mjs';
test('requires three explicit absolute paths', () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--project', 'relative']));
  assert.equal(parseArgs(['--project', process.cwd(), '--wechatide-path', process.execPath, '--evidence-dir', process.cwd()]).project, process.cwd());
});
test('refuses production API, credentials and extra URL components', () => {
  assert.equal(validateSourceApi('export const API_BASE = "http://127.0.0.1:13307";'), 'http://127.0.0.1:13307');
  for (const value of ['https://example.com', 'http://user:password@localhost', 'http://localhost/api', 'http://localhost?q=secret']) assert.throws(() => validateSourceApi(`export const API_BASE = "${value}";`));
});
test('tool errors cannot leak raw secret output', () => {
  for (const value of ['token=private', '{"error":"token=private"}', '{"success":false}']) assert.throws(() => parseToolResult(value), error => !error.message.includes('private'));
  assert.equal(parseToolResult('{"ok":true,"result":{"success":true}}').ok, true);
  assert.throws(() => parseToolResult('{"ok":false,"errorType":"failure"}'));
  assert.throws(() => parseToolResult('{"ok":true,"result":{"success":false}}'));
});
test('runtime accepts only complete flag objects in official result envelopes', () => {
  const flags = { route: 'pages/index/index', error: false, loaded: true, filter: '' };
  for (const key of ['result', 'value', 'data']) assert.deepEqual(extractRuntimeFlags({ result: { [key]: flags } }), flags);
  assert.deepEqual(extractRuntimeFlags({ok:true,result:{success:true,result:{result:flags}}}),flags);
  assert.throws(() => extractRuntimeFlags({ result: { success: true } }));
  assert.throws(() => extractRuntimeFlags({ result: { value: { route: 'pages/index/index' } } }));
});
test('sitemap empty or malformed rules fail', () => {
  assert.equal(validSitemap({ rules: [{ action: 'disallow', page: '*' }] }), true);
  for (const rules of [[], [{ action: 'bad', page: '*' }], [{ action: 'allow' }]]) assert.equal(validSitemap({ rules }), false);
});
test('pending critical cases never produce full pass', () => {
  assert.equal(fullVerificationStatus([{ status: 'PASS' }]), 'PASS');
  for (const status of ['NOT_RUN', 'BLOCKED', 'FAIL']) assert.equal(fullVerificationStatus([{ status: 'PASS' }, { status }]), 'INCOMPLETE');
  assert.equal(fullVerificationStatus([]), 'INCOMPLETE');
});
test('runtime probe is constrained to non-sensitive flags', () => {
  const probe = runtimeFlagsExpression();
  assert.ok(!/token|userinfo|storage|request/i.test(probe));
  assert.match(probe, /errorMessage/);
});
