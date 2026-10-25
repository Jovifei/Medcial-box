// 58 号设计（方案 B）：选择家庭药箱页渐进展开布局。
// 家庭列表优先、创建/邀请收起为"添加或加入家庭"；展开状态不持久化、
// 不清空邀请输入/预览/错误；原有 handler 与禁用态保持不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPage, makePageContext } from './runtime.mjs';

function pageFor({ families = [], inviteCode = '', preview } = {}) {
  const writes = [];
  const { definition } = loadPage('pages/family-entry/family-entry.ts', {
    modules: {
      '../../services/api': {
        api: {
          listFamilies: async () => ({ families }),
          switchFamily: async (familyId) => ({ familyId, role: 'member' }),
          previewInvitation: preview instanceof Error ? async () => { throw preview; } : async () => preview ?? { family: { name: '合成家庭' }, expiresAt: '2099-01-01T00:00:00Z' },
          acceptInvitation: async () => ({ family: { name: '合成家庭' } }),
        },
        ApiError: class ApiError extends Error { constructor(code, message, statusCode) { super(message); this.code = code; this.statusCode = statusCode; } },
      },
      '../../services/auth': { ensureLoggedIn: async () => {} },
    },
    wx: {
      getStorageSync: () => '',
      setStorageSync: (k, v) => writes.push([k, v]),
      removeStorageSync: () => {},
      showModal: o => o.success({ confirm: true }),
      switchTab: () => {},
      navigateTo: () => {},
      showToast: () => {},
      reLaunch: () => {},
    },
  });
  const page = makePageContext(definition);
  page.onLoad(inviteCode === '' ? {} : { code: inviteCode });
  return { page, writes };
}

test('with families the chooser shows the list first and keeps create/join collapsed', async () => {
  const { page } = pageFor({ families: [
    { familyId: 'f-a', name: '家庭A', role: 'owner', isCurrent: true },
    { familyId: 'f-b', name: '家庭B', role: 'member', isCurrent: false },
  ] });
  await page.refresh();
  assert.equal(page.data.families.length, 2);
  assert.equal(page.data.addExpanded, false, 'has-family users see the list first');
});

test('without families create/join expands automatically', async () => {
  const { page } = pageFor({ families: [] });
  await page.refresh();
  assert.equal(page.data.addExpanded, true);
});

test('invite code prefill or preview or error keeps the add section visible', async () => {
  const prefilled = pageFor({ families: [{ familyId: 'f-a', name: '家庭A', role: 'member', isCurrent: false }], inviteCode: 'share-code' });
  await prefilled.page.refresh();
  assert.equal(prefilled.page.data.addExpanded, true, 'cold invite link must not be folded away');

  const withPreview = pageFor({ families: [{ familyId: 'f-a', name: '家庭A', role: 'member', isCurrent: false }] });
  withPreview.page.setData({ preview: { code: 'c', familyName: 'A', expiresAt: '2099-01-01 00:00' } });
  await withPreview.page.refresh();
  assert.equal(withPreview.page.data.addExpanded, true);

  const withError = pageFor({ families: [{ familyId: 'f-a', name: '家庭A', role: 'member', isCurrent: false }] });
  withError.page.setData({ errorMessage: '邀请码已过期' });
  await withError.page.refresh();
  assert.equal(withError.page.data.addExpanded, true, 'errors must stay visible');
});

test('toggle keeps invite input, preview and error; manual expansion survives refresh', async () => {
  const { page, writes } = pageFor({ families: [{ familyId: 'f-a', name: '家庭A', role: 'member', isCurrent: false }] });
  await page.refresh();
  page.onToggleAdd(); // 手动展开
  page.onInviteInput({ detail: { value: 'code-1' } });
  page.setData({ preview: { code: 'code-1', familyName: 'A', expiresAt: '2099-01-01 00:00' }, errorMessage: '上次预览失败' });
  page.onToggleAdd();
  assert.equal(page.data.addExpanded, true, 'pending preview/error must keep the section visible (58号)');
  assert.equal(page.data.inviteInput, 'code-1', 'toggle must not clear the invite input');
  assert.notEqual(page.data.preview, null, 'toggle must not clear the preview');
  assert.notEqual(page.data.errorMessage, '', 'toggle must not clear the error');
  assert.equal(writes.length, 0, 'expansion is page-local UI state, never persisted');
  // 清空输入与错误后才能收起；收起不清输入字段本身以外的任何值。
  page.onInviteInput({ detail: { value: '' } });
  page.setData({ preview: null, errorMessage: '' });
  page.onToggleAdd();
  assert.equal(page.data.addExpanded, false);
  page.onToggleAdd();
  await page.refresh();
  assert.equal(page.data.addExpanded, true, 'manual expansion survives onShow refresh');
});

test('collapse is blocked while invite input, preview or error is pending (58号: 不得折叠遮住)', async () => {
  const { page } = pageFor({ families: [{ familyId: 'f-a', name: '家庭A', role: 'member', isCurrent: false }] });
  await page.refresh();
  page.onToggleAdd(); // 先手动展开
  assert.equal(page.data.addExpanded, true);
  page.onInviteInput({ detail: { value: 'code-1' } });
  page.setData({ errorMessage: '邀请码无效或已被撤销' });
  page.onToggleAdd(); // 有未完成邀请操作时尝试收起
  assert.equal(page.data.addExpanded, true, 'pending invite activity must keep the section visible');
  assert.notEqual(page.data.errorMessage, '');
  page.onInviteInput({ detail: { value: '' } });
  page.setData({ errorMessage: '' });
  page.onToggleAdd();
  assert.equal(page.data.addExpanded, false, 'without pending activity collapse works normally');
});

test('family rows keep the original switch contract and disabled state', async () => {
  let switched = 0;
  const { definition } = loadPage('pages/family-entry/family-entry.ts', {
    modules: {
      '../../services/api': {
        api: {
          listFamilies: async () => ({ families: [{ familyId: 'f-b', name: '家庭B', role: 'member', isCurrent: false }] }),
          switchFamily: async () => { switched++; },
        },
        ApiError: class ApiError extends Error {},
      },
      '../../services/auth': { ensureLoggedIn: async () => {} },
    },
    wx: { switchTab: () => {}, showToast: () => {} },
  });
  const page = makePageContext(definition);
  page.onLoad({});
  await page.refresh();
  await page.onSwitchFamily({ currentTarget: { dataset: { familyId: 'f-b' } } });
  assert.equal(switched, 1);
  page.setData({ submitting: true });
  await page.onSwitchFamily({ currentTarget: { dataset: { familyId: 'f-b' } } });
  assert.equal(switched, 1, 'submitting must keep rows non-interactive');
});

test('wxml keeps handler bindings, isolation hint, bottom nav and per-row role labels', () => {
  const root = new URL('../', import.meta.url);
  const wxml = fs.readFileSync(new URL('pages/family-entry/family-entry.wxml', root), 'utf8');
  assert.match(wxml, /bindtap="onSwitchFamily"/);
  assert.match(wxml, /data-family-id="\{\{item\.familyId\}\}"/);
  assert.match(wxml, /disabled="\{\{submitting\}\}"/);
  assert.match(wxml, /bindtap="onCreateFamily"/);
  assert.match(wxml, /bindinput="onInviteInput"/);
  assert.match(wxml, /bindtap="onPreviewInvitation"/);
  assert.match(wxml, /bindtap="onAcceptInvitation"/);
  assert.match(wxml, /bindtap="onToggleAdd"/);
  assert.match(wxml, /家庭之间不混合/, 'family isolation hint must stay');
  assert.match(wxml, /当前/, 'current family must be labeled in text, not color alone');
  assert.match(wxml, /<business-nav(?:\s[^>]*)?\s*\/>/);
  assert.doesNotMatch(wxml.split('<business-nav')[0], /欢迎使用家庭药箱[\s\S]*先选择你的家庭[\s\S]*选择当前家庭/, 'hero must not push the family list below the fold');
});
