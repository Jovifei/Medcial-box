import { ownedPhotoFixture } from "./support/owned-photo-fixture.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPage, makePageContext } from './runtime.mjs';

function fixture(recognizeMedicine) {
  const timers = [];
  const { definition } = loadPage('pages/medicine-edit/medicine-edit.ts', {
    setTimeoutFn: fn => { timers.push(fn); return timers.length; },
    modules: { '../../services/auth': { ensureLoggedIn: async () => {} }, '../../services/api': { api: { recognizeMedicine }, ApiError: class extends Error {} } },
    wx: { ...ownedPhotoFixture(), chooseMedia: async () => ({ tempFiles: [{ tempFilePath: '/box.jpg', size: 100 }] }) },
  });
  const page = makePageContext(definition);
  page.onLoad({});
  return { page, timers };
}

test('visible recognition clock stops when response completes and applies editable tags and brand', async () => {
  const f = fixture(async () => ({ draft: { name: '药名', brand: '品牌', purposeTags: ['itch'], populationTags: ['adult'] }, warnings: [] }));
  await f.page.onRecognizePhoto('camera');
  assert.equal(f.page.data.brand, '品牌');
  assert.equal(f.page.data.purposeChips.find(x => x.kind === 'itch').selected, true);
  assert.equal(f.page.data.populationChips.find(x => x.kind === 'adult').selected, true);
  assert.equal(f.page.data.recognizing, false);
  assert.equal(f.page.recognitionTimer, null);
});

test('late AI suggestions do not overwrite tags or leaflet text touched while request is pending', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.page.onRecognizePhoto({ currentTarget: { dataset: { purpose: 'leaflet' } } });
  for (let i = 0; i < 40 && !finish; i++) await Promise.resolve();
  assert.equal(f.page.data.recognitionSubject, '说明书');
  f.timers[0]();
  assert.equal(f.page.data.recognitionSeconds, 1);
  f.page.onTogglePurposeTag({ currentTarget: { dataset: { kind: 'cough' } } });
  f.page.onFieldInput({ currentTarget: { dataset: { field: 'leafletPrecautions' } }, detail: { value: '本人补充' } });
  finish({ draft: { purposeTags: ['itch'], leaflet: { packageUsageSummary: '包装用法', precautionsSummary: '识别注意事项' } }, warnings: [] });
  await pending;
  assert.deepEqual(Array.from(f.page.data.purposeTags), ['cough']);
  assert.equal(f.page.data.leafletPrecautions, '本人补充');
  assert.equal(f.page.data.leafletUsage, '包装用法');
  assert.equal(f.page.data.verified, false);
  assert.equal(f.page.data.photoDrafts[0].photos[0].purpose, 'leaflet');
});

test('choosing first month expiry from unknown persists month precision and unloaded response is ignored', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.page.onExpiryDateChange({ currentTarget: { dataset: { index: '0' } }, detail: { value: '2028-05', precision: 'month' } });
  assert.equal(f.page.data.batches[0].precisionIndex, 1);
  const pending = f.page.onRecognizePhoto('camera');
  for (let i = 0; i < 40 && !finish; i++) await Promise.resolve();
  f.page.onUnload();
  finish({ draft: { name: '晚到药名' }, warnings: [] });
  await pending;
  assert.equal(f.page.data.name, '');
  assert.equal(f.page.recognitionTimer, null);
});
