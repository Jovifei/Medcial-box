import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { loadPage, makePageContext, makeSessionScopeModule } from './runtime.mjs';

function harness() {
  let generation = 1; const scope = makeSessionScopeModule({ userId: 'u', familyId: 'a' }); const previews = [];
  const api = {
    getRecognitionEvidence: async () => ({ capabilities: { coverPhotoVersionGuard: true }, evidence: {
      schemaVersion: 1, revision: 1, medicineVersion: 1, currentMedicineVersion: 2, stale: true,
      photos: [{ photoId: 'p1', sequence: 2, status: 'recognized', fields: { name: '合成药' }, available: false, warnings: ['请核对'] }],
      fieldSources: { name: { source: 'recognized', photoIds: ['p1'], reviewed: false } },
      batchSources: [{ batchId: null, historicalBatchRef: 'historical', field: 'expiry', source: 'manual', photoIds: [], reviewed: true, batchAvailable: false },
        { batchId: 'batch-1', field: 'lotNumber', source: 'manual', photoIds: [], reviewed: true, batchAvailable: true }] } }),
    listLeafletPhotos: async () => ({ photos: [{ id: 'legacy' }] }),
    getMedicine: async () => ({ version: 2, batches: [{ id: 'batch-1', lotNumber: 'SYN-1', expiry: { value: '2030-01', precision: 'month' } }] }),
    downloadLeafletPhoto: async () => '/synthetic/photo',
  };
  const { definition } = loadPage('pages/medicine-photos/medicine-photos.ts', { modules: {
    '../../services/api': { api, captureSessionIdentity: () => ({ token: 't', generation }), isCurrentSession: i => i.generation === generation },
    '../../services/auth': { ensureLoggedIn: async () => {} }, '../../services/session-scope': scope,
    '../../services/recognition-evidence-sync': { clearRecognitionEvidenceRecoveryProofs: () => {}, getPendingRecognitionEvidence: () => null, retryRecognitionEvidence: async () => ({ status: 'synced' }) },
  }, wx: { previewImage: options => previews.push(options.current) } });
  const page = makePageContext(definition); page.onLoad({ id: 'm' });
  return { page, api, previews, scope, setGeneration: value => { generation = value; } };
}
test('saved evidence retains stable number, warnings, unavailable original and unnumbered legacy photo', async () => {
  const h = harness(); await h.page.onShow();
  assert.equal(h.page.data.photos[0].numberLabel, '图2'); assert.equal(h.page.data.photos[0].available, false);
  assert.match(h.page.data.photos[0].fields[0].value, /合成药/); assert.match(h.page.data.photos[0].warnings[0], /请核对/);
  assert.match(h.page.data.photos[1].numberLabel, /未记录图号/); assert.match(h.page.data.evidenceNotice, /变化|过期|不同步/);
  assert.match(h.page.data.sources[1].label, /原库存已移除或未绑定/); assert.match(h.page.data.sources[1].detail, /历史记录曾核对/);
  assert.match(h.page.data.sources[2].label, /第1份库存.*SYN-1/);
  await h.page.onPreviewPhoto({ currentTarget: { dataset: { id: 'p1' } } }); assert.deepEqual(h.previews, []);
  await h.page.onPreviewPhoto({ currentTarget: { dataset: { id: 'legacy' } } }); assert.deepEqual(h.previews, ['/synthetic/photo']);
});
test('404 evidence keeps original photos and identifies unsupported history', async () => {
  const h = harness(); h.api.getRecognitionEvidence = async () => { throw { statusCode: 404 }; };
  await h.page.onShow(); assert.match(h.page.data.evidenceNotice, /不支持|不可用/);
  assert.equal(h.page.data.photos.length, 1); assert.match(h.page.data.photos[0].numberLabel, /未记录图号/);
});
test('stock details are linked to the correct batch and a changed medicine version is disclosed', async () => {
  const h = harness(); const read = h.api.getRecognitionEvidence;
  h.api.getRecognitionEvidence = async () => { const result = await read(); result.evidence.stale = false; return result; };
  h.api.getMedicine = async () => ({ version: 3, batches: [{ id: 'batch-1', lotNumber: 'SYN-1', expiry: { value: null } }] });
  await h.page.onShow(); assert.match(h.page.data.evidenceNotice, /读取期间发生变化/);
  assert.match(h.page.data.sources[2].label, /第1份库存.*SYN-1/);
  const unavailable = harness(); unavailable.api.getMedicine = async () => { throw Error('network'); };
  await unavailable.page.onShow(); assert.match(unavailable.page.data.evidenceNotice, /库存明细暂时不可用/);
  assert.match(unavailable.page.data.sources[2].label, /明细暂不可用/);
  assert.equal(unavailable.page.data.photos.length, 2);
});
test('hidden or switched household rejects late requests and clears private material', async () => {
  const h = harness(); let resolve; h.api.listLeafletPhotos = () => new Promise(done => { resolve = done; });
  const pending = h.page.onShow(); await new Promise(done => setImmediate(done));
  h.page.onHide(); h.scope.writeSessionScope({ userId: 'u', familyId: 'b' }); h.setGeneration(2);
  resolve({ photos: [{ id: 'secret' }] }); await pending;
  assert.equal(h.page.data.photos.length, 0); assert.equal(h.page.data.evidenceNotice, '');
});
test('page has explicit retry and a cold-start exit', () => {
  const markup = fs.readFileSync(new URL('../pages/medicine-photos/medicine-photos.wxml', import.meta.url), 'utf8');
  assert.match(markup, /bindtap="onRetrySync"/); assert.match(markup, /bindtap="onBack"/);
  const calls = [];
  const { definition } = loadPage('pages/medicine-photos/medicine-photos.ts', { modules: {
    '../../services/api': { api: {} }, '../../services/auth': { ensureLoggedIn: async () => {} },
    '../../services/recognition-evidence-sync': { clearRecognitionEvidenceRecoveryProofs: () => {} },
  }, wx: { switchTab: options => calls.push(options.url) } });
  makePageContext(definition).onBack(); assert.deepEqual(calls, ['/pages/index/index']);
});
test('page hide and unload discard only the in-memory review proof', () => {
  let clears = 0; const { definition } = loadPage('pages/medicine-photos/medicine-photos.ts', { modules: {
    '../../services/api': { api: {} }, '../../services/auth': { ensureLoggedIn: async () => {} },
    '../../services/recognition-evidence-sync': { clearRecognitionEvidenceRecoveryProofs: () => { clears++; } },
  } });
  const page = makePageContext(definition); page.onLoad({id:'m'}); page.onHide(); page.onUnload();
  assert.equal(clears,2);
});
test('a token change observed during original download clears the visible private view', async () => {
  const h = harness(); let resolve;
  await h.page.onShow();
  h.api.downloadLeafletPhoto = () => new Promise(done => { resolve = done; });
  const pending = h.page.onPreviewPhoto({ currentTarget: { dataset: { id: 'legacy' } } });
  await new Promise(done => setImmediate(done)); h.setGeneration(2); resolve('/synthetic/old'); await pending;
  assert.deepEqual(h.previews, []); assert.equal(h.page.data.photos.length, 0); assert.equal(h.page.data.sources.length, 0);
});
test('pending photos and current values are visible before explicit recovery confirmation', async () => {
  const scope = makeSessionScopeModule({ userId:'u', familyId:'a' }); let allow = false, confirmed = 0;
  let pending = { medicineId:'m', payload: { schemaVersion:1, revision:0, medicineVersion:1, idempotencyKey:'old-key',
    photos:[{photoId:'p',sequence:3,status:'recognized',fields:{name:'合成药'},warnings:['请核对']}],
    fieldSources:{name:{source:'recognized',photoIds:['p'],reviewed:false}}, batchSources:[] } };
  const medicine = { id:'m', name:'合成药', version:2, batches:[] };
  const api = { getRecognitionEvidence:async()=>({evidence:null}), listLeafletPhotos:async()=>({photos:[{id:'p'}]}),
    getMedicine:async()=>medicine };
  const sync = { clearRecognitionEvidenceRecoveryProofs:()=>{}, getPendingRecognitionEvidence:()=>structuredClone(pending),
    prepareRecognitionEvidenceRecovery:async()=>({status:'ready',oldMedicineVersion:1,currentMedicineVersion:2,medicine}),
    confirmRecognitionEvidenceRecovery:async()=>{ confirmed++; pending={...pending,previousPayloads:[pending.payload],
      payload:{...pending.payload,medicineVersion:2,idempotencyKey:'new-key'}}; return {status:'pending',reason:'rejected'}; } };
  const {definition}=loadPage('pages/medicine-photos/medicine-photos.ts',{modules:{
    '../../services/api':{api}, '../../services/auth':{ensureLoggedIn:async()=>{}}, '../../services/session-scope':scope,
    '../../services/recognition-evidence-sync':sync,
  },wx:{showModal:options=>options.success({confirm:allow})}});
  const page=makePageContext(definition); page.onLoad({id:'m'}); await page.onShow();
  assert.equal(page.data.pendingIntents[0].photos[0].fields[0].value,'合成药');
  await page.onReviewRecovery(); assert.equal(page.data.recoveryReady,true); assert.match(page.data.recoveryVersion,/1.*2/);
  assert.equal(page.data.recoveryValues[0].value,'合成药');
  await page.onConfirmRecovery(); assert.equal(confirmed,0);
  allow=true; await page.onConfirmRecovery(); assert.equal(confirmed,1);
  assert.equal(page.data.pendingIntents.length,2); assert.match(page.data.syncNotice,/暂未接受/);
});
test('a background session change immediately clears displayed family photos and sources', async () => {
  const h = harness(); await h.page.onShow();
  assert.equal(h.page.data.photos.length, 2);
  h.setGeneration(2); h.scope.notifySessionChange();
  assert.equal(h.page.data.photos.length, 0);
  assert.equal(h.page.data.sources.length, 0);
  assert.match(h.page.data.evidenceNotice, /家庭或登录状态已变化/);
  h.page.onUnload();
});
