import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareQa, inventorySource, assertReviewedInventory, assertReviewedComponents, DEFAULT_SOURCE_SHA } from './prepare-miniprogram-qa.mjs';
import { checkMiniProgramPackage } from './check-miniprogram-package.mjs';
import { makePageContext } from '../apps/miniprogram/test/runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const runtimeText = readFileSync(join(root, 'scripts/qa/fixture-runtime.cjs'), 'utf8');
const mockText = readFileSync(join(root, 'scripts/qa/synthetic-mock.cjs'), 'utf8');
const dangerous = ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'clearStorageSync', 'getStorageInfoSync',
  'getStorage', 'setStorage', 'removeStorage', 'clearStorage', 'getStorageInfo', 'batchGetStorage', 'batchSetStorage',
  'batchGetStorageSync', 'batchSetStorageSync', 'getFileSystemManager', 'request', 'downloadFile', 'uploadFile',
  'connectSocket', 'login', 'checkSession', 'chooseMedia', 'chooseImage', 'scanCode', 'previewImage', 'setClipboardData',
  'shareFileMessage', 'chooseMessageFile', 'requestSubscribeMessage', 'getUpdateManager', 'base64ToArrayBuffer'];
const uiNames = ['showToast', 'showModal', 'showActionSheet', 'navigateTo', 'redirectTo', 'navigateBack', 'reLaunch', 'switchTab',
  'stopPullDownRefresh', 'enableAlertBeforeUnload', 'disableAlertBeforeUnload', 'hideShareMenu'];
function harness({ project, mutateNative, mockOverride } = {}) {
  const counts = {};
  const uiCalls = [];
  const native = {};
  for (const name of dangerous) native[name] = () => { counts[name] = (counts[name] ?? 0) + 1; throw new Error('ORIGINAL MUST NEVER RUN: ' + name); };
  native.cloud = new Proxy({}, { get() { counts.cloud = (counts.cloud ?? 0) + 1; throw new Error('ORIGINAL CLOUD'); } });
  native.getSystemInfoSync = () => ({ platform: 'devtools' });
  native.getAccountInfoSync = () => ({ miniProgram: { appId: 'touristappid', envVersion: 'develop' } });
  for (const name of uiNames) native[name] = options => { uiCalls.push({ name, options }); if (name === 'showModal') options.success?.({ confirm: true, cancel: false }); if (name === 'showActionSheet') options.success?.({ tapIndex: 0 }); };
  mutateNative?.(native);
  let app;
  let page;
  let component;
  let productLoads = 0;
  const cache = new Map();
  const sandbox = vm.createContext({
    wx: native,
    App: value => { app = value; },
    Page: value => { page = value; },
    Component: value => { component = value; },
    console, setTimeout, clearTimeout, getApp: () => app,
  });
  function load(filename) {
    filename = resolve(filename);
    if (!/\.(js|cjs|json)$/.test(filename)) filename += '.js';
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    if (filename.endsWith('.json')) { module.exports = JSON.parse(readFileSync(filename, 'utf8')); return module.exports; }
    let source;
    const normalizedFilename = filename.replaceAll('\\', '/');
    if (normalizedFilename.endsWith('/qa/fixture-runtime.js')) source = runtimeText;
    else if (normalizedFilename.endsWith('/qa/synthetic-mock.js')) source = mockText;
    else { source = readFileSync(filename, 'utf8'); if (filename.endsWith('app-product.js')) productLoads++; }
    const require = id => {
      if (mockOverride && id === './synthetic-mock') return mockOverride;
      return load(resolve(dirname(filename), id));
    };
    vm.runInContext('(function(require,module,exports){' + source + '\n})', sandbox, { filename })(require, module, module.exports);
    return module.exports;
  }
  const standalone = '/virtual/project/qa/fixture-runtime.js';
  const runtime = project ? null : load(standalone);
  const config = { buildMark: 'MEDICINE_QA_ONLY', appId: 'touristappid', runId: 'self-test', sourceSha: DEFAULT_SOURCE_SHA,
    pages: ['pages/login/login', 'pages/index/index', 'pages/medicine-edit/medicine-edit'], wxInventory: [], fsInventory: [] };
  return {
    native, counts, uiCalls, load, cache, config, runtime,
    get app() { return app; },
    get page() { return page; },
    get component() { return component; },
    get productLoads() { return productLoads; },
    install() { return runtime.install(native, config, sandbox.App, sandbox.Page, sandbox.Component); },
  };
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const callback = invoke => new Promise((resolve, reject) => invoke({ success: resolve, fail: reject }));
function assertNoOriginals(h) { assert.deepEqual(h.counts, {}); }

test('memory storage APIs, fake auth/files/media never invoke throwing original-method sentinels', async () => {
  const h = harness(); h.install(); const wx = h.runtime.bindings().wx;
  wx.setStorageSync('key', { a: 1 }); const value = wx.getStorageSync('key'); value.a = 7; assert.equal(wx.getStorageSync('key').a, 1);
  await callback(done => wx.setStorage({ key: 'async', data: 2, ...done }));
  assert.equal((await callback(done => wx.getStorage({ key: 'async', ...done }))).data, 2);
  assert.equal((await callback(done => wx.getStorageInfo(done))).keys.length, 2);
  await callback(done => wx.removeStorage({ key: 'async', ...done }));
  wx.batchSetStorageSync([{ key: 'batch', data: 3 }]); assert.equal(wx.batchGetStorageSync(['batch'])[0].data, 3);
  await callback(done => wx.batchSetStorage({ dataList: [{ key: 'b2', data: 4 }], ...done }));
  assert.equal((await callback(done => wx.batchGetStorage({ keyList: ['b2'], ...done }))).dataList[0].data, 4);
  await callback(done => wx.clearStorage(done)); assert.equal(wx.getStorageInfoSync().keys.length, 0);
  wx.setStorageSync('x', 1); wx.clearStorageSync(); assert.equal(wx.getStorageSync('x'), '');
  await wx.checkSession(); assert.equal((await wx.login()).code, 'qa-code-A');
  const photo = await wx.chooseMedia({}); const fs = wx.getFileSystemManager();
  const image = await callback(done => fs.readFile({ filePath: photo.tempFiles[0].tempFilePath, encoding: 'base64', ...done }));
  assert.match(image.data, /^iVBOR/);
  const path = wx.env.USER_DATA_PATH + '/written.png';
  await callback(done => fs.writeFile({ filePath: path, data: image.data, encoding: 'base64', ...done }));
  assert.equal(fs.readFileSync(path, 'base64'), image.data);
  await callback(done => fs.unlink({ filePath: path, ...done }));
  assert.throws(() => fs.readFileSync(path, 'base64'), /no such file/);
  assertNoOriginals(h);
});

test('exact origin, method, normalized route and denied network/unknown API stop before original transport', () => {
  for (const url of ['https://example.com/api/v1/auth/me', 'http://127.0.0.1:43187.evil/api/v1/auth/me',
    'http://127.0.0.1:43187/api/v1/x/../auth/me', 'http://127.0.0.1:43187/api/v1/%61uth/me',
    'http://127.0.0.1:43187/api//v1/auth/me', 'http://127.0.0.1:43187/api/v1/auth/me?next=https://evil',
    'http://127.0.0.1:43187/api/v1/auth/me#fragment', 'http://localhost:43187/api/v1/auth/me']) {
    const h = harness(); h.install(); assert.throws(() => h.runtime.bindings().wx.request({ url }), /QA STOPPED/); assertNoOriginals(h);
    assert.throws(() => h.runtime.bindings(), /QA STOPPED/);
  }
  for (const name of ['uploadFile', 'connectSocket', 'shareFileMessage', 'chooseMessageFile', 'chooseImage', 'unknownFutureApi']) {
    const h = harness(); h.install(); assert.throws(() => h.runtime.bindings().wx[name]({}), /QA STOPPED/); assertNoOriginals(h);
  }
  const h = harness(); h.install(); assert.throws(() => h.runtime.bindings().wx.request({ url: 'http://127.0.0.1:43187/api/v1/auth/me', method: 'POST' }), /QA STOPPED/); assertNoOriginals(h);
});

test('non-synthetic file path, cloud API and unverified hook installation are fail-closed', () => {
  for (const file of ['/real/photo.jpg', '/__qa_memory__/self-test/../private', '/__qa_memory__/self-test/a%2fb']) {
    const h = harness(); h.install(); assert.throws(() => h.runtime.bindings().wx.getFileSystemManager().readFileSync(file, 'base64'), /QA STOPPED/); assertNoOriginals(h);
  }
  const h = harness(); h.install(); assert.throws(() => h.runtime.bindings().wx.cloud.callFunction(), /unknown cloud/); assertNoOriginals(h);
  const bad = harness({ mutateNative: native => { delete native.showModal; } });
  assert.throws(() => bad.install(), /unverifiable native UI hook/); assert.throws(() => bad.runtime.bindings(), /before every product module/); assertNoOriginals(bad);
});

test('redirect response is rejected without any native request being invoked', async () => {
  const mock = { validateRequest: () => '/api/v1/auth/me', ORIGIN: 'http://127.0.0.1:43187', createMock: () => ({ actor: () => 'A', dispatch: () => ({ statusCode: 302, header: { Location: 'https://example.com' } }) }) };
  const h = harness({ mockOverride: mock }); const controls = h.install();
  await callback(done => h.runtime.bindings().wx.request({ url: 'http://127.0.0.1:43187/api/v1/auth/me', ...done })).then(() => assert.fail('redirect accepted'), error => assert.match(error.errMsg, /redirect rejected/));
  assert.match(controls.summary().fatal, /redirect/); assertNoOriginals(h);
});

test('synthetic fs lifecycle exposes write/close failures and explicit retry, without native semantic claims', async () => {
  const h = harness(); const qa = h.install(); const wx = h.runtime.bindings().wx; const fs = wx.getFileSystemManager();
  const path = wx.env.USER_DATA_PATH + '/exclusive.png';
  const { fd } = await callback(done => fs.open({ filePath: path, flag: 'wx', ...done }));
  qa.failNext('fs.write'); await assert.rejects(callback(done => fs.write({ fd, data: wx.base64ToArrayBuffer('AAAA'), offset: 0, length: 3, position: 0, ...done })), /./);
  await callback(done => fs.write({ fd, data: wx.base64ToArrayBuffer('AAAA'), offset: 0, length: 3, position: 0, ...done }));
  qa.failNext('fs.close'); await assert.rejects(callback(done => fs.close({ fd, ...done })), /./);
  await callback(done => fs.close({ fd, ...done }));
  assert.equal(fs.readFileSync(path, 'base64'), 'AAAA'); assertNoOriginals(h);
});

test('AST inventory includes cast aliases and rejects dynamic/ambient escape', () => {
  const found = inventorySource('const native = wx as unknown as A; native.shareFileMessage(); const fs = wx.getFileSystemManager(); fs.writeFile({});', 'fixture.ts');
  assert.deepEqual(found.wx, ['getFileSystemManager', 'shareFileMessage']); assert.deepEqual(found.fs, ['writeFile']);
  assert.throws(() => inventorySource('wx[method]()', 'x.ts'), /dynamic/);
  assert.throws(() => inventorySource('globalThis.wx.request({})', 'x.ts'), /ambient escape/);
  assert.throws(() => assertReviewedInventory(inventorySource('wx.arrayBufferToBase64(new ArrayBuffer(1))', 'new.ts'), 'new.ts'), /unreviewed wx API/);
  assert.throws(() => assertReviewedInventory(inventorySource('wx.getFileSystemManager().stat({})', 'new.ts'), 'new.ts'), /unreviewed filesystem API/);
});

test('reviewed components are exact local dependencies and Component stays file-scoped', () => {
  assert.doesNotThrow(() => assertReviewedComponents(
    'pages/medicine-edit/medicine-edit.json',
    { 'medicine-date-field': '../../components/medicine-date-field/index' },
  ));
  assert.doesNotThrow(() => assertReviewedComponents(
    'pages/plan-create/plan-create.json',
    {
      'medicine-date-field': '../../components/medicine-date-field/index',
      'medicine-time-field': '../../components/medicine-time-field/index',
    },
  ));
  assert.throws(() => assertReviewedComponents(
    'pages/medicine-edit/medicine-edit.json',
    { 'medicine-date-field': 'plugin://evil/date' },
  ), /unreviewed component/);
  assert.throws(() => assertReviewedComponents(
    'pages/medicine-edit/medicine-edit.json',
    { 'future-widget': '../../components/future-widget/index' },
  ), /unreviewed component/);
  assert.doesNotThrow(() => inventorySource(
    'Component({ methods: { ok() {} } });',
    'components/medicine-time-field/index.ts',
  ));
  assert.throws(() => inventorySource('Component({});', 'pages/index/index.ts'), /ambient escape/);
});

test('QA Component methods and observers remain behind the fatal gate', () => {
  const h = harness();
  h.install();
  h.runtime.bindings().Component({
    methods: { ping() { return 'ok'; } },
    observers: { value() { return 'seen'; } },
  });
  assert.equal(h.component.methods.ping(), 'ok');
  assert.equal(h.component.observers.value(), 'seen');
  assert.throws(() => h.runtime.bindings().wx.futureUnsafeApi(), /QA STOPPED/);
  assert.throws(() => h.component.methods.ping(), /QA STOPPED/);
  assertNoOriginals(h);
});

let generated;
let integrated;
const committedHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
const headHasWriter = execFileSync('git', ['-C', root, 'ls-tree', '--name-only', committedHead, '--', 'apps/miniprogram/services/photo-file-lifecycle.ts']).toString().trim() !== '';
const integrationSha = process.env.QA_INTEGRATION_SOURCE_SHA ?? (headHasWriter ? committedHead : undefined);
let temp;
test.before(async () => { temp = await mkdtemp(join(tmpdir(), 'medicine-qa-test-')); generated = await prepareQa({ root, output: join(temp, 'fixture'), runId: 'self-test' }); if (integrationSha) integrated = await prepareQa({ root, sourceSha: integrationSha, output: join(temp, 'integrated'), runId: 'integrated-test' }); });
test.after(async () => { await rm(temp, { recursive: true, force: true }); });

test('generated source remains pinned and inspectable; release gate refuses QA fixture', async () => {
  const manifest = JSON.parse(await readFile(generated.manifest, 'utf8'));
  assert.equal(manifest.sourceSha, DEFAULT_SOURCE_SHA); assert.ok(manifest.wxInventory.includes('shareFileMessage'));
  assert.deepEqual(manifest.fsInventory, ['readFile', 'unlink', 'writeFile']);
  assert.ok((await readFile(generated.diff, 'utf8')).includes('MEDICINE_QA_ONLY'));
  const result = await checkMiniProgramPackage(generated.projectRoot); assert.equal(result.ok, false); assert.ok(result.errors.some(x => x.includes('QA-only')));
  assert.equal((await checkMiniProgramPackage(join(root, 'apps/miniprogram'), { mode: 'source' })).ok, true);
  for (const page of manifest.pages) {
    const code = await readFile(join(generated.projectRoot, page + '.js'), 'utf8');
    assert.match(code.split('\n')[1], /\.bindings\(\)/);
    const view = await readFile(join(generated.projectRoot, page + '.wxml'), 'utf8');
    assert.ok(view.startsWith('<view class="qa-only-banner">'));
    assert.doesNotMatch(view, /<image[^>]*src=["']{{/); assert.doesNotMatch(view, /open-type=["']share/);
  }
});

test('app cannot evaluate a product module before bootstrap or on release/real-device gate failure', () => {
  const h = harness({ project: generated.projectRoot });
  assert.throws(() => h.load(join(generated.projectRoot, 'pages/login/login.js')), /bootstrap must run/);
  for (const mutateNative of [native => { native.getSystemInfoSync = () => ({ platform: 'ios' }); }, native => { native.getAccountInfoSync = () => ({ miniProgram: { appId: 'wx1234567890abcdef', envVersion: 'release' } }); }]) {
    const gated = harness({ project: generated.projectRoot, mutateNative });
    assert.throws(() => gated.load(join(generated.projectRoot, 'app.js')), /QA requires/); assert.equal(gated.productLoads, 0); assertNoOriginals(gated);
  }
});

test('real generated login and medicine-entry page run against synthetic adapters; reentry shares only the current Map', async () => {
  const h = harness({ project: generated.projectRoot }); h.load(join(generated.projectRoot, 'app.js'));
  assert.equal(h.productLoads, 1); h.app.onLaunch();
  const auth = h.load(join(generated.projectRoot, 'services/auth.js'));
  await auth.loginWithWechat(); await auth.ensureLoggedIn();
  h.load(join(generated.projectRoot, 'pages/medicine-edit/medicine-edit.js'));
  const first = makePageContext(h.page); first.onLoad({}); await tick(); await first.onRecognizePhoto('camera');
  assert.equal(first.data.photoDrafts.length, 1); assert.equal(first.data.photoDrafts[0].status, 'review'); assert.match(first.data.name, /QA/);
  first.onHide(); first.onUnload();
  const second = makePageContext(h.page); second.onLoad({}); await tick();
  assert.equal(second.data.photoDrafts.length, 1);
  // Same runtime page reentry works, but a NEW runtime has empty storage by design.
  const fresh = harness({ project: generated.projectRoot }); fresh.load(join(generated.projectRoot, 'app.js'));
  assert.equal(fresh.app.qa.summary().storageKeys.length, 0);
  assertNoOriginals(h); assertNoOriginals(fresh);
});

test('real-page injected write failure and delayed recognition across synthetic session switch stay isolated', async () => {
  const h = harness({ project: generated.projectRoot }); h.load(join(generated.projectRoot, 'app.js'));
  const auth = h.load(join(generated.projectRoot, 'services/auth.js'));
  const api = h.load(join(generated.projectRoot, 'services/api.js'));
  await auth.loginWithWechat(); await auth.ensureLoggedIn();
  h.load(join(generated.projectRoot, 'pages/medicine-edit/medicine-edit.js'));
  const first = makePageContext(h.page); first.onLoad({}); await tick();
  h.app.qa.failNext('fs.writeFile'); await first.onRecognizePhoto('camera'); assert.equal(first.data.photoDrafts.length, 0);
  const operation = 'request POST /api/v1/recognitions/medicine'; h.app.qa.hold(operation);
  const pending = first.onRecognizePhoto('camera'); await tick();
  assert.equal(h.app.qa.summary().held[0].count, 1);
  api.clearToken(); h.app.qa.setActor('B'); await auth.loginWithWechat(); await auth.ensureLoggedIn();
  h.app.qa.release(operation); await pending;
  assert.equal(first.data.name, '');
  const second = makePageContext(h.page); second.onLoad({}); await tick(); assert.equal(second.data.photoDrafts.length, 0);
  assertNoOriginals(h);
});

test('same source/run yields identical generated hashes and full transform diff', async () => {
  const again = await prepareQa({ root, output: join(temp, 'repeat'), runId: 'self-test' });
  const first = JSON.parse(await readFile(generated.manifest, 'utf8'));
  const second = JSON.parse(await readFile(again.manifest, 'utf8'));
  assert.deepEqual(first.generatedHashes, second.generatedHashes);
  assert.equal(first.diffSha256, second.diffSha256);
  await assert.rejects(prepareQa({ root, output: join(temp, 'repeat'), runId: 'self-test' }), /already exists/);
});

test('real generated photo create/upload/cover/detail flow and synthetic cleanup work', async () => {
  const h = harness({ project: generated.projectRoot }); h.load(join(generated.projectRoot, 'app.js'));
  const auth = h.load(join(generated.projectRoot, 'services/auth.js'));
  const { api } = h.load(join(generated.projectRoot, 'services/api.js'));
  await auth.loginWithWechat(); await auth.ensureLoggedIn();
  h.load(join(generated.projectRoot, 'pages/medicine-edit/medicine-edit.js'));
  const edit = makePageContext(h.page); edit.onLoad({}); await tick(); await edit.onRecognizePhoto('camera');
  edit.setData({ usePhotoAsCover: true }); await edit.onSubmit();
  const medicines = (await api.listMedicines()).medicines;
  assert.equal(medicines.length, 2); assert.equal(medicines[1].coverPhotoId, 'qa-photo-1');
  assert.equal(edit.data.photoDrafts.length, 0);
  h.load(join(generated.projectRoot, 'pages/medicine-detail/medicine-detail.js'));
  const detail = makePageContext(h.page); detail.onLoad({ id: medicines[1].id }); await detail.refresh();
  assert.equal(detail.data.medicineSummary.id, medicines[1].id);
  assert.match(detail.data.coverPhotoPath, /^\/__qa_memory__\//);
  assertNoOriginals(h);
});

test('share entrypoints are removed and the native share menu is hidden; wrong download route stops', () => {
  const h = harness({ project: generated.projectRoot }); h.load(join(generated.projectRoot, 'app.js'));
  h.load(join(generated.projectRoot, 'pages/invite/invite.js'));
  assert.equal(h.page.onShareAppMessage, undefined);
  // Use a minimal page to avoid executing the invite network flow.
  const runtime = h.load(join(generated.projectRoot, 'qa/fixture-runtime.js'));
  runtime.bindings().Page({ data: {} }); const page = makePageContext(h.page); page.onShow();
  assert.ok(h.uiCalls.some(call => call.name === 'hideShareMenu'));
  assert.throws(() => runtime.bindings().wx.downloadFile({ url: 'http://127.0.0.1:43187/api/v1/auth/me' }), /download route denied/);
  assertNoOriginals(h);
});

test('missing inventory adapter and hook tampering never allow product continuation', () => {
  const missing = harness(); missing.config.wxInventory = ['futureUnsafeApi'];
  assert.throws(() => missing.install(), /missing inventory hook/); assert.throws(() => missing.runtime.bindings(), /bootstrap/); assertNoOriginals(missing);
  const h = harness(); h.install(); const wx = h.runtime.bindings().wx;
  assert.throws(() => { wx.request = h.native.request; }, /immutable/); assert.throws(() => h.runtime.bindings(), /QA STOPPED/); assertNoOriginals(h);
});

test('constructor and reflective ambient-global escape attempts are rejected before generation', () => {
  for (const source of [
    'wx.request.constructor("return this")().wx.request({})',
    'const f = wx.request["constructor"]; f("return this")()',
    'Object.getPrototypeOf(wx.request).constructor("return this")()',
    'Reflect.get(wx.request, "constructor")("return this")()',
    'wx.request.__proto__.constructor("return this")()',
  ]) assert.throws(() => inventorySource(source, 'escape.ts'), /escape|reflection|constructor/);
});

test('a dangling existing output symlink is rejected without creating its target', async context => {
  const target = join(temp, 'must-not-exist');
  const link = join(temp, 'dangling-output');
  try { await symlink(target, link); } catch (error) { if (error.code === 'EPERM') { context.skip('Host disallows symlink creation; covered on Linux'); return; } throw error; }
  await assert.rejects(prepareQa({ root, output: link, runId: 'symlink-test' }), /already exists/);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  await assert.rejects(lstat(target), { code: 'ENOENT' });
});

test('pure base64 adapter and ArrayBuffer byte ranges never touch originals', async () => {
  const h = harness(); h.install(); const wx = h.runtime.bindings().wx; const fs = wx.getFileSystemManager();
  assert.deepEqual([...new Uint8Array(wx.base64ToArrayBuffer('AAECAwQ='))], [0, 1, 2, 3, 4]);
  for (const bad of ['A', 'AB==', 'A===', 'AA==\n', '!!!!']) assert.throws(() => wx.base64ToArrayBuffer(bad), /base64/);
  const path = wx.env.USER_DATA_PATH + '/ranged.png'; const { fd } = await callback(done => fs.open({ filePath: path, flag: 'wx', ...done }));
  const result = await callback(done => fs.write({ fd, data: wx.base64ToArrayBuffer('AAECAwQ='), offset: 1, length: 3, position: 0, ...done }));
  assert.equal(result.bytesWritten, 3); assert.equal(fs.readFileSync(path, 'base64'), 'AQID');
  assert.throws(() => fs.unlinkSync(path), /closed before unlink/);
  await callback(done => fs.close({ fd, ...done })); assertNoOriginals(h);
});

test('reviewed helper fingerprint inventories parameter/lease managers and rejects injected options.fs/lease.fs entries', { skip: !integrationSha }, () => {
  const source = execFileSync('git', ['-C', root, 'show', integrationSha + ':apps/miniprogram/services/photo-file-lifecycle.ts']).toString();
  const found = inventorySource(source, 'services/photo-file-lifecycle.ts');
  assert.deepEqual(found.fs, ['close', 'open', 'unlink', 'write']);
  for (const injected of ['options.fs.rename({});', 'lease.fs.stat({});']) {
    assert.throws(() => inventorySource(source + '\n' + injected, 'services/photo-file-lifecycle.ts'), /unreviewed filesystem helper fingerprint/);
  }
});

async function integratedPage() {
  const h = harness({ project: integrated.projectRoot }); h.load(join(integrated.projectRoot, 'app.js'));
  const auth = h.load(join(integrated.projectRoot, 'services/auth.js'));
  await auth.loginWithWechat(); await auth.ensureLoggedIn();
  h.load(join(integrated.projectRoot, 'pages/medicine-edit/medicine-edit.js'));
  const page = makePageContext(h.page); page.onLoad({}); await tick();
  return { h, page, auth, apiModule: h.load(join(integrated.projectRoot, 'services/api.js')) };
}

test('integrated real-page writer persists reserved then ready, closes descriptor and saves synthetic photo', { skip: !integrationSha }, async () => {
  const { h, page, apiModule } = await integratedPage();
  h.app.qa.hold('fs.write'); const pending = page.onRecognizePhoto('camera'); await tick();
  assert.equal(h.app.qa.summary().held[0].count, 1);
  assert.equal(page.data.photoDrafts[0].photos[0].ownedLocal.state, 'reserved');
  assert.equal(h.app.qa.summary().openDescriptors.length, 1);
  h.app.qa.release('fs.write'); await pending;
  assert.equal(page.data.photoDrafts[0].photos[0].ownedLocal.state, 'ready');
  assert.equal(h.app.qa.summary().openDescriptors.length, 0);
  page.setData({ usePhotoAsCover: true }); await page.onSubmit();
  assert.equal((await apiModule.api.listMedicines()).medicines.length, 2);
  assert.equal(page.data.photoDrafts.length, 0); assertNoOriginals(h);
});

for (const mode of ['write-failure', 'partial-write', 'close-failure']) {
  test('integrated real-page ' + mode + ' preserves recovery record and later memory-only cleanup succeeds', { skip: !integrationSha }, async () => {
    const { h, page } = await integratedPage();
    if (mode === 'partial-write') h.app.qa.partialNextWrite(1);
    else h.app.qa.failNext(mode === 'write-failure' ? 'fs.write' : 'fs.close');
    await page.onRecognizePhoto('camera');
    assert.equal(page.data.photoDrafts.length, 1);
    assert.equal(page.data.photoDrafts[0].photos[0].ownedLocal.state, 'reserved');
    assert.equal(h.app.qa.summary().openDescriptors.length, mode === 'close-failure' ? 1 : 0);
    page.onDeletePhotoDraft({ currentTarget: { dataset: { id: page.data.photoDrafts[0].id } } });
    await tick(); await page.cleanupPhotoDrafts();
    assert.equal(page.data.photoDrafts.length, 0); assert.equal(h.app.qa.summary().openDescriptors.length, 0); assertNoOriginals(h);
  });
}

test('integrated late write across synthetic A/B switch cannot publish a ready photo into B', { skip: !integrationSha }, async () => {
  const { h, page, auth, apiModule } = await integratedPage();
  h.app.qa.hold('fs.write'); const pending = page.onRecognizePhoto('camera'); await tick();
  apiModule.clearToken(); h.app.qa.setActor('B'); await auth.loginWithWechat(); await auth.ensureLoggedIn();
  h.app.qa.release('fs.write'); await pending;
  const fresh = makePageContext(h.page); fresh.onLoad({}); await tick();
  assert.equal(fresh.data.photoDrafts.length, 0); assert.equal(fresh.data.name, ''); assertNoOriginals(h);
});

for (const phase of ['write', 'ocr-success', 'ocr-error']) {
  for (const lifecycle of ['hide', 'unload']) {
    test('revision2 generated page preserves later deletion after ' + lifecycle + ' / ' + phase, { skip: !integrationSha }, async () => {
      const { h, page } = await integratedPage();
      const op = phase === 'write' ? 'fs.write' : 'request POST /api/v1/recognitions/medicine';
      h.app.qa.hold(op);
      const pending = page.onRecognizePhoto('camera'); await tick();
      assert.equal(h.app.qa.summary().held.find(item => item.name === op).count, 1);
      if (lifecycle === 'hide') page.onHide(); else page.onUnload();
      const reopened = makePageContext(h.page); reopened.onLoad({}); await tick();
      const id = reopened.data.photoDrafts[0].id;
      const path = reopened.data.photoDrafts[0].photos[0].path;
      reopened.onDeletePhotoDraft({ currentTarget: { dataset: { id } } }); await tick();
      const runtime = h.load(join(integrated.projectRoot, 'qa/fixture-runtime.js'));
      const scope = h.load(join(integrated.projectRoot, 'services/session-scope.js'));
      const key = scope.scopedStorageKey('medicine-photo-drafts');
      const before = runtime.bindings().wx.getStorageSync(key);
      if (phase === 'write') assert.equal(before[0].status, 'cleanup_pending');
      else assert.equal(before.length, 0);
      if (phase === 'ocr-error') h.app.qa.failNext(op);
      h.app.qa.release(op); await pending; await tick();
      const after = runtime.bindings().wx.getStorageSync(key);
      if (phase === 'write') {
        assert.equal(after[0].status, 'cleanup_pending');
        await reopened.cleanupPhotoDrafts();
      }
      assert.equal(runtime.bindings().wx.getStorageSync(key).length, 0);
      assert.equal(h.app.qa.summary().syntheticFiles.includes(path), false);
      assert.equal(h.app.qa.summary().openDescriptors.length, 0);
      assertNoOriginals(h);
    });
  }
}

test('revision2 generated page rejects repeated capture on an incomplete reserved draft', { skip: !integrationSha }, async () => {
  const { h, page } = await integratedPage();
  h.app.qa.partialNextWrite(1); await page.onRecognizePhoto('camera');
  const first = h.app.qa.summary().syntheticFiles.slice().sort();
  const photo = page.data.photoDrafts[0].photos[0];
  await page.onRecognizePhoto('album');
  assert.equal(page.data.photoDrafts[0].photos.length, 1);
  assert.equal(page.data.photoDrafts[0].photos[0].path, photo.path);
  assert.deepEqual(h.app.qa.summary().syntheticFiles.slice().sort(), first);
  assertNoOriginals(h);
});

for (const phase of ['write', 'ocr']) {
  test('revision3 generated page preserves newer fields through passive reentry after ' + phase, { skip: !integrationSha }, async () => {
    const { h, page } = await integratedPage();
    const op = phase === 'write' ? 'fs.write' : 'request POST /api/v1/recognitions/medicine';
    h.app.qa.hold(op);
    const pending = page.onRecognizePhoto('camera'); await tick();
    const runtime = h.load(join(integrated.projectRoot, 'qa/fixture-runtime.js'));
    const scope = h.load(join(integrated.projectRoot, 'services/session-scope.js'));
    const wx = runtime.bindings().wx;
    const key = scope.scopedStorageKey('medicine-photo-drafts');
    const queue = wx.getStorageSync(key); queue[0].fields.name = 'Later synthetic edit'; wx.setStorageSync(key, queue);
    h.app.qa.release(op); await pending; await tick();
    page.onShow(); await tick();
    page.onSelectPhotoDraft({ currentTarget: { dataset: { id: page.data.activePhotoDraftId } } });
    page.onFieldInput({ currentTarget: { dataset: { field: 'manufacturer' } }, detail: { value: 'Current manufacturer' } });
    assert.equal(wx.getStorageSync(key)[0].fields.name, 'Later synthetic edit');
    assertNoOriginals(h);
  });
}

for (const failed of [false, true]) {
  test('revision3 generated cleanup retains a later new draft after ' + (failed ? 'failed' : 'successful') + ' unlink', { skip: !integrationSha }, async () => {
    const { h, page } = await integratedPage();
    await page.onRecognizePhoto('camera');
    h.app.qa.hold('fs.unlink');
    const id = page.data.photoDrafts[0].id;
    page.onDeletePhotoDraft({ currentTarget: { dataset: { id } } }); await tick();
    const runtime = h.load(join(integrated.projectRoot, 'qa/fixture-runtime.js'));
    const scope = h.load(join(integrated.projectRoot, 'services/session-scope.js'));
    const wx = runtime.bindings().wx;
    const key = scope.scopedStorageKey('medicine-photo-drafts');
    const queue = wx.getStorageSync(key);
    queue.push({ id: 'photo-999-later', status: 'review', fields: { name: 'Later synthetic draft' }, medicineId: '', photos: [] });
    wx.setStorageSync(key, queue);
    if (failed) h.app.qa.failNext('fs.unlink');
    h.app.qa.release('fs.unlink'); await tick();
    const after = wx.getStorageSync(key);
    assert.equal(after.find(item => item.id === 'photo-999-later')?.fields.name, 'Later synthetic draft');
    assert.equal(after.some(item => item.id === id), failed);
    assertNoOriginals(h);
  });
}


test('revision5 ordinary input retains a newer durable photo ownership receipt', { skip: !integrationSha }, async () => {
  const { h, page } = await integratedPage();
  await page.onRecognizePhoto('camera');
  const firstId = page.data.activePhotoDraftId;
  const runtime = h.load(join(integrated.projectRoot, 'qa/fixture-runtime.js'));
  const scope = h.load(join(integrated.projectRoot, 'services/session-scope.js'));
  const wx = runtime.bindings().wx;
  const key = scope.scopedStorageKey('medicine-photo-drafts');

  // A second page can no longer start another unfinished medicine draft. Model only
  // the durable concurrency fact this regression protects: a newer photo receipt
  // appears in storage after this page's form baseline was captured.
  const selection = await wx.chooseMedia({});
  const newerPath = selection.tempFiles[0].tempFilePath;
  const durable = wx.getStorageSync(key);
  const target = durable.find(item => item.id === firstId);
  target.photos.push({
    path: newerPath,
    mimeType: 'image/png',
    purpose: 'box_front',
    batchIndex: 0,
    ownedLocal: { path: newerPath, scopeKey: key, draftId: firstId, state: 'ready' },
  });
  wx.setStorageSync(key, durable);

  page.onFieldInput({ currentTarget: { dataset: { field: 'manufacturer' } }, detail: { value: 'Current manufacturer' } });
  const queue = wx.getStorageSync(key);
  const merged = queue.find(item => item.id === firstId);
  assert.equal(queue.length, 1);
  assert.equal(merged.fields.manufacturer, 'Current manufacturer');
  assert.equal(merged.photos.some(photo => photo.ownedLocal?.path === newerPath), true);
  assert.equal(h.app.qa.summary().syntheticFiles.includes(newerPath), true);
  assertNoOriginals(h);
});
