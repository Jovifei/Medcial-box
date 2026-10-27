import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadPage, makePageContext } from './runtime.mjs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('native and shared navigation expose the same three tabs; pending remains a page', () => {
  const app = JSON.parse(read('app.json'));
  assert.deepEqual(app.tabBar.list.map(tab => tab.pagePath), [
    'pages/index/index', 'pages/medication-plans/medication-plans', 'pages/mine/mine',
  ]);
  assert.ok(app.pages.includes('pages/pending/pending'));
  const nav = read('components/business-nav/business-nav.wxml');
  assert.equal((nav.match(/<button\b/g) || []).length, 3);
  assert.doesNotMatch(nav, /data-url="\/pages\/pending\/pending"/);
  assert.match(read('pages/pending/pending.wxml'), /<business-nav\s*\/>/);
});
test('notification settings opens the non-tab pending route and invitation has a cold-start exit', () => {
  const calls = [];
  const { definition } = loadPage('pages/notification-settings/notification-settings.ts', {
    modules: { '../../services/api': { api: {}, ApiError: class extends Error {} }, '../../services/auth': { ensureLoggedIn: async () => {} } },
    wx: { navigateTo: options => calls.push(['page', options.url]), switchTab: options => calls.push(['tab', options.url]) },
  });
  makePageContext(definition).onOpenPending();
  assert.deepEqual(calls, [['page', '/pages/pending/pending']]);
  const invite = read('pages/invite/invite.wxml');
  assert.match(invite, /返回药箱/);
  assert.match(invite, /家庭管理/);
});
