import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { loadPage, makePageContext } from './runtime.mjs';

function fixture(listMedicines) {
  let generation = 1;
  const { definition } = loadPage('pages/index/index.ts', { modules: {
    '../../services/api': {
      api: { getCurrentFamily: async () => ({ family: { name: '测试家庭' } }), listMedicines },
      ApiError: class extends Error {}, readToken: () => 'token',
      captureSessionIdentity: () => ({ token: 'token', generation }),
      isCurrentSession: identity => identity.generation === generation,
    },
    '../../services/auth': { ensureLoggedIn: async () => {} },
  } });
  return { page: makePageContext(definition), switchIdentity: () => { generation++; } };
}

test('home shows loading until the current household list returns, then permits the empty state', async () => {
  let resolveList;
  const { page } = fixture(() => new Promise(resolve => { resolveList = resolve; }));
  assert.equal(page.data.loading, true);
  const refresh = page.refresh(); await tick();
  assert.equal(page.data.loading, true);
  resolveList({ medicines: [] }); await refresh;
  assert.equal(page.data.loading, false);
  assert.equal(page.data.errorMessage, '');
  const markup = fs.readFileSync(new URL('../pages/index/index.wxml', import.meta.url), 'utf8');
  assert.match(markup, /loading && allItems\.length === 0/);
  assert.match(markup, /!loading && errorMessage === '' && allItems\.length === 0/);
});

test('home failure ends loading and displays an error rather than an empty cabinet', async () => {
  const { page } = fixture(async () => { throw new Error('offline'); });
  await page.refresh();
  assert.equal(page.data.loading, false);
  assert.notEqual(page.data.errorMessage, '');
  assert.equal(page.data.allItems.length, 0);
  assert.equal(page.data.errorStale, false);
});

const syntheticMedicine = {
  id: 'm-retained', name: '测试药品甲', specification: '10mg/片', manufacturer: null,
  activeIngredients: [], purposeCategory: null, populationTags: [], purposeTags: [], batches: [],
  leaflet: { reviewStatus: 'unverified', purposeSummary: null },
  stockStatus: { state: 'unknown' }, expiryState: { state: 'unknown', label: '未知' }, isArchived: false,
};

test('refresh failure keeps the last loaded cabinet for the same household and marks it stale', async () => {
  let calls = 0;
  const { page } = fixture(async () => {
    calls += 1;
    if (calls === 1) return { medicines: [syntheticMedicine] };
    throw new Error('offline');
  });
  await page.refresh();
  assert.equal(page.data.allItems.length, 1);
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.errorStale, false);

  await page.refresh();
  assert.equal(page.data.loading, false);
  assert.notEqual(page.data.errorMessage, '');
  assert.equal(page.data.errorStale, true);
  assert.equal(page.data.allItems.length, 1);
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.familyName, '测试家庭');
  assert.equal(page.data.cabinetCount, 1);

  const markup = fs.readFileSync(new URL('../pages/index/index.wxml', import.meta.url), 'utf8');
  assert.match(markup, /errorStale \? '暂时无法更新药箱' : '暂时无法加载药箱'/);
  assert.match(markup, /正在显示上次读取的库存/);
});

test('a successful retry clears the stale marker and replaces the retained list', async () => {
  let calls = 0;
  const { page } = fixture(async () => {
    calls += 1;
    if (calls === 2) throw new Error('offline');
    return { medicines: [calls === 1
      ? syntheticMedicine
      : { ...syntheticMedicine, id: 'm-new', name: '测试药品乙' }] };
  });
  await page.refresh();
  await page.refresh();
  assert.equal(page.data.errorStale, true);
  await page.refresh();
  assert.equal(page.data.errorStale, false);
  assert.equal(page.data.errorMessage, '');
  assert.equal(page.data.allItems.length, 1);
  assert.equal(page.data.allItems[0].id, 'm-new');
});

test('retry replaces the old error with loading while the new list is pending', async () => {
  let calls = 0, resolveList;
  const { page } = fixture(() => ++calls === 1
    ? Promise.reject(new Error('offline'))
    : new Promise(resolve => { resolveList = resolve; }));
  await page.refresh();
  const retry = page.refresh(); await tick();
  assert.equal(page.data.loading, true);
  assert.equal(page.data.errorMessage, '');
  resolveList({ medicines: [] }); await retry;
  assert.equal(page.data.loading, false);
});

test('late previous household response cannot end the new household loading state', async () => {
  const requests = [];
  const { page, switchIdentity } = fixture(() => new Promise(resolve => requests.push(resolve)));
  const first = page.refresh(); await tick();
  switchIdentity(); const second = page.refresh(); await tick();
  requests[0]({ medicines: [] }); await first;
  assert.equal(page.data.loading, true);
  requests[1]({ medicines: [] }); await second;
  assert.equal(page.data.loading, false);
});
