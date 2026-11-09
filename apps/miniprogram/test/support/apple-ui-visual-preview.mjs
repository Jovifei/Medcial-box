/* global document */
/**
 * Read the current WXML/WXSS and render synthetic page state in Chromium.
 * This is NOT the WeChat renderer and never calls a real API, wx storage or camera.
 * Optional local tool: requires Playwright + Chromium; not part of npm test.
 * Usage: node apps/miniprogram/test/support/apple-ui-visual-preview.mjs OUTPUT_DIRECTORY
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { loadPage, makePageContext } from '../runtime.mjs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] ?? '.local-data/apple-ui-visual');
await mkdir(output, { recursive: true });
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const expr = (value, data) => vm.runInNewContext(`(${value})`, data, { timeout: 100 });
const fill = (value, data) => value.replace(/{{([\s\S]*?)}}/g, (_, expression) => escape(expr(expression, data)));
const valueOf = (value, data) => expr(value.replace(/^{{|}}$/g, ''), data);

function parse(source) {
  const tree = { tag: 'block', attrs: {}, children: [] };
  const stack = [tree];
  for (const token of source.matchAll(/<!--[\s\S]*?-->|<\/?[\w-]+(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g)) {
    const text = token[0];
    if (text.startsWith('<!--')) continue;
    if (text.startsWith('</')) { stack.pop(); continue; }
    if (!text.startsWith('<')) { stack.at(-1).children.push(text); continue; }
    const tag = /^<([\w-]+)/.exec(text)[1];
    const attrs = {};
    for (const a of text.slice(tag.length + 1).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) attrs[a[1]] = a[2] ?? a[3] ?? '';
    const node = { tag, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!text.endsWith('/>') && tag !== 'input' && tag !== 'image') stack.push(node);
  }
  return tree;
}

function renderChildren(nodes, data) {
  let chainMatched = false;
  let inChain = false;
  return nodes.map(node => {
    if (typeof node === 'string') return fill(node, data);
    const a = node.attrs;
    if ('wx:if' in a) {
      inChain = true;
      chainMatched = Boolean(valueOf(a['wx:if'], data));
      if (!chainMatched) return '';
    } else if ('wx:elif' in a || 'wx:else' in a) {
      if (!inChain || chainMatched) return '';
      chainMatched = 'wx:else' in a || Boolean(valueOf(a['wx:elif'], data));
      if (!chainMatched) return '';
    } else { inChain = false; chainMatched = false; }
    return renderNode(node, data);
  }).join('');
}

function renderNode(node, data, iteration = false) {
  const a = node.attrs;
  if (!iteration && 'wx:for' in a) {
    return valueOf(a['wx:for'], data).map((item, index) => renderNode(node, { ...data, [a['wx:for-item'] || 'item']: item, [a['wx:for-index'] || 'index']: index }, true)).join('');
  }
  if (node.tag === 'block') return renderChildren(node.children, data);
  if (node.tag === 'business-nav') return '';
  const tag = ({ view: 'div', text: 'span', 'scroll-view': 'div', picker: 'div', input: 'input', image: 'img' })[node.tag] ?? node.tag;
  const attrs = Object.entries(a).filter(([key]) => !key.startsWith('wx:') && !key.startsWith('bind') && !key.startsWith('catch') && key !== 'src').map(([key, value]) => ` ${key}="${fill(value, data)}"`).join('');
  const action = Object.entries(a).find(([key]) => key.startsWith('bindtap') || key.startsWith('catchtap'));
  const extra = (action ? ` data-qa-action="${escape(action[1])}"` : '') + (node.tag === 'scroll-view' ? ' style="overflow-x:auto"' : '');
  if (tag === 'input') return `<input${attrs}${extra}>`;
  if (tag === 'img') return `<div${attrs} aria-label="合成照片占位"></div>`;
  return `<${tag}${attrs}${extra}>${renderChildren(node.children, data)}</${tag}>`;
}

class ApiError extends Error {}
const modules = {
  '../../services/api': { api: {}, ApiError, readToken: () => 'synthetic-only', captureSessionIdentity: () => ({ token: 'synthetic-only', generation: 0 }), isCurrentSession: () => true },
  '../../services/auth': { ensureLoggedIn: async () => {} },
};
const make = path => makePageContext(loadPage(`${path}.ts`, { modules }).definition);
const medicine = (id, name, state, quantity, expiry, extra = {}) => ({
  id, name, specification: '10mg × 12片', manufacturer: '合成厂家', activeIngredients: [], populationTags: [], purposeTags: [], isArchived: false,
  purposeCategory: null, leaflet: { reviewStatus: 'unverified', purposeSummary: null },
  stockStatus: { state: quantity === null ? 'unknown' : quantity <= 2 ? 'low' : 'ok' }, expiryState: { state, label: state === 'unknown' ? '有效期未知' : '有效期正常' },
  batches: [{ id: `${id}-batch`, quantity, unit: 'tablet', expiry: { value: expiry, precision: expiry ? 'day' : 'unknown' }, expiryState: { state }, openedState: 'unopened', storageLocation: '合成药箱', ...extra }],
});
const home = make('pages/index/index');
home.applyMedicines([
  medicine('synthetic-1', '氯雷他定片', 'ok', 8, '2027-06-30'),
  medicine('synthetic-2', '口服补液盐散', 'expiring_soon', 2, '2026-11-25'),
  medicine('synthetic-3', '合成长名称示例：铝碳酸镁咀嚼片（家庭备用）', 'unknown', null, null),
], '我们的小家');
home.setData({ loading: false, attentionMedicineCount: 2 });
const plans = make('pages/medication-plans/medication-plans');
plans.setData({ loading: false, date: '2026-11-09', isToday: true, hasAnyProfile: true,
  entries: [], visibleEntries: [{ occurrenceId: 'synthetic-dose', time: '08:00', status: 'pending', statusLabel: '未确认', statusClass: 'pending', careProfileName: '我自己', medicineName: '合成示例用药记录', dosageText: '按已填写医嘱记录', overdue: true, retryAction: '' }],
  reminderReason: '服药提醒模板尚未配置，计划与今日安排仍可正常使用。' });
const mine = make('pages/mine/mine');
mine.setData({ familyName: '我们的小家', loading: false, roleLabel: '管理员' });
const screens = [
  { name: '药箱', path: 'pages/index/index', state: home.data },
  { name: '用药计划', path: 'pages/medication-plans/medication-plans', state: plans.data },
  { name: '我的', path: 'pages/mine/mine', state: mine.data },
];
const globalCss = await readFile(resolve(root, 'app.wxss'), 'utf8');
const cssForWeb = css => css.replace(/(^|\n)page\s*\{/g, '$1body {').replace(/(-?[\d.]+)rpx\b/g, (_, n) => `calc(${Number(n) / 7.5}vw)`);
const render = async (screen, scale) => {
  const wxml = await readFile(resolve(root, `${screen.path}.wxml`), 'utf8');
  const css = await readFile(resolve(root, `${screen.path}.wxss`), 'utf8');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><style>html,body{margin:0;min-height:100%}button,input{font:inherit}input{border:0;outline:0;background:transparent;box-sizing:border-box}div,span{box-sizing:border-box}span{white-space:normal}${cssForWeb((globalCss + '\n' + css).replace(/font-size:\s*([\d.]+)(px|rpx)/g, (_, size, unit) => `font-size: ${Number(size) * scale}${unit}`))}</style></head><body>${renderNode(parse(wxml), structuredClone(screen.state))}</body></html>`;
};
const previews = [];
for (const { width, scale, file } of [{ width: 390, scale: 1, file: 'mini-source-390' }, { width: 320, scale: 2, file: 'mini-source-320-text200' }]) {
  const docs = await Promise.all(screens.map(screen => render(screen, scale)));
  const html = `<!doctype html><meta charset="UTF-8"><style>body{margin:0;padding:24px;background:#e5e7eb;color:#1c1c1e;font:14px 'Noto Sans CJK SC',sans-serif}h1{font-size:24px;margin:0 0 8px}p{color:#636366;margin:0 0 20px}main{display:flex;gap:20px}section{width:${width}px}h2{font-size:16px}iframe{display:block;width:${width}px;height:820px;border:0;background:#f2f2f7;border-radius:12px}</style><h1>小药箱 · 小程序源码视觉检查</h1><p>合成数据 · ${width}px 宽 · 文字 ${scale * 100}% · 当前 WXML / WXSS · Chromium 合成，非微信原生验收</p><main>${docs.map((doc, i) => `<section><h2>${screens[i].name}</h2><iframe title="${screens[i].name}" srcdoc="${escape(doc)}"></iframe></section>`).join('')}</main>`;
  await writeFile(resolve(output, `${file}.html`), html);
  previews.push({ width, scale, file, html });
}
if (process.argv.includes('--render-only')) {
  console.info(JSON.stringify({ output, status: 'HTML_ONLY_NOT_VISUALLY_VERIFIED', files: previews.map(p => `${p.file}.html`) }));
  process.exit(0);
}
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.route('**/*', route => route.abort());
const results = [];
for (const { width, scale, file, html } of previews) {
  await page.setViewportSize({ width: width * 3 + 88, height: 980 });
  await page.setContent(html);
  await Promise.all(page.frames().slice(1).map(frame => frame.evaluate(async () => { await document.fonts.ready; })));
  const checks = [];
  for (const frame of page.frames().slice(1)) checks.push(await frame.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const overflow = [...document.querySelectorAll('body *')].filter(el => !el.closest('.filter-scroll') && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > width + 1).map(el => ({ tag: el.tagName, class: el.className, right: Math.round(el.getBoundingClientRect().right) }));
    const smallTargets = [...document.querySelectorAll('[data-qa-action]')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.width < 47.9 || r.height < 47.9); }).map(el => ({ action: el.dataset.qaAction, class: el.className, width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) }));
    return { horizontalOverflow: overflow, smallTargets };
  }));
  results.push({ width, textScale: scale, pages: screens.map((screen, i) => ({ page: screen.name, ...checks[i] })) });
  await page.screenshot({ path: resolve(output, `${file}.png`), fullPage: true });
}
await browser.close();
await writeFile(resolve(output, 'geometry-checks.json'), JSON.stringify({ evidence: 'Synthetic current-source Chromium layout; no WeChat/native/runtime acceptance claim', results }, null, 2));
console.info(JSON.stringify({ output, results }, null, 2));
