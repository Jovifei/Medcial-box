import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { loadPage, loadService, makePageContext, makeSessionScopeModule } from './runtime.mjs';

function pageHarness({writeBehavior, closeBehavior, storeBehavior, recognizeBehavior, chooseBehavior, unlinkBehavior, modalBehavior} = {}) {
  const scope = makeSessionScopeModule({userId:'review-user',familyId:'review-family'});
  const key = scope.scopedStorageKey('medicine-photo-drafts');
  const storage = new Map();
  const files = new Map();
  const fds = new Map();
  const calls = {open:0,write:0,close:0,unlink:0,recognize:0,create:0,choose:0};
  const fs = {
    readFile: o => o.success({data:'/9j/2Q=='}),
    open: o => {
      calls.open++;
      assert.equal(o.flag,'wx');
      if (files.has(o.filePath)) return o.fail({errMsg:'exists'});
      files.set(o.filePath,new Uint8Array(0));
      const fd = `review-fd-${calls.open}`; fds.set(fd,o.filePath); o.success({fd});
    },
    write: o => {
      calls.write++;
      const receipt = JSON.parse(storage.get(key)).some(d=>d.photos.some(p=>p.path===fds.get(o.fd)&&p.ownedLocal?.state==='reserved'));
      assert.equal(receipt,true,'durable reservation must precede real synthetic bytes');
      const finish = (count=o.data.byteLength) => { files.set(fds.get(o.fd),new Uint8Array(o.data).slice(0,count)); o.success({bytesWritten:count}); };
      if (writeBehavior) writeBehavior(o,finish,calls); else finish();
    },
    close: o => {calls.close++; if(closeBehavior) closeBehavior(o); else {fds.delete(o.fd);o.success({});}},
    unlink: o => {calls.unlink++; const finish=()=>{if(files.delete(o.filePath)) o.success({}); else o.fail({errMsg:'ENOENT'});}; if(unlinkBehavior) unlinkBehavior(o,finish); else finish();},
  };
  const options = {
    setTimeoutFn:()=>{},
    modules:{'session-scope':scope,'../../services/auth':{ensureLoggedIn:async()=>{}},'../../services/api':{ApiError:class extends Error{},api:{
      recognizeMedicine:async()=>{calls.recognize++;const result={warnings:[],draft:{name:null,specification:null,manufacturer:null,approvalNumber:null,purposeCategory:null}};return recognizeBehavior ? recognizeBehavior(result) : result;},
      createMedicine:async()=>{calls.create++;return {id:'review-medicine',batches:[]};},
    }}},
    wx:{showModal:options=>modalBehavior?modalBehavior(options):options.success({confirm:true}),env:{USER_DATA_PATH:'/review-owned'},getSystemInfoSync:()=>({SDKVersion:'3.17.3'}),base64ToArrayBuffer:()=>Uint8Array.from([1,2,3,4]).buffer,
      chooseMedia:async()=>{calls.choose++;if(chooseBehavior)return chooseBehavior();return {tempFiles:[{tempFilePath:'/review-temp.jpg',size:4}]};},getFileSystemManager:()=>fs,
      getStorageSync:k=>storage.has(k)?JSON.parse(storage.get(k)):undefined,
      setStorageSync:(k,v)=>{storeBehavior?.(k,v);storage.set(k,JSON.stringify(v));},removeStorageSync:k=>storage.delete(k)},
  };
  const {definition}=loadPage('pages/medicine-edit/medicine-edit.ts',options);
  const newPage=()=>{const page=makePageContext(definition);page.photoScopeKey=key;page.draftStorageKey=scope.scopedStorageKey('medicine-edit-draft');page.data.name='Synthetic review medicine';return page;};
  return {page:newPage(),newPage,scope,key,storage,files,fds,calls};
}

test('regression: repeated capture must not append to an incomplete reserved draft',async()=>{
  const h=pageHarness({writeBehavior:(o,finish)=>finish(1)});
  await h.page.onRecognizePhoto('camera');
  assert.match(h.page.data.recognitionHint,/删除.*重拍/);
  await new Promise(r=>setTimeout(r,2));
  await h.page.onRecognizePhoto('camera');
  assert.equal(h.calls.open,1,'retry must stop before another owned original is opened');
  assert.equal(h.calls.write,1);
  assert.equal(h.calls.choose,1);
});

test('regression: successful retry must not conceal an older incomplete original',async()=>{
  const h=pageHarness({writeBehavior:(o,finish,calls)=>finish(calls.write===1?1:4)});
  await h.page.onRecognizePhoto('camera');
  await new Promise(r=>setTimeout(r,2));
  await h.page.onRecognizePhoto('album');
  const active=h.page.data.photoDrafts[0];
  await h.page.onSubmit();
  assert.equal(h.calls.create,0,'reserved original continues to block submission');
  assert.equal(h.calls.recognize,0,'should not recognize while draft remains irrecoverably incomplete');
  assert.equal(active.photos.length,1);
});

test('regression: durable registration failure writes zero bytes even with unavailable cleanup',async()=>{
  const h=pageHarness({storeBehavior:()=>{throw Error('synthetic storage failure');},closeBehavior:o=>o.fail({errMsg:'synthetic close failure'})});
  await h.page.onRecognizePhoto('camera');
  assert.equal(h.calls.write,0);assert.equal(h.calls.recognize,0);assert.equal(h.calls.unlink,0);
  assert.deepEqual([...h.files.values()].map(v=>v.length),[0]);
});

test('regression: deletion on a reopened page cannot be undone by the old writer',async()=>{
  let finish;
  const h=pageHarness({writeBehavior:(o,done)=>{finish=done;}});
  const writing=h.page.onRecognizePhoto('camera');
  await tick();
  h.page.onUnload();
  const reopened=h.newPage();reopened.loadPhotoDrafts();
  await tick();
  const id=reopened.data.photoDrafts[0].id;
  reopened.onDeletePhotoDraft({currentTarget:{dataset:{id}}});
  await tick();
  assert.equal(JSON.parse(h.storage.get(h.key))[0].status,'cleanup_pending');
  assert.equal(h.calls.unlink,0,'live lease correctly fences deletion');
  finish();await writing;
  assert.equal(JSON.parse(h.storage.get(h.key))[0].status,'cleanup_pending','old writer must not overwrite newer deletion intent');
  assert.equal(h.calls.recognize,0,'a deleted draft must not cause recognition');
});

test('regression: lease fences all stages of native close through ready commit',async()=>{
  const s=loadService('services/photo-file-lifecycle.ts');
  let owner,finishClose,readyCleanup;
  const fs={open:o=>o.success({fd:'review-fd'}),write:o=>o.success({bytesWritten:4}),close:o=>{finishClose=()=>o.success({});},unlink:()=>{throw Error('unexpected');}};
  const writing=s.writeOwnedPhotoFile({fs,sdkVersion:'3.17.3',root:'/review-owned',scopeKey:'scope',draftId:'photo-1-review',purpose:'box_front',mimeType:'image/jpeg',data:new ArrayBuffer(4),isCurrent:()=>true,register:v=>{owner=v;return true;},markReady:v=>{readyCleanup=s.closeOwnedPhotoFile(v);return true;}});
  await tick();
  assert.equal(await s.closeOwnedPhotoFile(owner),false);
  finishClose();
  assert.equal(await s.closeOwnedPhotoFile(owner),false);
  const ready=await writing;
  assert.equal(await readyCleanup,false);
  assert.equal(await s.closeOwnedPhotoFile(ready),true);
});

test('regression: identity loss while close is pending cannot make ready',async()=>{
  const s=loadService('services/photo-file-lifecycle.ts');let current=true,finishClose;const events=[];
  const fs={open:o=>o.success({fd:'review-fd'}),write:o=>o.success({bytesWritten:4}),close:o=>{finishClose=()=>o.success({});},unlink:o=>{events.push('unlink');o.success({});}};
  const writing=s.writeOwnedPhotoFile({fs,sdkVersion:'3.17.3',root:'/review-owned',scopeKey:'scope',draftId:'photo-1-review',purpose:'box_front',mimeType:'image/jpeg',data:new ArrayBuffer(4),isCurrent:()=>current,register:()=>{events.push('reserved');return true;},markReady:()=>{events.push('ready');return true;}});
  await tick();current=false;finishClose();
  await assert.rejects(writing,e=>e.code==='PHOTO_STORAGE_STALE');
  assert.deepEqual(events,['reserved']);
});

for (const disposition of ['hide', 'unload-with-token-revocation']) {
  test(`regression: ${disposition} must preserve a reopened page's deletion intent`,async()=>{
    let finish;
    const h=pageHarness({writeBehavior:(o,done)=>{finish=done;}});
    const writing=h.page.onRecognizePhoto('camera');await tick();
    if(disposition==='hide') h.page.onHide();
    else {h.page.onUnload();h.page.recognitionToken++;}
    const reopened=h.newPage();reopened.loadPhotoDrafts();await tick();
    const id=reopened.data.photoDrafts[0].id;
    reopened.onDeletePhotoDraft({currentTarget:{dataset:{id}}});await tick();
    assert.equal(JSON.parse(h.storage.get(h.key))[0].status,'cleanup_pending');
    finish();await writing;
    assert.equal(JSON.parse(h.storage.get(h.key))[0].status,'cleanup_pending');
  });
}

test('regression: late recognition must not resurrect an already deleted file receipt',async()=>{
  let completeRecognition;
  const h=pageHarness({recognizeBehavior:result=>new Promise(resolve=>{completeRecognition=()=>resolve(result);})});
  const recognizing=h.page.onRecognizePhoto('camera');await tick();
  assert.equal(h.calls.recognize,1);h.page.onHide();
  const reopened=h.newPage();reopened.loadPhotoDrafts();await tick();
  const id=reopened.data.photoDrafts[0].id;
  reopened.onDeletePhotoDraft({currentTarget:{dataset:{id}}});await tick();
  assert.equal(h.calls.unlink,1);assert.equal(h.files.size,0);
  assert.equal(JSON.parse(h.storage.get(h.key)).length,0);
  completeRecognition();await recognizing;
  assert.equal(JSON.parse(h.storage.get(h.key)).length,0,'late OCR must not restore a deleted photo receipt');
});

for (const phase of ['write', 'recognition']) {
  test(`regression: ${phase} completion preserves another page's newly added draft`, async () => {
    let release;
    const behavior = phase === 'write' ? {writeBehavior:(_options,finish)=>{release=finish;}}
      : {recognizeBehavior:result=>new Promise(resolve=>{release=()=>resolve(result);})};
    const h=pageHarness(behavior);
    const running=h.page.onRecognizePhoto('camera');await tick();
    const queue=JSON.parse(h.storage.get(h.key));
    queue.push({id:'photo-999-other',status:'review',fields:{...queue[0].fields,name:'Later synthetic draft'},medicineId:'',photos:[]});
    h.storage.set(h.key,JSON.stringify(queue));
    release();await running;
    const after=JSON.parse(h.storage.get(h.key));
    assert.equal(after.length,2);
    assert.equal(after.find(item=>item.id==='photo-999-other').fields.name,'Later synthetic draft');
    assert.equal(h.calls.recognize,1);
  });

  test(`regression: ${phase} completion never overwrites another page's newer fields`, async () => {
    let release;
    const behavior = phase === 'write' ? {writeBehavior:(_options,finish)=>{release=finish;}}
      : {recognizeBehavior:result=>new Promise(resolve=>{release=()=>resolve(result);})};
    const h=pageHarness(behavior);
    const running=h.page.onRecognizePhoto('camera');await tick();
    const queue=JSON.parse(h.storage.get(h.key));queue[0].fields.name='Newer synthetic text';
    h.storage.set(h.key,JSON.stringify(queue));
    release();await running;
    assert.equal(JSON.parse(h.storage.get(h.key))[0].fields.name,'Newer synthetic text');
    h.page.onShow(); await tick();
    assert.equal(JSON.parse(h.storage.get(h.key))[0].fields.name,'Newer synthetic text','passive reentry must not replace newer stored fields');
    assert.equal(h.calls.recognize,phase==='write'?0:1);
  });
}

test('regression: late OCR failure cannot restore a deleted record through the catch path', async () => {
  let rejectRecognition;
  const h=pageHarness({recognizeBehavior:()=>new Promise((_resolve,reject)=>{rejectRecognition=reject;})});
  const running=h.page.onRecognizePhoto('camera');await tick();h.page.onHide();
  const reopened=h.newPage();reopened.loadPhotoDrafts();await tick();
  reopened.onDeletePhotoDraft({currentTarget:{dataset:{id:reopened.data.photoDrafts[0].id}}});await tick();
  assert.equal(JSON.parse(h.storage.get(h.key)).length,0);
  rejectRecognition(new Error('synthetic failure'));await running;
  assert.equal(JSON.parse(h.storage.get(h.key)).length,0);
  assert.equal(h.files.size,0);
});

test('regression: a normal picker hide/show does not dispose or cancel a valid capture', async () => {
  let h;
  h=pageHarness({chooseBehavior:async()=>{h.page.onHide();h.page.onShow?.();return {tempFiles:[{tempFilePath:'/review-temp.jpg',size:4}]};}});
  await h.page.onRecognizePhoto('camera');
  assert.equal(h.calls.recognize,1);
  assert.equal(JSON.parse(h.storage.get(h.key))[0].photos[0].ownedLocal.state,'ready');
});

for (const outcome of ['success', 'failure']) {
  test(`regression: delayed cleanup ${outcome} preserves another page's new draft`, async () => {
    let release;
    const h=pageHarness({unlinkBehavior:(options,finish)=>{release=outcome==='success'?finish:()=>options.fail({errMsg:'synthetic failure'});}});
    await h.page.onRecognizePhoto('camera');
    const originalId=h.page.data.photoDrafts[0].id;
    h.page.onDeletePhotoDraft({currentTarget:{dataset:{id:originalId}}});await tick();
    const queue=JSON.parse(h.storage.get(h.key));
    queue.push({id:'photo-999-later',status:'review',fields:{name:'Later synthetic draft'},medicineId:'',photos:[]});
    h.storage.set(h.key,JSON.stringify(queue));
    release();await tick();
    const after=JSON.parse(h.storage.get(h.key));
    assert.equal(after.find(item=>item.id==='photo-999-later')?.fields.name,'Later synthetic draft');
    assert.equal(after.some(item=>item.id===originalId),outcome==='failure');
  });
}

test('regression: cleanup retains a target changed while unlink is pending', async () => {
  let release;
  const h=pageHarness({unlinkBehavior:(_options,finish)=>{release=finish;}});
  await h.page.onRecognizePhoto('camera');
  const originalId=h.page.data.photoDrafts[0].id;
  h.page.onDeletePhotoDraft({currentTarget:{dataset:{id:originalId}}});await tick();
  const queue=JSON.parse(h.storage.get(h.key));
  queue[0].fields.name='Concurrent synthetic edit';
  h.storage.set(h.key,JSON.stringify(queue));
  release();await tick();
  const after=JSON.parse(h.storage.get(h.key));
  assert.equal(after[0]?.fields.name,'Concurrent synthetic edit');
  assert.equal(after[0]?.status,'cleanup_pending');
});

for (const action of ['select', 'edit-another-field']) {
  test(`regression: reentry then ${action} preserves another page's newer fields`, async () => {
    const h=pageHarness();await h.page.onRecognizePhoto('camera');
    const id=h.page.data.activePhotoDraftId;
    const newer=h.newPage();newer.loadPhotoDrafts();
    newer.onSelectPhotoDraft({currentTarget:{dataset:{id}}});
    newer.onFieldInput({currentTarget:{dataset:{field:'name'}},detail:{value:'Newer synthetic name'}});
    h.page.onShow();await tick();
    if(action==='select')h.page.onSelectPhotoDraft({currentTarget:{dataset:{id}}});
    else h.page.onFieldInput({currentTarget:{dataset:{field:'manufacturer'}},detail:{value:'New manufacturer'}});
    assert.equal(JSON.parse(h.storage.get(h.key))[0].fields.name,'Newer synthetic name');
    assert.equal(h.page.data.name,'Newer synthetic name');
    if(action==='edit-another-field')assert.equal(JSON.parse(h.storage.get(h.key))[0].fields.manufacturer,'New manufacturer');
  });
}

test('regression: delete confirmation preserves a new capture and its ownership receipt', async () => {
  let modal;
  const h=pageHarness({modalBehavior:options=>{modal=options;}});
  await h.page.onRecognizePhoto('camera');
  const id=h.page.data.activePhotoDraftId;
  h.page.onDeletePhotoDraft({currentTarget:{dataset:{id}}});
  const newer=h.newPage();await newer.onRecognizePhoto('camera');
  const addedId=newer.data.activePhotoDraftId;
  const addedPath=newer.data.photoDrafts.find(item=>item.id===addedId).photos[0].path;
  modal.success({confirm:true});await tick();
  const after=JSON.parse(h.storage.get(h.key));
  assert.equal(after.length,1);assert.equal(after[0].id,addedId);
  assert.equal(after[0].photos[0].ownedLocal.path,addedPath);
  assert.equal(h.files.has(addedPath),true);
});

test('regression: reentry retains unacknowledged local edits alongside a newer stored name', async () => {
  let failStore=false;
  const h=pageHarness({storeBehavior:()=>{if(failStore)throw Error('synthetic storage failure');}});
  await h.page.onRecognizePhoto('camera');
  failStore=true;
  h.page.onFieldInput({currentTarget:{dataset:{field:'manufacturer'}},detail:{value:'Unstored manufacturer'}});
  const queue=JSON.parse(h.storage.get(h.key));queue[0].fields.name='Newer stored name';h.storage.set(h.key,JSON.stringify(queue));
  h.page.onShow();await tick();
  assert.equal(h.page.data.name,'Newer stored name');
  assert.equal(h.page.data.manufacturer,'Unstored manufacturer');
  assert.notEqual(JSON.parse(h.storage.get(h.key))[0].fields.manufacturer,'Unstored manufacturer');
  failStore=false;
  h.page.onFieldInput({currentTarget:{dataset:{field:'specification'}},detail:{value:'New specification'}});
  const after=JSON.parse(h.storage.get(h.key))[0].fields;
  assert.equal(after.name,'Newer stored name');assert.equal(after.manufacturer,'Unstored manufacturer');
});
