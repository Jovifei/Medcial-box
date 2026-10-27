import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { loadService, makeSessionScopeModule } from './runtime.mjs';

const initial = () => ({ schemaVersion: 1, revision: 0, medicineVersion: 1, idempotencyKey: 'original-request-key-001',
  photos: [{ photoId: 'photo-1', sequence: 2, status: 'recognized', fields: { name: '合成药', expiryValue: '2030-01', expiryPrecision: 'month' }, warnings: ['请核对'] }],
  fieldSources: { name: { source: 'recognized', photoIds: ['photo-1'], reviewed: false } },
  batchSources: [{ batchId: 'batch-1', field: 'expiry', source: 'recognized', photoIds: ['photo-1'], reviewed: false }] });
function harness() {
  const store = new Map(), posts = []; const scope = makeSessionScopeModule({userId:'u', familyId:'a'});
  let generation = 1, version = 1, remote = null, offline = true, rejectNew = 0, failWrites = false, photoBatch = 'batch-1', acknowledged = false;
  const receipt = (body, overrides = {}) => ({ ...body, revision: body.revision + 1, currentMedicineVersion: version, stale: false,
    photos: body.photos.map(photo => ({ ...photo, available: true })), batchSources: body.batchSources.map(source => ({ ...source, batchAvailable: true })), ...overrides });
  const api = {
    getRecognitionEvidence: async () => ({ evidence: remote, capabilities: { coverPhotoVersionGuard: true } }),
    getMedicine: async () => ({ id:'m', name:'合成药', version, batches:[{ id:'batch-1', version:2, lotNumber:null, expiry:{value:'2030-01',precision:'month'} }] }),
    listLeafletPhotos: async () => ({ photos: [{ id:'photo-1', batchId:photoBatch }] }),
    saveRecognitionEvidence: async (_id, body) => {
      posts.push(structuredClone(body));
      if (offline) throw Error('network');
      if (acknowledged && body.idempotencyKey === 'original-request-key-001') return { evidence:receipt(body, { stale:true }) };
      if (body.medicineVersion !== version || remote?.revision !== undefined && remote.revision !== body.revision) throw {statusCode:409};
      if (rejectNew) throw {statusCode:rejectNew};
      remote = receipt(body); return { evidence:remote };
    },
  };
  const wx = {getStorageSync:key=>store.get(key), setStorageSync:(key,value)=>{if(failWrites) throw Error('quota'); store.set(key,structuredClone(value));}, removeStorageSync:key=>store.delete(key)};
  const service = loadService('services/recognition-evidence-sync.ts', {wx,modules:{
    './session-scope':scope, './api':{api, captureSessionIdentity:()=>({token:'t',generation}), isCurrentSession:i=>i.generation === generation},
  }});
  return {...service, api, posts, store, scope, setVersion:v=>{version=v;}, setRemote:v=>{remote=v;},
    setOffline:v=>{offline=v;}, setReject:v=>{rejectNew=v;}, setWritesFail:v=>{failWrites=v;},
    setPhotoBatch:v=>{photoBatch=v;}, setAck:v=>{acknowledged=v;}, setGeneration:v=>{generation=v;}, receipt};
}
async function pending(h) { assert.equal((await h.queueRecognitionEvidence('m', initial())).status, 'pending'); h.setOffline(false); h.setVersion(2); }

test('explicit review first retries the original intent, then confirms and sends only a durably backed-up rebase', async () => {
  const h = harness(); await pending(h);
  const preview = await h.prepareRecognitionEvidenceRecovery('m');
  assert.equal(preview.status, 'ready'); assert.equal(preview.oldMedicineVersion, 1); assert.equal(preview.currentMedicineVersion, 2);
  assert.equal(h.posts[1].idempotencyKey, 'original-request-key-001');
  let backedUp = false; const save = h.api.saveRecognitionEvidence;
  h.api.saveRecognitionEvidence = async (id, body) => {
    if (body.medicineVersion === 2) {
      const record = h.getPendingRecognitionEvidence('m');
      assert.equal(record.payload.idempotencyKey, body.idempotencyKey);
      assert.deepEqual(JSON.parse(JSON.stringify(record.previousPayloads[0])), initial()); backedUp = true;
    }
    return save(id, body);
  };
  const result = await h.confirmRecognitionEvidenceRecovery('m');
  assert.equal(result.status, 'synced'); assert.equal(backedUp, true); assert.notEqual(h.posts[2].idempotencyKey, h.posts[1].idempotencyKey);
  const {idempotencyKey, medicineVersion, ...unchanged} = h.posts[2];
  const {idempotencyKey: oldKey, medicineVersion: oldVersion, ...original} = initial();
  assert.equal(medicineVersion, 2); assert.deepEqual(unchanged, original); assert.ok(idempotencyKey && oldKey && oldVersion);
  assert.equal(h.getPendingRecognitionEvidence('m'), null);
});
test('new rejection or conflict retains both immutable intents', async () => {
  for (const status of [400,409]) {
    const h = harness(); await pending(h); assert.equal((await h.prepareRecognitionEvidenceRecovery('m')).status, 'ready');
    h.setReject(status); const result = await h.confirmRecognitionEvidenceRecovery('m'); assert.equal(result.status, 'pending');
    const record = h.getPendingRecognitionEvidence('m'); assert.equal(record.payload.medicineVersion, 2);
    assert.equal(record.previousPayloads[0].idempotencyKey, 'original-request-key-001');
  }
});
test('storage failure and changed identity prevent sending the new intent and preserve the old household record', async () => {
  for (const mode of ['storage','identity']) {
    const h = harness(); await pending(h); assert.equal((await h.prepareRecognitionEvidenceRecovery('m')).status, 'ready');
    if (mode === 'storage') h.setWritesFail(true);
    else { h.scope.writeSessionScope({userId:'u',familyId:'b'}); h.setGeneration(2); }
    const result = await h.confirmRecognitionEvidenceRecovery('m'); assert.notEqual(result.status, 'synced');
    assert.equal(h.posts.length, 2);
    if (mode === 'identity') h.scope.writeSessionScope({userId:'u',familyId:'a'});
    assert.equal(h.getPendingRecognitionEvidence('m').payload.idempotencyKey, 'original-request-key-001');
  }
});
test('old receipt already applied but stale is identified and remains inspectable', async () => {
  const h = harness(); await pending(h); h.setAck(true);
  const result = await h.prepareRecognitionEvidenceRecovery('m'); assert.equal(result.status, 'acknowledged');
  assert.equal(h.posts.length, 2); assert.equal(h.getPendingRecognitionEvidence('m').payload.photos[0].fields.name, '合成药');
  assert.ok(h.getPendingRecognitionEvidence('m').acknowledgement);
  assert.notEqual((await h.confirmRecognitionEvidenceRecovery('m')).status, 'synced');
});
test('a stale original POST acknowledgement may clear only when the latest document still matches it', async () => {
  const h = harness(); await pending(h); h.setAck(true);
  h.setRemote(h.receipt(initial(), {stale:true}));
  const result = await h.prepareRecognitionEvidenceRecovery('m');
  assert.equal(result.status, 'synced'); assert.equal(result.reason, 'stale'); assert.equal(h.getPendingRecognitionEvidence('m'), null);
  const other = harness(); await pending(other); other.setAck(true);
  other.setRemote(other.receipt(initial(), {stale:true, revision:2}));
  assert.equal((await other.prepareRecognitionEvidenceRecovery('m')).status, 'acknowledged');
  assert.ok(other.getPendingRecognitionEvidence('m'));
});
test('remote source revision changes or photo batch mismatch block any rebase', async () => {
  for (const mode of ['revision','batch']) {
    const h = harness(); await pending(h);
    if (mode === 'revision') h.setRemote({ ...h.receipt(initial()), revision: 1 });
    else h.setPhotoBatch('other-batch');
    const result = await h.prepareRecognitionEvidenceRecovery('m'); assert.equal(result.status, 'blocked');
    assert.equal(h.posts.length, 2); assert.equal(h.getPendingRecognitionEvidence('m').payload.medicineVersion, 1);
  }
});
test('a household switch during review stops before dispatching later reads', async () => {
  const h = harness(); await pending(h); let resolveMedicine, photoCalls = 0;
  h.api.getMedicine = () => new Promise(resolve => { resolveMedicine = resolve; });
  h.api.listLeafletPhotos = async () => { photoCalls++; return {photos:[]}; };
  const preparing = h.prepareRecognitionEvidenceRecovery('m');
  while (!resolveMedicine) await new Promise(resolve => setImmediate(resolve));
  h.scope.writeSessionScope({userId:'u',familyId:'b'}); h.setGeneration(2);
  resolveMedicine({id:'m',name:'合成药',version:2,batches:[]});
  assert.equal((await preparing).status, 'identity_changed'); assert.equal(photoCalls, 0);
});
test('hiding the page invalidates an in-progress review and clears the temporary proof only', async () => {
  const h = harness(); await pending(h); let resolveMedicine, photoCalls = 0;
  h.api.getMedicine = () => new Promise(resolve => { resolveMedicine = resolve; });
  h.api.listLeafletPhotos = async () => { photoCalls++; return {photos:[]}; };
  const preparing = h.prepareRecognitionEvidenceRecovery('m');
  while (!resolveMedicine) await new Promise(resolve => setImmediate(resolve));
  h.clearRecognitionEvidenceRecoveryProofs(); resolveMedicine({id:'m',name:'合成药',version:2,batches:[]});
  assert.equal((await preparing).status,'identity_changed'); assert.equal(photoCalls,0);
  assert.equal(h.getPendingRecognitionEvidence('m').payload.idempotencyKey,'original-request-key-001');
  assert.notEqual((await h.confirmRecognitionEvidenceRecovery('m')).status,'synced');
});
test('clearing a completed review proof leaves the durable intent intact and disables confirmation', async () => {
  const h = harness(); await pending(h); assert.equal((await h.prepareRecognitionEvidenceRecovery('m')).status,'ready');
  h.clearRecognitionEvidenceRecoveryProofs();
  assert.notEqual((await h.confirmRecognitionEvidenceRecovery('m')).status,'synced');
  assert.equal(h.posts.length,2); assert.equal(h.getPendingRecognitionEvidence('m').payload.medicineVersion,1);
});
test('missing originals or changed batch prevent recovery review', async () => {
  for (const mode of ['photo','batch','current']) {
    const h = harness(); await pending(h);
    if (mode === 'photo') h.api.listLeafletPhotos = async () => ({photos:[]});
    if (mode === 'batch') h.api.getMedicine = async () => ({id:'m',name:'合成药',version:2,batches:[]});
    if (mode === 'current') h.api.getMedicine = async () => ({id:'m',version:2,batches:[{id:'batch-1',version:2,expiry:{value:'2030-01',precision:'month'}}]});
    const result = await h.prepareRecognitionEvidenceRecovery('m');
    assert.equal(result.status,'blocked'); assert.equal(result.reason, mode === 'photo' ? 'photo_unavailable' : mode === 'batch' ? 'batch_unavailable' : 'current_unavailable');
    assert.equal(h.posts.length,2); assert.ok(h.getPendingRecognitionEvidence('m'));
  }
});
test('changing medicine or source after review invalidates the confirmation before any new POST', async () => {
  for (const mode of ['medicine','source']) {
    const h = harness(); await pending(h); assert.equal((await h.prepareRecognitionEvidenceRecovery('m')).status,'ready');
    if (mode === 'medicine') h.setVersion(3); else h.setRemote(h.receipt(initial(),{revision:1}));
    const result = await h.confirmRecognitionEvidenceRecovery('m'); assert.equal(result.status,'pending');
    assert.equal(result.reason,mode === 'medicine' ? 'version_changed' : 'source_changed');
    assert.equal(h.posts.length,2); assert.equal(h.getPendingRecognitionEvidence('m').payload.medicineVersion,1);
  }
});
test('identity change during the new POST keeps both intents in the original household', async () => {
  const h = harness(); await pending(h); assert.equal((await h.prepareRecognitionEvidenceRecovery('m')).status,'ready');
  let resolvePost;
  h.api.saveRecognitionEvidence = (_id,body) => new Promise(resolve => { resolvePost = () => resolve({evidence:h.receipt(body)}); });
  const confirming = h.confirmRecognitionEvidenceRecovery('m');
  while (!resolvePost) await new Promise(resolve => setImmediate(resolve));
  h.scope.writeSessionScope({userId:'u',familyId:'b'}); h.setGeneration(2); resolvePost();
  assert.equal((await confirming).status,'identity_changed'); assert.equal(h.getPendingRecognitionEvidence('m'),null);
  h.scope.writeSessionScope({userId:'u',familyId:'a'});
  const record = h.getPendingRecognitionEvidence('m'); assert.equal(record.payload.medicineVersion,2);
  assert.equal(record.previousPayloads[0].medicineVersion,1);
});
test('a matching POST with historical stale content is saved with warning, and a later intent can be queued', async () => {
  const h = harness(); h.setOffline(false); h.setAck(true);
  h.setRemote(h.receipt(initial(), {stale:true}));
  const result = await h.queueRecognitionEvidence('m', initial());
  assert.equal(result.status, 'synced'); assert.equal(result.reason, 'stale'); assert.equal(h.getPendingRecognitionEvidence('m'), null);
  h.setAck(false); h.setOffline(true);
  assert.equal((await h.queueRecognitionEvidence('m', {...initial(), idempotencyKey:'second-request-key-002'})).status, 'pending');
});
test('a stale POST acknowledgement does not discard an older intent after a different source revision', async () => {
  const h = harness(); h.setOffline(false); h.setAck(true);
  h.setRemote(h.receipt(initial(), {stale:false, revision:2, photos:[]}));
  const result = await h.queueRecognitionEvidence('m', initial());
  assert.equal(result.status, 'pending');
  assert.equal(result.acknowledged, true);
  assert.equal(h.getPendingRecognitionEvidence('m').payload.photos[0].fields.name, '合成药');
});
