import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPage, makePageContext, makeSessionScopeModule } from './runtime.mjs';

const deferred = () => { let resolve; let reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const flush = async () => { for (let n=0;n<8;n++) await Promise.resolve(); };
function fixture() {
  const storage = new Map(); const posts=[]; const navigations=[]; const toasts=[];
  const scope=makeSessionScopeModule({userId:'user-a',familyId:'family-a'});
  let generation=1; let login=async()=>{}; let create=async p=>({planId:'plan-1',careProfileId:p.careProfileId,status:'active',version:1});
  let profiles=async()=>({careProfiles:[{id:'profile-a',displayName:'本人',canManage:true}]});
  let failWrite=false; let failRemove=false; let failDraftRemove=false;
  class ApiError extends Error {}
  const identity=()=>({token:'synthetic',generation});
  const apiModule={ApiError,captureSessionIdentity:identity,isCurrentSession:i=>i.generation===generation,staleSessionError:()=>new ApiError('登录状态已变更'),api:{
    listCareProfiles:()=>profiles(),listMedicines:async()=>({medicines:[]}),ensureSelfCareProfile:async()=>{},
    createMedicationPlan:async p=>{posts.push(structuredClone(p));return create(p);},
  }};
  const modules={'../../services/api':apiModule,'../../services/auth':{ensureLoggedIn:()=>login()},'../../services/session-scope':scope};
  const wx={getStorageSync:k=>structuredClone(storage.get(k)),setStorageSync:(k,v)=>{if(failWrite)throw Error('disk full');storage.set(k,structuredClone(v));},removeStorageSync:k=>{if(failRemove || (failDraftRemove && k.startsWith('plan-create-draft:')))throw Error('cleanup failed');storage.delete(k);},showToast:o=>toasts.push(o.title),switchTab:o=>navigations.push(o.url)};
  function page(){return makePageContext(loadPage('pages/plan-create/plan-create.ts',{modules,wx}).definition);}
  async function ready(){const p=page();p.onLoad({});await flush();p.setData({medicineName:'合成药品',dosageText:'用户填写的记录',timeSlots:['08:00'],startDate:'2026-10-03'});return p;}
  return {ready,page,storage,posts,navigations,toasts,scope,setLogin:v=>{login=v;},setCreate:v=>{create=v;},setProfiles:v=>{profiles=v;},changeIdentity:()=>{generation++;},setFailWrite:v=>{failWrite=v;},setFailRemove:v=>{failRemove=v;},setFailDraftRemove:v=>{failDraftRemove=v;}};
}

test('lost accepted response: explicit retry sends original stable key, never duplicates logical create',async()=>{
 const f=fixture();const p=await f.ready();let accepted;f.setCreate(async payload=>{if(!accepted){accepted=payload;throw Error('response lost');}return {planId:'same-plan',careProfileId:payload.careProfileId,status:'active',version:1};});
 await p.onSubmitPlan();await p.onSubmitPlan();assert.equal(f.posts.length,2);assert.match(f.posts[0].idempotencyKey??'',/^[A-Za-z0-9_-]{16,128}$/);assert.deepEqual(f.posts[1],f.posts[0]);assert.equal(f.navigations.length,1);
});
test('changed form cannot silently submit a new intent while original result is uncertain',async()=>{
 const f=fixture();const p=await f.ready();f.setCreate(async()=>{throw Error('response lost');});await p.onSubmitPlan();p.setData({medicineName:'changed'});await p.onSubmitPlan();assert.equal(f.posts.length,1);assert.ok(f.toasts.some(t=>/原|核对|重试/.test(t)));
});
test('original uncertain operation survives unload and remount without automatic writes',async()=>{
 const f=fixture();let p=await f.ready();f.setCreate(async()=>{throw Error('response lost');});await p.onSubmitPlan();p.onUnload();p=await f.ready();assert.equal(f.posts.length,1);assert.equal(p.data.pendingCreation,true);await p.onRetryPlan();assert.equal(f.posts.length,2);assert.deepEqual(f.posts[1],f.posts[0]);
});
test('discarding form cannot delete uncertain operation identity',async()=>{
 const f=fixture();let p=await f.ready();f.setCreate(async()=>{throw Error('response lost');});await p.onSubmitPlan();p.onLeaveChoice({currentTarget:{dataset:{choice:'discard'}}});p.onUnload();p=await f.ready();await p.onRetryPlan();assert.equal(f.posts.length,2);assert.deepEqual(f.posts[1],f.posts[0]);
});
test('storage failure before first send fails closed',async()=>{
 const f=fixture();const p=await f.ready();f.setFailWrite(true);await p.onSubmitPlan();assert.equal(f.posts.length,0);assert.equal(f.navigations.length,0);
});
test('ACK survives draft cleanup failure and subsequent submit never sends another create',async()=>{
 const f=fixture();const p=await f.ready();f.setFailRemove(true);await p.onSubmitPlan();assert.equal(f.navigations.length,1);await p.onSubmitPlan();assert.equal(f.posts.length,1);assert.ok(f.toasts.includes('计划已保存'));
});
test('session changes during awaited login cannot dispatch old form',async()=>{
 const f=fixture();const p=await f.ready();const gate=deferred();f.setLogin(()=>gate.promise);const pending=p.onSubmitPlan();f.changeIdentity();gate.resolve();await pending;assert.equal(f.posts.length,0);assert.equal(f.navigations.length,0);
});
test('family changes during awaited login cannot dispatch old form',async()=>{
 const f=fixture();const p=await f.ready();const gate=deferred();f.setLogin(()=>gate.promise);const pending=p.onSubmitPlan();f.scope.writeSessionScope({userId:'user-a',familyId:'family-b'});gate.resolve();await pending;assert.equal(f.posts.length,0);
});
test('old page cannot navigate after ACK when family changed',async()=>{
 const f=fixture();const p=await f.ready();const gate=deferred();f.setCreate(()=>gate.promise);const pending=p.onSubmitPlan();await flush();assert.equal(f.posts.length,1);f.scope.writeSessionScope({userId:'user-a',familyId:'family-b'});gate.resolve({planId:'plan-a'});await pending;assert.equal(f.navigations.length,0);assert.equal(f.toasts.length,0);
});
test('disposed page does not dispatch after login resolves',async()=>{
 const f=fixture();const p=await f.ready();const gate=deferred();f.setLogin(()=>gate.promise);const pending=p.onSubmitPlan();p.onUnload();gate.resolve();await pending;assert.equal(f.posts.length,0);
});
test('old bootstrap profile response cannot start follow-on reads or mutate current page',async()=>{
 const f=fixture();const gate=deferred();f.setProfiles(()=>gate.promise);const p=f.page();p.onLoad({});await flush();f.changeIdentity();gate.resolve({careProfiles:[{id:'foreign-old',canManage:true}]});await flush();assert.equal(p.data.careProfiles.length,0);
});
test('pending operation is scoped separately from new family intent',async()=>{
 const f=fixture();let p=await f.ready();f.setCreate(async()=>{throw Error('response lost');});await p.onSubmitPlan();p.onUnload();f.scope.writeSessionScope({userId:'user-a',familyId:'family-b'});f.changeIdentity();p=await f.ready();assert.equal(p.data.pendingCreation,false);await p.onSubmitPlan();assert.equal(f.posts.length,2);assert.notEqual(f.posts[1].idempotencyKey,f.posts[0].idempotencyKey);
});
test('current non-manager cannot dispatch plan creation',async()=>{
 const f=fixture();f.setProfiles(async()=>({careProfiles:[{id:'profile-a',displayName:'只读',canManage:false}]}));const p=await f.ready();await p.onSubmitPlan();assert.equal(f.posts.length,0);
});

test('malformed success keeps original durable operation for explicit retry',async()=>{
 const f=fixture();let p=await f.ready();f.setCreate(async()=>({planId:'plan-1'}));await p.onSubmitPlan();assert.equal(f.navigations.length,0);p.onUnload();p=await f.ready();await p.onRetryPlan();assert.deepEqual(f.posts[1],f.posts[0]);
});
test('hidden page cannot navigate after ACK or dispatch after awaiting login',async()=>{
 for(const stage of ['login','post']) {const f=fixture();const p=await f.ready();const gate=deferred();if(stage==='login')f.setLogin(()=>gate.promise);else f.setCreate(()=>gate.promise);const pending=p.onSubmitPlan();await flush();p.onHide();gate.resolve({planId:'plan-1',careProfileId:'profile-a',status:'active',version:1});await pending;assert.equal(f.posts.length,stage==='login'?0:1);assert.equal(f.navigations.length,0);}
});
test('overlapping explicit saves and update guard coalesce one dispatch',async()=>{
 const f=fixture();const p=await f.ready();const gate=deferred();f.setCreate(()=>gate.promise);const first=p.submitPlan();const second=p.submitPlan();await flush();assert.equal(f.posts.length,1);gate.resolve({planId:'plan-1',careProfileId:'profile-a',status:'active',version:1});await Promise.all([first,second]);
});
test('original explicit retry ignores changed form and preserves exact original payload',async()=>{
 const f=fixture();const p=await f.ready();f.setCreate(async()=>{throw Error('response lost');});await p.onSubmitPlan();p.setData({medicineName:'changed',timeSlots:['09:00']});await p.onRetryPlan();assert.deepEqual(f.posts[1],f.posts[0]);
});
test('late ACK for an old intent never deletes or replaces a newer pending operation',async()=>{
 const f=fixture();const p=await f.ready();const gate=deferred();f.setCreate(()=>gate.promise);const first=p.onSubmitPlan();await flush();const key=[...f.storage.keys()].find(k=>k.startsWith('plan-create-operation:'));const newer=structuredClone(f.storage.get(key));newer.payload.idempotencyKey='newer-operation-123456';newer.payload.medicineName='new intent';f.storage.set(key,newer);gate.resolve({planId:'plan-1',careProfileId:'profile-a',status:'active',version:1});await first;assert.deepEqual(f.storage.get(key),newer);
});
test('old explicit retry refuses a newer operation instead of replaying its different intent',async()=>{
 const f=fixture();const p=await f.ready();f.setCreate(async()=>{throw Error('response lost');});await p.onSubmitPlan();const key=[...f.storage.keys()].find(k=>k.startsWith('plan-create-operation:'));const newer=structuredClone(f.storage.get(key));newer.payload.idempotencyKey='newer-operation-123456';f.storage.set(key,newer);await p.onRetryPlan();assert.equal(f.posts.length,1);
});
test('corrupt stored operation fails closed rather than dropping its uncertain key',async()=>{
 const f=fixture();f.storage.set('plan-create-operation:user-a:family-a:new',{payload:{idempotencyKey:'truncated'}});const p=await f.ready();await p.onSubmitPlan();assert.equal(f.posts.length,0);
});
test('unload still invalidates page when ordinary draft persistence fails',async()=>{
 const f=fixture();const p=await f.ready();p.dirty=true;f.setFailWrite(true);p.onUnload();f.setFailWrite(false);await p.onSubmitPlan();assert.equal(f.posts.length,0);
});
test('returning to a hidden form permits explicit retry after interrupted login',async()=>{
 const f=fixture();const p=await f.ready();const gate=deferred();f.setLogin(()=>gate.promise);const pending=p.onSubmitPlan();p.onHide();gate.resolve();await pending;assert.equal(f.posts.length,0);f.setLogin(async()=>{});p.onShow();await flush();assert.equal(p.data.creating,false);await p.onSubmitPlan();assert.equal(f.posts.length,1);
});

test('partial ACK cleanup retains receipt until saved draft cannot reappear as a new create',async()=>{
 const f=fixture();let p=await f.ready();p.updateDirtyState();f.setFailDraftRemove(true);await p.onSubmitPlan();assert.equal(f.posts.length,1);assert.equal(f.navigations.length,1);p.onUnload();p=f.page();p.onLoad({});await flush();assert.equal(p.data.pendingCreation,true);assert.equal(p.data.creationAcknowledged,true);p.onRestoreDraft();f.setFailDraftRemove(false);await p.onSubmitPlan();assert.equal(f.posts.length,1);assert.equal([...f.storage.keys()].some(k=>k.startsWith('plan-create-draft:')),false);
});

test('known in-memory ACK cannot regress to pending when ACK persistence itself fails',async()=>{
 const f=fixture();const p=await f.ready();f.setCreate(async payload=>{f.setFailWrite(true);return {planId:'plan-1',careProfileId:payload.careProfileId,status:'active',version:1};});await p.onSubmitPlan();assert.equal(f.posts.length,1);p.onHide();p.onShow();await flush();f.setFailWrite(false);await p.onRetryPlan();assert.equal(f.posts.length,1);
});
test('retry handler without a pending operation never starts a new creation',async()=>{
 const f=fixture();const p=await f.ready();await p.onRetryPlan();assert.equal(f.posts.length,0);
});
