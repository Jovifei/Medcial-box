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
  // 2026-10-11 review: session headers, invite priority and document-flow footer; no added wx/fs APIs.
  '5c4b56c62c50c46f2bd9a02d7804ad36cfc8ecab',
  // Follow-up review: footer chooser saves drafts, batch form persists original family/route; capabilities unchanged.
  '387487e70af66a8203a91c5225d1701dd4a5c820',
  // Reviewed correction: family chooser uses existing guarded wx.navigateTo, no navigator view capability.
  '9c916f1557d640103c9154d66d3feb2b5302f2fe',
  // Reviewed invite code/identity binding before confirm and delayed home navigation; existing capability set only.
  '9a643c3aa1cd3b1fbd6a90dfb4ae46e396c166cd',
  // Test-only Node timer import; production subtree capabilities unchanged from the preceding reviewed tree.
  '90256d2471613e19bbf9607f69491079788f0349',
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
  // AUD06 lease/ownership audit: no added native APIs or filesystem operations.
  '8efdcc18a60ab592b0a4b3345b25be34ec6d92ef',
  // Same reviewed business implementation; synthetic AUD06 test fixture additions only.
  'e2e9acec0a1ec9e36921397f2c57fb986870846d',
  // AUD06 fallback clipboard lease, reviewed with its exact synthetic scenario fixture.
  'c78f12661af44c8c2cf58a9d07e6e144fce33f1a',
  // AUD06 independently reviewed scoped-only recovery reporting; no new wx/fs/component capabilities.
  'f625aa0f3445b686a5a9a434a30649c020723bbe',
  // Reviewed failed native write and onUnload coverage (test-only delta, no new native permissions).
  'fd8a8b5cd94fc2ba2ae1f401f2c206641cbfccbd',
  // Pure test assertion change for cross-VM result shape, all runtime capabilities unchanged.
  '2924595aa226c2f809fff54498bfa22afcf7cb36',
  // Scoped receipt rebase and two independent synthetic concurrency cases, same native capability set.
  'e368588172f65e9e07cde1bba6ef2d09abe44b0e',
  // 2026-10-13 independent review: fixed footer, explicit purpose review, owned failed-photo retake.
  // No new wx/fs/native network/component kinds; read-only getCurrentPages reads route only.
  'c4a34d6bcd0d63796cd1e4da10fb75d2d245d60a',
  // 2026-10-14 independent review: explicit route/tab-stack highlight, readable equal-width footer.
  // Same read-only getCurrentPages and unchanged wx/fs/component/photo lifecycle capabilities.
  '47da77d6837a751426aa81cbf29b77646c2f2896',
  // 2026-10-14 independent review: retained retake photos, explicit latest acknowledged cover.
  // No new wx/fs/network/component capabilities; durable ownership helper unchanged.
  'a8e2fff68da6dc96d2d39a9e8dfdc46c38f9d6b5',
  // 2026-10-15 independent review: blank entry, explicit import, total cap, scan and fixed failure categories.
  // Same wx/fs/network/component capabilities; owned photo lifecycle helper unchanged.
  '45e9cc2880ecc4fc9ed28d1774c256aab77a9824',
  // 2026-10-15 independent review: draft-import confirmation rechecks captured scope and session, including ABA.
  // Existing identity helpers only; native/filesystem/component capability sets unchanged.
  'de0efda35f23cc746e45b44c3e2d8f6e19597b9e',
  // 2026-10-16 independent review: capture failure stages and code-type labels, version1.0.6.
  // No additional wx/fs/network/component capabilities; ownership helper unchanged.
  'd5d021680cfb578fbc5767bf662b78db1dc9becc',
  // 2026-10-16 follow-up review: barcode generations fence all callbacks and finalizers.
  // No new native/network/filesystem capabilities; owned-photo helper unchanged.
  '58fdcfd939f6fc65ac1e7e21e0ca617333179fd8',
  // 2026-10-23 reviewed: GS1-only barcode extraction, bounded photo compression and file-size check.
  // New wx.compressImage/getFileInfo remain in the synthetic-only QA facade; no new transport route.
  'a593a6064cda05dd2db4d2eb43b7071c5e80e665',
  // 2026-10-25 reviewed: scan-candidate purpose-tag chips backfill (setData only) and family-entry copy fix.
  // Type-only candidate field plus synthetic test; no new wx/fs/network/component capabilities.
  '4562490777bd433fc1a6d692b28f07a311c52378',
  // 2026-10-25 follow-up: release-notes text and version bump only; capability set unchanged from 4562490777.
  '4b8fcfedabe7eff48405e11995f58aafd342e64d',
  // 2026-10-25 follow-up: release notes converged to three items; capability set unchanged.
  '7ee9bd445a3d5bb6cb611660afeab965c481def6',
  // 2026-10-25 friend-feedback batch: draft retirement on save, leading-GTIN extraction, unit prefill,
  // antiinfective tag, larger entry buttons; no new wx/fs/network/component capabilities.
  '8d3eb7958dc17e1eb210d6672c4337b8aad5a20d',
  // 2026-10-25 follow-up: miniprogram PurposeTag union copy gains antiinfective; capabilities unchanged.
  '7a468c9c7b2480e96d2863347472f5bb04acd69c',
  // 2026-10-25 family-entry redesign (58号设计B): list-first chooser with progressive create/join
  // disclosure; page-local addExpanded only, no new wx/fs/network/component capabilities.
  '8a9555c3d1c3a71ec6693633218f3057a1f80010',
  // 2026-10-25 follow-up: collapse blocked while invite activity pending (design rule 58); UI state only.
  '51b0e81f74d0be6a138137c4609b65ba49270555',
  // 2026-10-25 review fixes: ml keyword unit prefill and spec-gated consistency; UI state only.
  '11d85bfaed8c1b165148224a345051009131ab5d',
  // 2026-10-25 build 10 独立复审：人工用途标签编辑/清空随各自草稿保存，
  // 候选只填未编辑空值并限制有效标签；版本说明及合成回归同步。
  // 42 个生产 TS 文件的 wx/fs 库存重新核验，无新增原生、网络或文件能力。
  '725552a38592eb20da30d41458c9c192792b0ddd',
  // 2026-10-23 review: invalid GS1 expiry fails closed and remains visible after scan/retry.
  '51f87be926b11be406b0fb922fe3ac706d35d82a',
  // 2026-10-23 本轮独立逐页审阅：login restore/主动登录代次；首页/详情/待处理/
  // 补货/盘点晚到响应；照片草稿重试；邀请、退出及备份回执；均复用既有
  // wx/文件系统/网络白名单，没有增加原生能力或改变合成沙盒边界。
  // 精确源树（包含本轮合成竞态测试）须与固定候选提交一一对应；
  // 任何后续小程序源码变更都仍将被 fail-closed 拒绝，需重新审核。
  '5a9cc031be9d57bf4058097c0ed037404a9277ba',
  // 2026-10-23 新增专属草稿 scope 及跨家庭身份切换合成断言，
  // 小程序生产模块未再变更；仅测试目录差异且权限库存保持不变。
  '16495a4c514f269598e3d6b2bebb63bf9bd91fc6',
  // 2026-10-23 independent source review: family identity changes synchronously clear
  // prior household display snapshots; detail projections, stale async completions,
  // stocktake/restock write guards, and new synthetic tests use only existing APIs.
  // This review does not grant new wx/fs/network capabilities or relax fail-closed QA.
  '49511b6acdf3175ad50c4207c1232ca3abc9e24d',
  // 2026-10-23 continuation review: own 401/scope resolution is separated from stale
  // foreign responses; backup preview/confirmation retains its original owner and
  // stocktake post-refresh status is fenced. No new wx/fs/network capabilities.
  // Independently exercised by scripts/resume-boundaries.test.mjs; other trees denied.
  'e646e48709fab7535f74747868c123a23fc6b1eb',
  // 2026-10-23 follow-up: same-identity strict read-only checks share one owned
  // invalidation receipt; interactive login remains separate. Native capabilities
  // unchanged; scripts/session-check-coalescing.test.mjs covers overlap and release.
  '3ba9bb68954e82ba2b3f713fe93a082d7e4f974d',
  // Same reviewed behavior; Promise handle is const with explicit type for lint.
  'd33fd365f61743aefcbfbcb305d8e7c930a6b02d',
  // 2026-10-24 逐页审阅本阶段正式源码树：
  // 登录范围变更先清本地投影、backup 本次 401 清 busy、照片草稿批次回执；
  // 仅沿用已审 wx/request/filesystem 能力，未增加外部运行时或权限。
  // 列表中只有精确此树可运行合成 QA；后续源码更改必须重新核实树。
  '5705e1ce090bbf9546cd25639cc49e7a1a618893',
  // 2026-10-24 二次源树核验：仅补充 MedicationSummary 写回执静态类型，
  // 产品模块 API/权限调用没有增量；QA 仍绑定精确 SHA。
  'c9f090f9df9f73c07c778b3fcfecbcb6c4dd9c22',
  // 2026-10-24 独立复审：备份入口/收尾按原操作清屏，家庭设置绑定
  // 已显示身份，18 项真实 transport/auth 合成回归覆盖无 onShow 的切家。
  // 只复用既有 wx/fs 能力；精确树已核验，其他未审树仍 fail closed。
  '1214bcbfd220684835bf46fa4667d2bd74379ba0',
  // 2026-10-26 UI 重构整改复审：
  // 1. 修复 R01：medicine-detail 同步清空 brandText/manufacturerText/leafletUsage/leafletPurpose
  // 2. 修复 R02：首页待核对卡片去重统计并与 pending 筛选集合对齐，避免盒数硬编码
  // 3. 修复 R05：消除品牌厂家及说明书摘要多重重复展示，核验状态动态化
  // 4. 修复 R11：调试日志 5 连击后门移至版本说明页静态版本号，不干扰普通菜单点击
  // 原生能力新增 wx.setEnableDebug（用于默认关闭移动端 vConsole，需 5 击激活）。
  'faaafb3e50a7a8c953015e2cd9024c77d7a88ead',
  // 2026-10-27 双端大修：46 个生产 TS 源文件与组件声明通过静态能力清点；
  // 仅新增已审的 pageScrollTo 视图滚动钩子，照片文件生命周期指纹不变。
  // 来源同步、身份失效和草稿恢复经独立复审与合成测试；仅信任此精确树。
  'df7fdd26a7860fb664f0a7e54dfb256010912d75',
  // 2026-10-27 候选 1.1.1：识别来源 QA mock、录入低频区收口、首页状态筛选
  // 渐进展开和保存后照片草稿视图回读；沿用已审 wx/fs/network 能力集合。
  '53e030a9247e79399416f2ef0ea3f10dba201a91',
  // 2026-10-27 候选 1.1.1 版本说明收口：小程序版本说明保持最多三项。
  'c35059b7a9d0f25ab4f017b43418727887eda084',
]);
const reviewedComponents = new Map([
  ['business-nav', 'components/business-nav/business-nav'],
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
const reviewedWx = new Set(['base64ToArrayBuffer', 'chooseMedia', 'compressImage', 'chooseMessageFile', 'disableAlertBeforeUnload', 'downloadFile',
  'enableAlertBeforeUnload', 'env', 'getFileSystemManager', 'getMenuButtonBoundingClientRect', 'getStorageSync',
  'getFileInfo', 'getSystemInfoSync', 'getUpdateManager', 'login', 'navigateBack', 'navigateTo', 'pageScrollTo', 'previewImage', 'reLaunch',
  'redirectTo', 'removeStorageSync', 'request', 'requestSubscribeMessage', 'scanCode', 'setClipboardData',
  'setEnableDebug',
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
