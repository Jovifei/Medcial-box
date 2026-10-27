import test from 'node:test';
import { setImmediate } from 'node:timers';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApi, loadPage, makePageContext, makeSessionScopeModule } from './runtime.mjs';
test('owner opening an invite cold link previews target before owner actions and never accepts automatically',async()=>{
  let previews=0,accepts=0,current=0;
  const {definition}=loadPage('pages/invite/invite.ts',{modules:{
    '../../services/api':{api:{getCurrentFamily:async()=>{current++;return {family:{role:'owner'}};},previewInvitation:async()=>{previews++;return {family:{name:'Target B'},expiresAt:'2099-01-01'};},acceptInvitation:async()=>{accepts++;}},ApiError:class extends Error{}},
    '../../services/auth':{ensureLoggedIn:async()=>{},logout:async()=>{}},
  }});
  const page=makePageContext(definition);page.onLoad({code:'target-code'});await page.refresh();
  assert.equal(page.data.mode,'join');assert.equal(page.data.preview.familyName,'Target B');assert.equal(previews,1);assert.equal(current,0);assert.equal(accepts,0);
});
test('real transport captures household A; switch invalidates its late recognition and 401 without clearing B',async()=>{
  const requests=[];const storage=new Map([['home_medicine_session_token','synthetic-token']]);
  const scope=makeSessionScopeModule({userId:'user',familyId:'family-A'});
  const api=loadApi({modules:{'./session-scope':scope},wx:{getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),request:o=>requests.push(o)}});
  const old=api.api.recognizeMedicine('synthetic','image/png');const old401=api.api.listMedicines();
  assert.equal(requests[0].header['x-family-id'],'family-A');
  const switchRequest=api.api.switchFamily('family-B');requests[2].success({statusCode:200,data:{familyId:'family-B',role:'member'}});await switchRequest;
  scope.writeSessionScope({userId:'user',familyId:'family-B'});
  requests[0].success({statusCode:200,data:{name:'late A'}});requests[1].success({statusCode:401,data:{error:{code:'UNAUTHORIZED'}}});
  await assert.rejects(old,e=>e.code==='STALE_SESSION');await assert.rejects(old401,e=>e.code==='STALE_SESSION');
  assert.equal(api.readToken(),'synthetic-token');assert.equal(scope.readSessionScope().familyId,'family-B');
});
test('non-editor product pages register shared bottom navigation; three primary tabs remain',()=>{
  const root=new URL('../',import.meta.url);const cfg=JSON.parse(fs.readFileSync(new URL('app.json',root)));const tabs=cfg.tabBar.list.map(x=>x.pagePath);
  assert.equal(tabs.length,3);
  for(const page of cfg.pages.filter(p=>!tabs.includes(p) && p !== 'pages/medicine-edit/medicine-edit')) {
    assert.match(fs.readFileSync(new URL(page+'.wxml',root),'utf8'), /<business-nav(?:\s[^>]*)?\s*\/>/, page);
    assert.equal(JSON.parse(fs.readFileSync(new URL(page+'.json',root))).usingComponents['business-nav'],'../../components/business-nav/business-nav');
  }
});
test('business footer stays fixed with disabled buttons; editor keeps its save and protected return',()=>{
  const root=new URL('../',import.meta.url);
  const nav=fs.readFileSync(new URL('components/business-nav/business-nav.wxml',root),'utf8');
  assert.equal((nav.match(/<button\b/g)||[]).length,3);
  assert.equal((nav.match(/disabled="\{\{busy\}\}"/g)||[]).length,3);
  assert.match(nav,/business-nav-spacer/);
  const css=fs.readFileSync(new URL('components/business-nav/business-nav.wxss',root),'utf8');
  assert.match(css,/position:\s*fixed/);
  assert.match(css,/\.business-nav-wrapper\.embedded\s*\{\s*position:\s*static/);
  const editor=fs.readFileSync(new URL('pages/medicine-edit/medicine-edit.wxml',root),'utf8');
  assert.match(editor,/<view class="save-bar">[\s\S]*?bindtap="onSubmit"/);
  assert.match(editor,/bindtap="onRequestLeave"/);
  assert.match(editor,/bindtap="onLeaveChoice"/);
  assert.doesNotMatch(editor,/<business-nav/);
});
test('batch footer saves original household input and stale submit never moves it to B',async()=>{
  const scope=makeSessionScopeModule({userId:'u',familyId:'a'});
  const storage=new Map();let guard;let writes=0;
  const modules={
    '../../services/session-scope':scope,
    '../../services/draft-guard':{registerDirtyDraft:d=>{guard=d;},clearDirtyDraft:d=>{if(d===guard)guard=null;}},
    '../../services/auth':{ensureLoggedIn:async()=>{}},
    '../../services/api':{api:{createBatch:async()=>{writes++;}},ApiError:class extends Error{}},
  };
  const {definition}=loadPage('pages/batch-edit/batch-edit.ts',{modules,wx:{getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,structuredClone(v))}});
  const page=makePageContext(definition);page.onLoad({medicineId:'medicine-a'});
  page.onFieldInput({currentTarget:{dataset:{field:'quantity'}},detail:{value:'7'}});
  await guard.save();assert.equal(storage.get('batch-form:u:a:medicine-a:new').fields.quantity,'7');
  scope.writeSessionScope({userId:'u',familyId:'b'});await page.onSubmit();assert.equal(writes,0);
  scope.writeSessionScope({userId:'u',familyId:'a'});
  const returned=makePageContext(definition);returned.onLoad({medicineId:'medicine-a'});assert.equal(returned.data.quantity,'7');
});
for(const pageName of ['family-entry','invite']) test(`${pageName}: edited code rejects old preview and confirmation identity cannot change`,async()=>{
  let releasePreview;let modal;let accepted=0;let generation=1;
  const {definition}=loadPage(`pages/${pageName}/${pageName}.ts`,{modules:{
    '../../services/api':{captureSessionIdentity:()=>({token:'synthetic',generation}),isCurrentSession:i=>i.generation===generation,api:{previewInvitation:()=>new Promise(resolve=>{releasePreview=resolve;}),acceptInvitation:async()=>{accepted++;}},ApiError:class extends Error{}},
    '../../services/auth':{ensureLoggedIn:async()=>{},logout:async()=>{}},
  },wx:{showModal:o=>{modal=o;}}});
  const page=makePageContext(definition);page.onInviteInput({detail:{value:'a'}});
  const loading=page.onPreviewInvitation();await new Promise(resolve=>setImmediate(resolve));releasePreview({family:{name:'A'},expiresAt:'2099-01-01'});
  page.onInviteInput({detail:{value:'b'}});await loading;assert.equal(page.data.preview,null);
  const next=page.onPreviewInvitation();await new Promise(resolve=>setImmediate(resolve));releasePreview({family:{name:'B'},expiresAt:'2099-01-01'});await next;
  assert.equal(page.data.preview.code,'b');const accepting=page.onAcceptInvitation();generation++;modal.success({confirm:true});await accepting;assert.equal(accepted,0);
});
