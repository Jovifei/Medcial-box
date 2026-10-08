#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import ts from 'typescript';
const root = fileURLToPath(new URL('..', import.meta.url));
// Inspect executable syntax; comments cannot satisfy these static checks.
export function inspectLifecycle(source, launcher) {
  const ast = ts.createSourceFile('target.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = new Set();
  const strings = new Set();
  function visit(node) {
    if (ts.isCallExpression(node)) calls.add(node.expression.getText(ast));
    if (ts.isStringLiteralLike(node)) strings.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return launcher
    ? calls.has('spawn') && calls.has('fetch') && [...strings].some(value => value.includes('/api/v1/health/local-app-trial'))
    : calls.has('process.on') && calls.has('app.close') && strings.has('SIGINT') && strings.has('SIGTERM');
}
async function main() {
  const checks = [];
  for (const [file, launcher] of [['scripts/start-local-trials.mjs', true], ['scripts/dev-simulator-server.mjs', false]]) {
    try {
      checks.push({ name: file, ok: inspectLifecycle(await readFile(resolve(root, file), 'utf8'), launcher), scope: 'STATIC_SYNTAX' });
    } catch (error) {
      checks.push({ name: file, ok: false, detail: error.code ?? error.message });
    }
  }
  const realRuntimeRequested = process.env.MEDBOX_LIFECYCLE_REAL === 'true';
  const result = {
    ok: checks.every(item => item.ok) && !realRuntimeRequested,
    checks, realRuntimeRequested,
    runtimeStatus: realRuntimeRequested ? 'UNSUPPORTED' : 'NOT_RUN',
    limitations: ['Static syntax checks do not prove service startup, shutdown or resource cleanup. Real runtime probing is not implemented.'],
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
