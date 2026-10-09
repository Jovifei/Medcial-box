// Disposable simulator-only QA build from a committed tree. Production files stay untouched.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const workspace = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_SOURCE_SHA = '9de6d99137262e21142025a941094b7764209228';
// Trusted frozen-source instrumentation, NOT an arbitrary/malicious JavaScript sandbox.
// Accept only the independently reviewed baseline tree or the exact frozen writer-patch tree.
const reviewedSourceTrees = new Set([
  '3ed0f8e6e410daf7fce1277d0e363caa52be3214',
  'abdef7419cb4abf00c54112456897ae05ebcbaba',
  '7a37461f3b3e3245151a91f3e02e8151d6c849e0',
  '664ac37a336930d277ffcdb99baea9e0d5e17ef2',
  '8ad38a705d6cbdbc7ffd4dbad9b32a83e081adc5',
  'bc5bc86d76e9f2be34ce2b793d6e2294337a5e8a',
  '17dbc684f86008de4e387b40a36097606907d9ef',
  // Reviewed 2026-10-09: scoped export/photo intent, session fences, accurate disclosure; no new wx/fs permissions.
  '660359aed38af8285229dc106a58f69095d4e12e',
  // Additional review: plan draft owner captured before asynchronous page load, unchanged wx/fs capabilities.
  '9992a7cbdb802344f496790fb0f1a6177b98ad9c',
  // Final review: backup onShow avoids unlink while sharing; no new native capability.
  '92a89f61d2ef1b06eb4e7760b60c3b436538b246',
  // Reviewed 2026-10-09: durable photo ACK recovery plus updated synthetic page tests; no new native APIs.
  'bbdd1af3d8285f897ebc15ef2bec221a251028ad',
  // Reviewed synthetic regression fixtures now carry durable photo receipts; capability set unchanged.
  '77c5ddde4c710709322cfdc73ef9f5095ef40cb8',
  // 2026-10-09: native wx.request uses SDK-supported POST; no new wx/fs/component capabilities.
  'f376be5f9502caffe5d7e83bb039941a2069169e',
]);
const reviewedComponents = new Map([
  ['medicine-date-field', 'components/medicine-date-field/index'],
  ['medicine-time-field', 'components/medicine-time-field/index'],
]);
const reviewedComponentSources = new Set([...reviewedComponents.values()].map(value => value + '.ts'));

export function assertReviewedComponents(filename, usingComponents) {
  if (usingComponents === undefined) return;
  if (usingComponents === null || typeof usingComponents !== 'object' || Array.isArray(usingComponents)) {
    throw new Error(filename + ': usingComponents must be an object');
  }
  for (const [tag, target] of Object.entries(usingComponents)) {
    const expected = reviewedComponents.get(tag);
    const resolved = typeof target === 'string'
      ? posix.normalize(posix.join(posix.dirname(filename), target))
      : '';
    if (!expected || resolved !== expected || target.includes('://')) {
      throw new Error(filename + ': unreviewed component ' + tag);
    }
  }
}
// This list is deliberately reviewed rather than inferred from source. A new capability
// requires an explicit adapter change and new tests. The owned-photo integration adapter
// explicitly covers base64ToArrayBuffer plus ArrayBuffer open/write/close semantics.
const reviewedWx = new Set(['base64ToArrayBuffer', 'chooseMedia', 'chooseMessageFile', 'disableAlertBeforeUnload', 'downloadFile',
  'enableAlertBeforeUnload', 'env', 'getFileSystemManager', 'getMenuButtonBoundingClientRect', 'getStorageSync',
  'getSystemInfoSync', 'getUpdateManager', 'login', 'navigateBack', 'navigateTo', 'previewImage', 'reLaunch',
  'redirectTo', 'removeStorageSync', 'request', 'requestSubscribeMessage', 'scanCode', 'setClipboardData',
  'setStorageSync', 'shareFileMessage', 'showActionSheet', 'showModal', 'showToast', 'stopPullDownRefresh', 'switchTab']);
const reviewedFs = new Set(['readFile', 'writeFile', 'unlink', 'open', 'write', 'close']);
const excluded = /(^|\/)(test|typings|node_modules|dist|compiled)(\/|$)|(^|\/)(package|tsconfig|project\.private\.config|private\.config)\.json$|(^|\/)\.|\.map$/;
const unwrap = node => {
  while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
  return node;
};
export function assertReviewedInventory(apis, name) {
  for (const entry of apis.wx) if (!reviewedWx.has(entry)) throw new Error(name + ': unreviewed wx API ' + entry);
  for (const entry of apis.fs) if (!reviewedFs.has(entry)) throw new Error(name + ': unreviewed filesystem API ' + entry);
}
export const REVIEWED_PHOTO_LIFECYCLE_SHA256 = '8ff79310b1474d1ac459f08ca6b5d0118c4e61fb786339a8e8d8a0c198bbb3ab';
export function inventorySource(source, filename) {
  // The writer receives its manager via destructured options and lease.fs. Those
  // paths require explicit provenance, not inference from wx.getFileSystemManager.
  const reviewedFsHelper = filename === 'services/photo-file-lifecycle.ts';
  const reviewedComponentSource = reviewedComponentSources.has(filename);
  if (reviewedFsHelper && sha256(source) !== REVIEWED_PHOTO_LIFECYCLE_SHA256) throw new Error(filename + ': unreviewed filesystem helper fingerprint');
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const wxAliases = new Set(['wx']);
  const fsAliases = new Set(reviewedFsHelper ? ['fs'] : []);
  const wxApis = new Set();
  const fsApis = new Set();
  const nodes = [];
  const visit = node => { nodes.push(node); ts.forEachChild(node, visit); };
  visit(tree);
  const isWx = raw => { const node = unwrap(raw); return node && ts.isIdentifier(node) && wxAliases.has(node.text); };
  const isFs = raw => {
    const node = unwrap(raw);
    return node && ((reviewedFsHelper && ts.isPropertyAccessExpression(node) && node.name.text === 'fs') || (ts.isIdentifier(node) && fsAliases.has(node.text)) || (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && isWx(node.expression.expression) && node.expression.name.text === 'getFileSystemManager'));
  };
  // Fixed point covers aliases through casts or alias chains, without guessing names.
  for (let pass = 0; pass < nodes.length; pass++) {
    const count = wxAliases.size + fsAliases.size;
    for (const node of nodes) if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isWx(node.initializer)) wxAliases.add(node.name.text);
      if (isFs(node.initializer)) fsAliases.add(node.name.text);
    }
    if (count === wxAliases.size + fsAliases.size) break;
  }
  for (const node of nodes) {
    if (ts.isIdentifier(node) && ['globalThis', 'global', 'window', 'self', 'eval', 'Function', 'require', 'Component', 'Behavior', 'Worker', 'requirePlugin', 'importScripts', 'fetch', 'WebSocket', 'XMLHttpRequest', 'navigator', 'Reflect'].includes(node.text) &&
        !(node.text === 'Component' && reviewedComponentSource)) {
      throw new Error(filename + ': forbidden ambient escape ' + node.text);
    }
    if (ts.isElementAccessExpression(node) && (isWx(node.expression) || isFs(node.expression))) throw new Error(filename + ': dynamic wx/filesystem access needs review');
    if ((ts.isPropertyAccessExpression(node) && ['constructor', '__proto__', 'getPrototypeOf', 'setPrototypeOf', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'defineProperty', 'defineProperties'].includes(node.name.text)) ||
        (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && ['constructor', '__proto__'].includes(node.argumentExpression.text))) throw new Error(filename + ': reflection/constructor access needs review');
    if (ts.isPropertyAccessExpression(node)) {
      if (isWx(node.expression)) wxApis.add(node.name.text);
      if (isFs(node.expression)) fsApis.add(node.name.text);
    }
  }
  return { wx: [...wxApis].sort(), fs: [...fsApis].sort(), ...(reviewedFsHelper ? { reviewedFsSha256: REVIEWED_PHOTO_LIFECYCLE_SHA256 } : {}) };
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function listFiles(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await listFiles(root, name + '/'));
    else result.push(name);
  }
  return result.sort();
}
export async function prepareQa({ root = workspace, sourceSha = DEFAULT_SOURCE_SHA, output, runId = 'qa-isolated' } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('Use an exact committed 40-hex source SHA');
  if (!/^[a-z0-9-]{1,48}$/.test(runId)) throw new Error('run-id must contain 1–48 lowercase ASCII letters/digits/hyphens');
  const git = args => execFileSync('git', ['-C', root, ...args]);
  if (git(['rev-parse', sourceSha + '^{commit}']).toString().trim() !== sourceSha) throw new Error('Source SHA mismatch');
  const sourceTree = git(['rev-parse', sourceSha + ':apps/miniprogram']).toString().trim();
  if (!reviewedSourceTrees.has(sourceTree)) throw new Error('Unreviewed mini-program source tree: ' + sourceTree);
  const outputRoot = resolve(output ?? join(root, '.local-data', 'qa-' + runId));
  // Refuse existing destinations, including symlinks. No overwrite/delete operation is used.
  try { await lstat(outputRoot); throw new Error('Output already exists; choose a fresh disposable directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const projectRoot = join(outputRoot, 'project');
  const sourceFiles = git(['ls-tree', '-r', '--name-only', sourceSha, '--', 'apps/miniprogram']).toString().trim().split('\n')
    .filter(name => !excluded.test(name.slice('apps/miniprogram/'.length)));
  const originals = new Map();
  const generated = new Map();
  const inventory = [];
  for (const gitPath of sourceFiles) {
    const name = gitPath.slice('apps/miniprogram/'.length);
    const mode = git(['ls-tree', sourceSha, '--', gitPath]).toString().split(' ')[0];
    if (mode !== '100644' && mode !== '100755') throw new Error('Unsupported source entry: ' + name);
    const bytes = git(['show', sourceSha + ':' + gitPath]);
    originals.set(name, bytes);
    if (name.endsWith('.ts')) {
      const source = bytes.toString();
      const apis = inventorySource(source, name);
      assertReviewedInventory(apis, name);
      inventory.push({ file: name, ...apis });
      const target = name === 'app.ts' ? 'app-product.js' : name.replace(/\.ts$/, '.js');
      const guardPath = relative(dirname(target), 'qa/fixture-runtime').replaceAll('\\', '/');
      const compiled = ts.transpileModule(source, { fileName: name,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
      // No hoisted ES import: this lexical facade is evaluated before every product dependency require.
      generated.set(target, `// MEDICINE_QA_ONLY\nconst { wx, App, Page, Component, setTimeout } = require(${JSON.stringify(guardPath.startsWith('.') ? guardPath : './' + guardPath)}).bindings();\n` + compiled);
    } else if (name.endsWith('.wxml')) {
      let text = bytes.toString();
      const tags = [...text.matchAll(/<([a-z][a-z0-9-]*)\b/g)].map(match => match[1]);
      if (tags.some(tag => !['block', 'button', 'image', 'input', 'picker', 'switch', 'text', 'textarea', 'view', ...reviewedComponents.keys()].includes(tag))) throw new Error('Unreviewed view tag: ' + name);
      text = text.replace(/open-type=["']share["']/g, 'disabled="true"');
      if (/<(?:web-view|camera|video|audio|live-player|live-pusher|map|ad|wxs|import|include)\b|open-type\s*=|https?:|wss?:/i.test(text)) throw new Error('Unreviewed view-layer capability: ' + name);
      text = text.replace(/(<image\b[^>]*\bsrc=)(["'])(.*?)\2/g, '$1"/qa/synthetic.png"');
      generated.set(name, '<view class="qa-only-banner">QA 合成内存沙盒 · 不上传/不发布 · 重编译即清空</view>\n' + text);
    } else if (name.endsWith('.wxss')) {
      if (/url\s*\(/i.test(bytes.toString())) throw new Error('Unreviewed style resource URL: ' + name);
      generated.set(name, bytes);
    } else if (['.json', '.png', '.jpg', '.jpeg'].includes(extname(name))) generated.set(name, bytes);
    else throw new Error('Unknown source entry type: ' + name);
  }
  const app = JSON.parse(originals.get('app.json'));
  const project = JSON.parse(originals.get('project.config.json'));
  if (app.plugins || app.subpackages || app.subPackages || app.workers || app.extAppid) throw new Error('Unreviewed app execution entry');
  for (const [name, bytes] of originals) if (name.endsWith('.json') && name !== 'project.config.json') {
    const value = JSON.parse(bytes);
    if (value.plugins) throw new Error('Unreviewed plugin dependency: ' + name);
    if (value.component === true && !reviewedComponentSources.has(name.replace(/\.json$/, '.ts'))) {
      throw new Error('Unreviewed component declaration: ' + name);
    }
    assertReviewedComponents(name, value.usingComponents);
  }
  project.appid = 'touristappid';
  project.projectname = 'QA-ONLY-SYNTHETIC-' + runId;
  project.description = 'Disposable in-memory QA. Never upload, publish or use real data.';
  project.setting = { ...project.setting, useCompilerPlugins: [], compileHotReLoad: false, urlCheck: true };
  app.window.navigationBarTitleText = 'QA 合成内存沙盒';
  const config = {
    buildMark: 'MEDICINE_QA_ONLY', appId: 'touristappid', sourceSha, sourceTree, runId, pages: app.pages,
    wxInventory: [...new Set(inventory.flatMap(item => item.wx))].sort(),
    fsInventory: [...new Set(inventory.flatMap(item => item.fs))].sort(),
    transport: 'in-process synthetic dispatch; ZERO native network',
    viewTransforms: ['Every image src uses bundled qa/synthetic.png (synthetic rendering only)',
      'Share buttons disabled; Page share handlers removed and share menu hidden', 'Persistent red QA banner on every page'],
  };
  generated.set('project.config.json', JSON.stringify(project, null, 2) + '\n');
  generated.set('app.json', JSON.stringify(app, null, 2) + '\n');
  generated.set('app.wxss', generated.get('app.wxss').toString() + '\n.qa-only-banner{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#9b001c;color:white;font-size:22rpx;font-weight:bold;padding:10rpx;text-align:center;pointer-events:none;}\n');
  generated.set('services/config.js', '// MEDICINE_QA_ONLY\nconst { wx, App, Page, Component, setTimeout } = require("../qa/fixture-runtime").bindings();\nexports.API_BASE = "http://127.0.0.1:43187";\n');
  generated.set('qa/config.json', JSON.stringify(config, null, 2) + '\n');
  for (const name of ['fixture-runtime', 'synthetic-mock']) generated.set('qa/' + name + '.js', await readFile(join(workspace, 'scripts/qa', name + '.cjs')));
  const mock = await import('./qa/synthetic-mock.cjs');
  generated.set('qa/synthetic.png', Buffer.from(mock.default.PNG, 'base64'));
  generated.set('app.js', '// MEDICINE_QA_ONLY. Deliberately CommonJS: NO product/dependency import before install.\nconst qa = require("./qa/fixture-runtime");\nqa.install(wx, require("./qa/config.json"), App, Page, Component);\nrequire("./app-product");\n');
  generated.set('QA-DO-NOT-UPLOAD.json', JSON.stringify({ ...config, warning: 'Memory-only. Reload/reentry is NOT persistent-storage or cross-WeChat-restart evidence.' }, null, 2) + '\n');
  // Validate emitted dependency graph, including transpiler output, before writing anything.
  for (const [name, bytes] of generated) if (name.endsWith('.js') && !name.startsWith('qa/')) {
    for (const match of bytes.toString().matchAll(/require\(["']([^"']+)["']\)/g)) {
      const target = relative('.', join(dirname(name), match[1])).replaceAll('\\', '/');
      if (!match[1].startsWith('.') || ![target, target + '.js', target + '.json'].some(key => generated.has(key))) throw new Error('Unreviewed runtime dependency: ' + name + ' => ' + match[1]);
    }
  }
  await mkdir(dirname(outputRoot), { recursive: true });
  // Exclusive reservation also closes the preflight-to-write race, including dangling symlinks.
  await mkdir(outputRoot);
  await mkdir(projectRoot);
  for (const [name, bytes] of generated) { await mkdir(dirname(join(projectRoot, name)), { recursive: true }); await writeFile(join(projectRoot, name), bytes); }
  // A complete textual transform diff, with baseline files in a NON-importable review folder.
  const reviewRoot = join(outputRoot, 'review-source');
  for (const [name, bytes] of originals) {
    // Deliberately rename the baseline project config so this folder cannot be imported as a production-bound project.
    const safeName = name === 'project.config.json' ? 'project.config.json.REVIEW-ONLY' : name;
    await mkdir(dirname(join(reviewRoot, safeName)), { recursive: true }); await writeFile(join(reviewRoot, safeName), bytes);
  }
  let diff;
  try { diff = execFileSync('git', ['diff', '--no-index', '--binary', '--', 'review-source', 'project'], { cwd: outputRoot, maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { if (error.status !== 1) throw error; diff = error.stdout; }
  await writeFile(join(outputRoot, 'generated.diff'), diff);
  const hashes = {};
  for (const name of await listFiles(projectRoot)) hashes[name] = sha256(await readFile(join(projectRoot, name)));
  const manifest = { ...config, inventory, sourceHashes: Object.fromEntries([...originals].map(([name, bytes]) => [name, sha256(bytes)])), generatedHashes: hashes, diffSha256: sha256(diff) };
  await writeFile(join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { projectRoot, sourceSha, manifest: join(outputRoot, 'manifest.json'), diff: join(outputRoot, 'generated.diff'), files: generated.size };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  try { console.info(JSON.stringify(await prepareQa({ sourceSha: value('--source-sha'), output: value('--output'), runId: value('--run-id') }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
