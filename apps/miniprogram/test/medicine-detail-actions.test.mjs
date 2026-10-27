import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadPage, makePageContext } from './runtime.mjs';

test('detail orders identity, stock and photos, with one summary and secondary actions in more', () => {
  const markup = fs.readFileSync(new URL('../pages/medicine-detail/medicine-detail.wxml', import.meta.url), 'utf8');
  assert.ok(markup.indexOf('hero-card') < markup.indexOf('库存批次'));
  assert.ok(markup.indexOf('库存批次') < markup.indexOf('leaflet-photo-section'));
  assert.equal((markup.match(/\{\{leafletText\}\}/g) || []).length, 1);
  assert.doesNotMatch(markup, /\{\{leafletPurpose\}\}|\{\{leafletUsage\}\}/);
  assert.ok(markup.indexOf('wx:if="{{moreExpanded}}"') < markup.indexOf('个人剂量备注'));
  assert.ok(markup.indexOf('wx:if="{{moreExpanded}}"') < markup.indexOf('低库存设置'));
  for (const handler of ['onAddLeafletPhoto','onTapEditMedicine','onTapCreatePlan','onTapExport','onTapAudit','onArchiveMedicine','onDeleteMedicine','onAdjustQuantity']) assert.match(markup, new RegExp(`bindtap="${handler}"|catchtap="${handler}"`));
  assert.match(markup, /mode="aspectFit"[^>]*bindtap="onPreviewCover"/);
});
test('cover preview uses the already authorized local image and rejects old identity', () => {
  let generation = 1; const calls = [];
  const { definition } = loadPage('pages/medicine-detail/medicine-detail.ts', { modules: {
    '../../services/api': { api: {}, ApiError: class extends Error {}, captureSessionIdentity: () => ({token:'t',generation}), isCurrentSession: i => i.generation === generation },
    '../../services/auth': { ensureLoggedIn: async () => {} },
  }, wx: { previewImage: options => calls.push(options.current) } });
  const page = makePageContext(definition);
  page.displayedIdentity = {token:'t',generation:1}; page.displayedMedicineId = 'm'; page.data.medicineId = 'm'; page.data.coverPhotoPath = '/synthetic/cover';
  page.onPreviewCover(); assert.deepEqual(calls, ['/synthetic/cover']);
  generation = 2; page.onPreviewCover(); assert.deepEqual(calls, ['/synthetic/cover']);
});
test('photo deletion confirmation cannot dispatch after a family switch', async () => {
  let generation = 1, modal, deletes = 0;
  const { definition } = loadPage('pages/medicine-detail/medicine-detail.ts', { modules: {
    '../../services/api': { api: { deleteLeafletPhoto: async () => { deletes++; } }, ApiError: class extends Error {},
      captureSessionIdentity: () => ({token:'t',generation}), isCurrentSession: i => i.generation === generation },
    '../../services/auth': { ensureLoggedIn: async () => {} },
  }, wx: { showModal: options => { modal = options; } } });
  const page = makePageContext(definition);
  page.data.medicineId = 'm'; page.data.leafletPhotos = [{id:'photo'}];
  const pending = page.onDeleteLeafletPhoto({currentTarget:{dataset:{id:'photo'}}});
  generation = 2; modal.success({confirm:true}); await pending;
  assert.equal(deletes, 0);
});
test('unverified summary remains visible with its uncertainty instead of being discarded', () => {
  const { definition } = loadPage('pages/medicine-detail/medicine-detail.ts', { modules: {
    '../../services/api': { api: {}, ApiError: class extends Error {} }, '../../services/auth': { ensureLoggedIn: async () => {} },
  } });
  const page = makePageContext(definition);
  page.applyData({name:'合成', specification:null, brand:null, manufacturer:null, approvalNumber:null,
    activeIngredients:[], populationTags:[], purposeTags:[], batches:[], lowStockThreshold:null,
    leaflet:{reviewStatus:'unverified',purposeSummary:'合成用途',packageUsageSummary:'合成原文',contraindicationsSummary:null,precautionsSummary:null,source:null}}, []);
  assert.match(page.data.leafletText, /合成用途/);
  assert.match(page.data.leafletText, /合成原文/);
  assert.match(page.data.leafletText, /未核验/);
  assert.match(page.data.leafletText, /不作为用药依据/);
});
