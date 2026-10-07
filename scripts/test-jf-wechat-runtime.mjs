/** Official wechatide runtime gate. No mock login, session dump or production writes.
 * NOT_RUN cases require fixtures/human observation: existing batch correction,
 * restock/stocktake persistence, plan retry/reminders, export content/privacy,
 * backup restore, family permissions, camera/OCR, offline errors, remote device,
 * package upload and IDE quality scan. Navigation is only a smoke assertion.
 */
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--project', '--wechatide-path', '--evidence-dir', '--fixture-name'].includes(args[i]) || !args[i + 1]) throw new Error('Explicit project, tool and evidence paths required');
    result[args[i].slice(2)] = args[i + 1];
  }
  for (const key of ['project', 'wechatide-path', 'evidence-dir']) if (!result[key] || !path.isAbsolute(result[key])) throw new Error('Paths must be absolute');
  if (result['fixture-name']) validateFixtureName(result['fixture-name']);
  return result;
}
export function validateFixtureName(name) {
  if (!/^JF-UI-TEST-[A-Za-z0-9-]{1,60}$/.test(name)) throw new Error('Only uniquely named JF-UI-TEST fixtures accepted');
  return name;
}
export function assertFixtureReadback(list, name, quantity, date, previousVersion = 0) {
  const matches = list.medicines?.filter(item => item.name === name);
  if (matches?.length !== 1) throw new Error('Fixture must resolve to exactly one medicine');
  const medicine = matches[0]; const batch = medicine.batches?.[0];
  if (medicine.batches.length !== 1 || batch.quantity !== quantity || batch.unit !== 'box' || batch.expiry?.value !== date || batch.expiry?.precision !== 'day' || medicine.version <= previousVersion) throw new Error('Fixture persistence assertion failed');
  return { id: medicine.id, version: medicine.version };
}
export function validateSourceApi(source) {
  const match = source.match(/export const API_BASE\s*=\s*["']([^"']+)["']/);
  if (!match) throw new Error('API_BASE missing');
  const url = new URL(match[1]);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Only explicit loopback test API accepted');
  return url.origin;
}
export function parseToolResult(output) {
  // Never include raw output in exceptions or evidence (it may contain credentials).
  let value;
  try { value = JSON.parse(output); } catch { throw new Error('Tool returned unparseable output'); }
  if (value.ok !== true || value.success === false || value.isError === true || value.error || value.result?.success === false || value.result?.error) throw new Error('Official tool reported failure');
  return value;
}
export function extractRuntimeFlags(envelope) {
  let value = envelope;
  for (let i = 0; i < 4 && value && typeof value.route !== 'string'; i++) {
    value = value.result ?? value.value ?? value.data;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw new Error('Runtime result envelope not recognized'); } }
  }
  if (!value || typeof value.route !== 'string' || typeof value.error !== 'boolean' || typeof value.loaded !== 'boolean' || typeof value.filter !== 'string') throw new Error('Runtime result envelope not recognized');
  return value;
}
export function validSitemap(value) {
  return Array.isArray(value.rules) && value.rules.length > 0 && value.rules.every(rule => ['allow', 'disallow'].includes(rule.action) && typeof rule.page === 'string' && rule.page.length > 0);
}
export function fullVerificationStatus(rows) {
  return rows.length && rows.every(row => row.status === 'PASS') ? 'PASS' : 'INCOMPLETE';
}
export function runtimeFlagsExpression() {
  return `function(){var p=getCurrentPages();var c=p[p.length-1];var d=c?c.data:{};return {route:c?c.route:'',error:!!d.errorMessage,draft:!!d.draftAvailable,loaded:Array.isArray(d.allItems)&&!!d.familyName&&d.isExample===false,filter:d.filterPanel||''};}`;
}
export async function run(options) {
  const rows = [];
  const record = (id, status, note) => rows.push({ id, status, note });
  const project = path.resolve(options.project);
  const app = JSON.parse(await readFile(path.join(project, 'app.json'), 'utf8'));
  const api = validateSourceApi(await readFile(path.join(project, 'services/config.ts'), 'utf8'));
  const sitemap = JSON.parse(await readFile(path.join(project, app.sitemapLocation), 'utf8'));
  record('source-sitemap', validSitemap(sitemap) ? 'PASS' : 'FAIL', 'Nonempty rules with allow/disallow action and page');
  const health = await fetch(`${api}/api/v1/health/local-app-trial`, { signal: globalThis.AbortSignal.timeout(5000) });
  if (!health.ok || (await health.json()).mode !== 'local-app-trial') throw new Error('Local test marker absent; runtime writes stopped');
  record('local-api-marker', 'PASS', 'Loopback endpoint explicitly marks local-app-trial');
  // Invoke the official installed CLI bootstrap directly: no cmd.exe interpolation.
  const root = path.dirname(options['wechatide-path']);
  const cli = path.join(root, 'resources/app.asar.unpacked/js/common/cli/skill-index.js');
  await stat(cli);
  let executable;
  for (const name of await readdir(root)) if (/\.exe$/i.test(name) && !/^(node|node-18|wxfilewatcher|wxfilewatcher_x64|notification_helper|wechatdevtools)\.exe$/i.test(name) && (await stat(path.join(root, name))).size > 50000000) executable = path.join(root, name);
  if (!executable) throw new Error('Official Electron CLI runtime missing');
  const invoke = (tool, args = []) => new Promise((resolve, reject) => {
    const bootstrap = "const e=process.argv[1],a=process.argv.slice(2).filter(function(x){return x!=='--electron'});if(!process.env.cwd)process.env.cwd=process.cwd();process.argv=[process.execPath,e,'--electron'].concat(a);require(e)";
    const child = spawn(executable, ['-e', bootstrap, cli, '-c', 'Codex', tool, '--project', project, ...args], { shell: false, windowsHide: true, cwd: root, env: { ...process.env, cwd: project, ELECTRON_RUN_AS_NODE: '1', ELECTRON: '' } });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Tool timeout')); }, 30000);
    child.stdout.on('data', chunk => { if (output.length < 1000000) output += chunk; });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('Tool launch failed')); });
    child.on('close', code => { clearTimeout(timer); try { if (code !== 0) throw new Error(`Tool exit failed: ${tool} (${code})`); resolve(parseToolResult(output)); } catch (error) { reject(error); } });
  });
  const flags = async () => {
    const result = await invoke('automation_evaluate', ['--fn-source', runtimeFlagsExpression()]);
    // Accept only the documented JSON object envelope; don't search raw strings for PASS.
    return extractRuntimeFlags(result);
  };
  const navigate = (route, action) => invoke('automation_navigate', ['--action', action, '--url', `/${route}`]);
  const fixtureName = options['fixture-name'];
  const checkedDraftCount = async () => {
    let value = await invoke('automation_evaluate', ['--fn-source', "function(){var p=getCurrentPages();var c=p[p.length-1];return {safeFamily:!!c&&c.route==='pages/index/index'&&c.data.familyName==='JF小药箱小程序试用家庭',draftCount:wx.getStorageInfoSync().keys.filter(function(k){return k.indexOf('medicine-edit-draft')!==-1}).length};}"]);
    for (let depth = 0; depth < 5 && value?.draftCount === undefined; depth++) { value = value?.result ?? value?.value ?? value?.data; if (typeof value === 'string') value = JSON.parse(value); }
    if (value?.draftCount !== 0 || value.safeFamily !== true) throw new Error('Existing medicine drafts or unsafe UI family; fixture write blocked');
  };
  const fixtureFlow = async () => {
    validateFixtureName(fixtureName);
    const request = async (route, token, payload) => {
      const response = await fetch(`${api}/api/v1/${route}`, { method: payload ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: globalThis.AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Local fixture readback API failed');
      return response.json();
    };
    const session = await request('auth/wechat', null, { code: 'JF-UI-TEST-readback' });
    const token = session.token;
    if (typeof token !== 'string' || (await request('auth/me', token)).family?.name !== 'JF小药箱小程序试用家庭') throw new Error('Exact synthetic family guard failed');
    const initial = await request('medicines', token);
    if (initial.medicines.some(item => item.name === fixtureName)) throw new Error('Fixture name already exists; use a fresh unique name');
    await checkedDraftCount();
    await mkdir(options['evidence-dir'], { recursive: true });
    const setDate = async date => {
      for (const [method, detail] of [['onBatchPrecisionChange', { value: 0 }], ['onExpiryDateChange', { value: date }]]) {
        const file = path.join(options['evidence-dir'], `${method}-fixture.json`);
        await writeFile(file, JSON.stringify([{ currentTarget: { dataset: { index: '0' } }, detail }]));
        await invoke('automation_page_action', ['--action', 'callMethod', '--method', method, '--args-file', file]);
      }
    };
    const input = (field, value) => invoke('automation_element_action', ['--action', 'input', '--selector', `input[data-field="${field}"]`, '--value', value, '--wait-for-selector', `input[data-field="${field}"]`]);
    const saveAndRead = async (quantity, date, previousVersion = 0) => {
      await invoke('automation_element_action', ['--action', 'tap', '--selector', '.save-action']);
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try { return assertFixtureReadback(await request('medicines', token), fixtureName, quantity, date, previousVersion); } catch { /* bounded persistence poll; raw records never retained */ }
      }
      throw new Error('Fixture persistence assertion timed out');
    };
    await navigate('pages/medicine-edit/medicine-edit', 'navigateTo');
    await input('name', fixtureName); await input('quantity', '5'); await setDate('2027-12-31');
    const created = await saveAndRead(5, '2027-12-31');
    record('medicine-minimal-create', 'PASS', 'Synthetic UI input + real save tap + API persistence; date controller event, not native picker gesture');
    await navigate('pages/index/index', 'switchTab');
    await new Promise(resolve => setTimeout(resolve, 750));
    await checkedDraftCount();
    await navigate('pages/medicine-edit/medicine-edit', 'navigateTo');
    let fresh = await invoke('automation_evaluate', ['--fn-source', "function(){var p=getCurrentPages();var d=p[p.length-1].data;return {fresh:d.name===''&&d.activePhotoDraftId===''&&!d.draftAvailable&&d.batches[0].expiryValue===''};}"]);
    for (let depth = 0; depth < 5 && fresh?.fresh === undefined; depth++) { fresh = fresh?.result ?? fresh?.value ?? fresh?.data; if (typeof fresh === 'string') fresh = JSON.parse(fresh); }
    if (fresh?.fresh !== true) throw new Error('Second medicine inherited previous form or draft');
    record('medicine-next-entry-empty', 'PASS', 'After UI save, next add has empty name/date and no active photo or form draft');
    await navigate('pages/index/index', 'switchTab');
    await navigate(`pages/medicine-edit/medicine-edit?id=${encodeURIComponent(created.id)}`, 'navigateTo');
    await new Promise(resolve => setTimeout(resolve, 1000));
    await input('quantity', '6'); await setDate('2028-02-29');
    await saveAndRead(6, '2028-02-29', created.version);
    record('medicine-edit-persistence', 'PASS', 'Same synthetic medicine edited through UI and reread; version increased; record retained');
    await navigate('pages/index/index', 'switchTab');
  };
  try {
    // Use a fresh native runtime: restoring an API that was never mocked can
    // remove wx.login in this DevTools RC. This runner never installs mocks.
    let state = await flags();
    if (state.route === 'pages/index/index' && state.loaded && !state.error) {
      record('existing-session-restoration', 'PASS', 'Already authenticated home observed; existing credentials preserved');
      record('native-wx-login-ui', 'NOT_RUN', 'Existing session auto-redirects login page; requires separate unsigned-in fixture, not cache deletion');
    } else if (state.route === 'pages/login/login') {
      await invoke('automation_element_action', ['--action', 'tap', '--selector', '.login-card .btn-primary', '--wait-for-selector', '.login-card .btn-primary']);
      for (let attempt = 0; attempt < 8; attempt++) { await new Promise(resolve => setTimeout(resolve, 750)); state = await flags(); if (state.error || state.route !== 'pages/login/login') break; }
      record('native-wx-login-ui', state.error || state.route === 'pages/login/login' ? 'FAIL' : 'PASS', 'Native wx.login + real button tap against local gateway; not real WeChat backend identity acceptance');
    } else throw new Error('Current page is not a safe login/home fixture');
    if (state.error || state.route !== 'pages/index/index') throw new Error('Authenticated existing-family home unavailable');
    record('home-load', state.loaded ? 'PASS' : 'FAIL', 'Home inventory data shape and error flag');
    await invoke('automation_element_action', ['--action', 'tap', '--selector', '.filter-chip[data-panel="purpose"]']);
    record('purpose-filter-open', (await flags()).filter === 'purpose' ? 'PASS' : 'FAIL', 'Purpose panel opens; filtering results pending synthetic fixture');
    if (fixtureName) await fixtureFlow();
    for (const tab of app.tabBar.list) {
      if ((await flags()).route !== tab.pagePath) await navigate(tab.pagePath, 'switchTab');
      const state = await flags();
      record(`tab:${tab.pagePath}`, state.route === tab.pagePath && !state.error ? 'PASS' : 'FAIL', 'Navigation + page error flag only; not business workflow acceptance');
    }
    if ((await flags()).route !== 'pages/index/index') await navigate('pages/index/index', 'switchTab');
  } catch (error) { record('runtime-flow', 'BLOCKED', error.message); }
  for (const page of app.pages) record(`registered-page:${page}`, 'NOT_RUN', 'Direct navigation may need identifiers or alter drafts; requires safe fixture and meaningful assertion');
  for (const item of ['medicine-minimal-create', 'medicine-edit-persistence', 'batch-edit-persistence', 'restock', 'stocktake', 'filter-results', 'plan-create-retry', 'export-content', 'backup-restore', 'family-permissions', 'mine-settings', 'camera-ocr', 'offline-errors', 'remote-debug-device', 'preview-upload', 'ide-quality']) if (!rows.some(row => row.id === item)) record(item, 'NOT_RUN', 'Requires isolated synthetic fixture/human or provider gate; never inferred from compilation');
  await mkdir(options['evidence-dir'], { recursive: true });
  await writeFile(path.join(options['evidence-dir'], 'runtime-matrix.json'), JSON.stringify({ testedAt: new Date().toISOString(), fullVerification: fullVerificationStatus(rows), rows }, null, 2));
  console.log(JSON.stringify({ fullVerification: fullVerificationStatus(rows), rows }));
  return rows;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run(parseArgs(process.argv.slice(2))).then(rows => { if (fullVerificationStatus(rows) !== 'PASS') process.exitCode = 1; }).catch(() => { console.error('Preflight BLOCKED; inspect explicit paths, package and local test API. No raw tool output retained.'); process.exitCode = 1; });
