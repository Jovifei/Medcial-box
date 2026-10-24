import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { loadPage, makePageContext } from './runtime.mjs';
import { harness, edit } from './photo-queue-test-harness.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; }
function fixture(pagePath, api) {
  const {definition}=loadPage(pagePath,{modules:{
    '../../services/api':{api, ApiError:class ApiError extends Error{}, readToken:()=> 'synthetic-token'},
    '../../services/auth':{ensureLoggedIn:async()=>{}},
  }});
  return makePageContext(definition);
}
test('pending and restock ignore same-session out-of-order responses',async()=>{
  for(const [route,method,result,read] of [
    ['pages/pending/pending.ts','getPendingNotifications',name=>({items:[{id:name}]}),page=>page.data.items[0].id],
    ['pages/restock/restock.ts','listRestockItems',name=>({items:[{id:name,status:'needed',desiredQuantity:null,unit:'box'}]}),page=>page.data.items[0].id],
  ]){
    const replies=[];
    const page=fixture(route,{[method]:()=>{const gate=deferred();replies.push(gate);return gate.promise;}});
    const older=page.refresh();await tick();
    const newer=page.refresh();await tick();
    assert.equal(replies.length,2,route);
    replies[1].resolve(result('newer'));await newer;
    replies[0].resolve(result('older'));await older;
    assert.equal(read(page),'newer',route);
    assert.equal(page.data.loading,false);
  }
});
test('stocktake keeps an unsubmitted selection when batch version is unchanged, resets on conflict',async()=>{
  let version=4;
  const build=()=>({id:'synthetic-s',status:'open',startedAt:'2026-10-23T00:00:00Z',items:[
    {batchId:'b-1',medicineId:'m-1',medicineName:'合成药',quantity:2,unit:'box',version,result:'pending'},
  ]});
  const page=fixture('pages/stocktake/stocktake.ts',{getCurrentStocktake:async()=>({stocktake:build()})});
  page.applySession(build());
  page.onQuantityInput({currentTarget:{dataset:{index:'0'}},detail:{value:'6'}});
  await page.refresh();
  assert.equal(page.data.items[0].outcome,'adjusted');
  assert.equal(page.data.items[0].adjustedQuantity,'6');
  version=5;
  await page.refresh();
  assert.equal(page.data.items[0].outcome,'deferred');
  assert.equal(page.data.items[0].version,5);
});
test('home only applies latest inventory, and old cover context cannot refill after change',async()=>{
  const requests=[];
  const medicine=name=>({id:name,name,brand:null,specification:null,manufacturer:null,approvalNumber:null,
    activeIngredients:[],purposeCategory:null,populationTags:[],purposeTags:[],batches:[],
    leaflet:{reviewStatus:'unverified',purposeSummary:null},stockStatus:{state:'unknown'},
    expiryState:{state:'unknown',label:'未知'},isArchived:false,coverPhotoId:null});
  const page=fixture('pages/index/index.ts',{
    getCurrentFamily:async()=>({family:{name:'合成家庭'}}),
    listMedicines:()=>{const d=deferred();requests.push(d);return d.promise;},
  });
  const a=page.refresh();await tick();
  const b=page.refresh();await tick();
  assert.equal(requests.length,2);
  requests[1].resolve({medicines:[medicine('newer')]});await b;
  requests[0].resolve({medicines:[medicine('older')]});await a;
  assert.equal(page.data.allItems[0].name,'newer');
});
test('edit with an attached photo_pending draft updates medicine before retrying photos',async()=>{
  let fail=true;
  const writes=[];
  const h=harness({
    update:(result,id,payload)=>{writes.push({id,version:payload.version,name:payload.name,manufacturer:payload.manufacturer});return result;},
    upload:result=>fail?Promise.reject(Error('synthetic image failure')):result,
  });
  const draft=h.draft('edit-pending','photo_pending');
  draft.medicineId='existing-medicine';
  const photoScope=h.scope.scopedStorageKey('medicine-photo-drafts','existing-medicine');
  const editScope=h.scope.scopedStorageKey('medicine-edit-draft','existing-medicine');
  for(const photo of draft.photos)photo.ownedLocal.scopeKey=photoScope;
  h.seed([draft]);h.storage.set(photoScope,structuredClone([draft]));
  h.attach(h.a,[draft],draft.id);
  h.a.photoScopeKey=photoScope;
  h.a.draftStorageKey=editScope;
  h.a.setData({isEdit:true,medicineId:'existing-medicine',version:4});
  edit(h.a,'name','更新药名');
  await h.a.onSubmit();
  assert.equal(writes.length,1);
  assert.equal(writes[0].name,'更新药名');
  assert.equal(h.a.data.version,5);
  fail=false;
  edit(h.a,'manufacturer','新厂家');
  await h.a.onSubmit();
  assert.equal(writes.length,2);
  assert.equal(writes[1].version,5);
  assert.equal(writes[1].manufacturer,'新厂家');
  assert.equal(h.calls.create,0);
});

test('cross-family pending result never refills the next household after session generation changes',async()=>{
  let actor='family-A',generation=1;
  const requests=[];
  const {definition}=loadPage('pages/pending/pending.ts',{modules:{
    '../../services/api':{
      api:{getPendingNotifications:()=>{const d=deferred();requests.push(d);return d.promise;}},
      ApiError:class ApiError extends Error{},
      captureSessionIdentity:()=>({token:actor,generation}),
      isCurrentSession:identity=>identity.token===actor&&identity.generation===generation,
    },
    '../../services/auth':{ensureLoggedIn:async()=>{}},
  }});
  const page=makePageContext(definition);
  const old=page.refresh();await tick();
  actor='family-B';generation++;
  const latest=page.refresh();await tick();
  requests[0].resolve({items:[{id:'family-A-private'}]});await old;
  assert.equal(page.data.items.some(item=>item.id==='family-A-private'),false);
  requests[1].resolve({items:[{id:'family-B-safe'}]});await latest;
  assert.equal(page.data.items[0].id,'family-B-safe');
});
test('successful family leave navigates despite the deliberate session generation rollover',async()=>{
  let generation=1;
  let scopeActive=true;
  const routes=[];
  const {definition}=loadPage('pages/family-settings/family-settings.ts',{
    modules:{
      '../../services/api':{
        api:{leaveFamily:async()=>{generation++;scopeActive=false;},
          getCurrentFamily:async()=>({family:{name:'synthetic-family',role:'member',members:[]}}),
          getFamilyInventorySettings:async()=>({settings:{stocktakeInterval:'monthly'}})},
        ApiError:class ApiError extends Error{},
        captureSessionIdentity:()=>({token:'same-user',generation}),
        isCurrentSession:value=>value.token==='same-user'&&value.generation===generation,
      },
      '../../services/auth':{ensureLoggedIn:async()=>{}},
      '../../services/session-scope':{scopedStorageKey:name=>scopeActive?name+':synthetic':null},
    },
    wx:{reLaunch:options=>routes.push(options.url)},
  });
  const page=makePageContext(definition);
  await page.refresh();
  await page.onLeaveFamily();
  assert.deepEqual(routes,['/pages/family-entry/family-entry']);
});

test('existing pending A items clear synchronously before family B async load completes',async()=>{
  let actor='A',generation=1;
  const response=deferred();
  const {definition}=loadPage('pages/pending/pending.ts',{modules:{
    '../../services/api':{
      api:{getPendingNotifications:()=>actor==='A'?Promise.resolve({items:[{id:'A-private'}]}):response.promise},
      ApiError:class ApiError extends Error{},
      captureSessionIdentity:()=>({token:actor,generation}),
      isCurrentSession:id=>id.token===actor&&id.generation===generation,
    },
    '../../services/auth':{ensureLoggedIn:async()=>{}},
  }});
  const page=makePageContext(definition);
  await page.refresh();
  assert.equal(page.data.items[0].id,'A-private');
  actor='B';generation++;
  const next=page.refresh();
  assert.equal(page.data.items.length,0,'cross-family transition must blank previous private view without waiting for network');
  response.resolve({items:[{id:'B-current'}]});
  await next;
  assert.equal(page.data.items[0].id,'B-current');
});
test('restock deletion confirmation from old household cannot dispatch under a newer session',async()=>{
  let actor='A',generation=1,completeDialog;
  let mutations=0;
  const {definition}=loadPage('pages/restock/restock.ts',{
    modules:{
      '../../services/api':{
        api:{deleteRestockItem:async()=>{mutations++;}},
        ApiError:class ApiError extends Error{},
        captureSessionIdentity:()=>({token:actor,generation}),
        isCurrentSession:id=>id.token===actor&&id.generation===generation,
      },
      '../../services/auth':{ensureLoggedIn:async()=>{}},
    },
    wx:{showModal:options=>{completeDialog=options.success;}},
  });
  const page=makePageContext(definition);
  const action=page.onDelete({currentTarget:{dataset:{id:'A-restock'}}});
  await tick();
  actor='B';generation++;
  completeDialog({confirm:true});
  await action;
  assert.equal(mutations,0,'old confirmation must not write B household');
});


test('C2C-01 photo_pending second edit reuses ACK batch identities/versions, never INSERTs the new batch twice',async()=>{
  let uploadFails=true;
  const updates=[];
  const batch=(id,version)=>({id,version,expiry:{value:null,precision:'unknown'},quantity:null,
    unit:'box',confirmedUnitsPerPackage:null,conversionUnit:null,storageLocation:null,
    lotNumber:null,openedState:'unknown',openedAt:null,afterOpeningLimit:null});
  const h=harness({
    update:(_result,id,payload)=>{
      updates.push(structuredClone(payload));
      const next=updates.length;
      return {id,version:payload.version+1,
        batches:[batch('existing-batch',7+next),batch('saved-new-batch',next)],
        batchSaveReceipts:[{index:0,id:'existing-batch',version:7+next},
          {index:1,id:'saved-new-batch',version:next}]};
    },
    upload:result=>uploadFails?Promise.reject(Error('synthetic upload unavailable')):result,
  });
  const draft=h.draft('two-batches','photo_pending');
  draft.medicineId='existing-medicine';
  const photoScope=h.scope.scopedStorageKey('medicine-photo-drafts','existing-medicine');
  for(const photo of draft.photos)photo.ownedLocal.scopeKey=photoScope;
  h.seed([draft]);h.storage.set(photoScope,structuredClone([draft]));h.attach(h.a,[draft],draft.id);
  h.a.photoScopeKey=photoScope;
  h.a.draftStorageKey=h.scope.scopedStorageKey('medicine-edit-draft','existing-medicine');
  const initial=h.a.data.batches[0];
  h.a.setData({isEdit:true,medicineId:'existing-medicine',version:4,
    batches:[{...initial,id:'existing-batch',version:7},
      {...initial,id:null,version:null,draftKey:'unsaved-new-batch',lotNumber:'new-lot'}]});
  await h.a.onSubmit();
  assert.equal(updates.length,1);
  assert.equal(h.a.data.version,5);
  assert.equal(h.a.data.batches[0].version,8);
  assert.equal(h.a.data.batches[1].id,'saved-new-batch');
  assert.equal(h.a.data.batches[1].version,1);
  uploadFails=false;
  await h.a.onSubmit();
  assert.equal(updates.length,2);
  assert.equal(updates[1].version,5);
  assert.deepEqual(updates[1].batches.map(x=>[x.id,x.version]),
    [['existing-batch',8],['saved-new-batch',1]]);
  assert.equal(h.calls.create,0);
});
