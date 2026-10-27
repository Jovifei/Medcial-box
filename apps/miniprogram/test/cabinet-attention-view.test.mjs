import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { loadPage, makePageContext } from './runtime.mjs';

const task = (id, type, medicineId, action = 'edit_batch') => ({ id, type, medicineId, action, batchId: 'b', medicineName: medicineId || '', message: id, dueDate: null });
const tasks = [task('expired', 'expired', 'm1'), task('low', 'low_stock', 'm1', 'restock'), task('check', 'needs_check', 'm2'), task('stocktake', 'stocktake_due', null, 'stocktake'), task('optional', 'leaflet_missing', 'm3', 'review_leaflet')];
const medicine = id => ({id,name:id,specification:null,manufacturer:null,activeIngredients:[],purposeCategory:null,populationTags:[],purposeTags:[],batches:[],leaflet:{reviewStatus:'unverified',purposeSummary:null},stockStatus:{state:'unknown'},expiryState:{state:'unknown',label:'未知'},isArchived:false});
const apiModule = api => ({ api, ApiError: class extends Error {}, readToken: () => 'synthetic-token' });
const auth = { ensureLoggedIn: async () => {} };

test('home uses pending service: unique medicines, separate stocktake, optional materials do not alert', async () => {
  const calls = [];
  const { definition } = loadPage('pages/index/index.ts', { modules: {
    '../../services/api': apiModule({ getCurrentFamily: async () => ({family:{name:'A'}}), listMedicines: async () => ({medicines:[medicine('m1'), medicine('m2'), medicine('m3')]}), getPendingNotifications: async () => ({items:tasks}) }),
    '../../services/auth': auth,
  }, wx: { navigateTo: o => calls.push(o.url) } });
  const page = makePageContext(definition);
  await page.refresh();
  assert.equal(page.data.attentionMedicineCount, 2);
  assert.equal(page.data.attentionStocktake, true);
  page.onOpenAttention();
  assert.deepEqual(calls, ['/pages/pending/pending']);
});
test('pending page separates optional suggestions from actionable list and routes a task directly', async () => {
  const calls = [];
  const { definition } = loadPage('pages/pending/pending.ts', { modules: {
    '../../services/api': apiModule({ getPendingNotifications: async () => ({items:tasks}) }), '../../services/auth': auth,
  }, wx: { navigateTo: o => calls.push(o.url) } });
  const page = makePageContext(definition);
  await page.refresh();
  assert.equal(page.data.attentionItems.length, 4);
  assert.equal(page.data.suggestionItems.length, 1);
  assert.equal(page.data.suggestionsExpanded, false);
  page.onHandle({currentTarget:{dataset:{id:'m1',batchId:'b',action:'edit_batch'}}});
  page.onHandle({currentTarget:{dataset:{action:'stocktake'}}});
  assert.deepEqual(calls, ['/pages/batch-edit/batch-edit?medicineId=m1&batchId=b', '/pages/stocktake/stocktake']);
});
test('home has one add entry and clears keyword independently of filter reset', () => {
  const markup = fs.readFileSync(new URL('../pages/index/index.wxml', import.meta.url), 'utf8');
  assert.equal((markup.match(/bindtap="onTapAdd"/g) || []).length, 1);
  const { definition } = loadPage('pages/index/index.ts', { modules: { '../../services/api': apiModule({}), '../../services/auth': auth } });
  const page = makePageContext(definition);
  page.setData({keyword:'合成',filterKind:'low'}); page.onClearFilters();
  assert.equal(page.data.keyword, '合成');
  assert.equal(page.data.filterKind, 'all');
});
test('home family control opens family management, where switching and invitations live', () => {
  const calls = [];
  const { definition } = loadPage('pages/index/index.ts', { modules: { '../../services/api': apiModule({}), '../../services/auth': auth },
    wx: { navigateTo: options => calls.push(options.url) } });
  makePageContext(definition).onTapFamily();
  assert.deepEqual(calls, ['/pages/family-settings/family-settings']);
  const family = fs.readFileSync(new URL('../pages/family-settings/family-settings.wxml', import.meta.url), 'utf8');
  assert.match(family, /bindtap="onChooseFamily"/);
  assert.match(family, /bindtap="onOpenInvite"/);
});
test('active filter summary names the selected population and purpose', () => {
  const { definition } = loadPage('pages/index/index.ts', { modules: { '../../services/api': apiModule({}), '../../services/auth': auth } });
  const page = makePageContext(definition);
  page.onTogglePopulation({currentTarget:{dataset:{value:'child'}}});
  page.onTogglePurpose({currentTarget:{dataset:{value:'发热'}}});
  assert.match(page.data.filterSummary, /儿童/); assert.match(page.data.filterSummary, /发热/);
});
test('a late pending response cannot replace the newer attention summary', async () => {
  const requests = [];
  const { definition } = loadPage('pages/index/index.ts', { modules: {
    '../../services/api': apiModule({ getCurrentFamily: async () => ({family:{name:'A'}}),
      listMedicines: async () => ({medicines:[medicine('m1'),medicine('m2')]}),
      getPendingNotifications: () => new Promise(resolve => requests.push(resolve)) }), '../../services/auth': auth,
  } });
  const page = makePageContext(definition);
  const first = page.refresh(); await tick(); const second = page.refresh(); await tick();
  requests[1]({items:[task('new','expired','m2')]}); await second;
  requests[0]({items:tasks}); await first;
  assert.deepEqual([...page.data.attentionMedicineIds], ['m2']);
  assert.equal(page.data.attentionStocktake, false);
});
test('attention service failure leaves the medicine list available and reports the missing summary', async () => {
  const { definition } = loadPage('pages/index/index.ts', { modules: {
    '../../services/api': apiModule({getCurrentFamily: async () => ({family:{name:'A'}}),
      listMedicines: async () => ({medicines:[medicine('m1')]}), getPendingNotifications: async () => { throw Error('offline'); }}),
    '../../services/auth': auth,
  } });
  const page = makePageContext(definition); await page.refresh();
  assert.equal(page.data.items.length, 1); assert.equal(page.data.attentionUnavailable, true);
});
