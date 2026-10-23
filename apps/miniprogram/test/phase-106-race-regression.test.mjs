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
  h.seed([draft]);h.attach(h.a,[draft],draft.id);
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
