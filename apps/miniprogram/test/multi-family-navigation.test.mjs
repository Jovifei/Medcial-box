import test from 'node:test';
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
test('all non-tab product pages register shared bottom navigation; four primary tabs stay unchanged',()=>{
  const root=new URL('../',import.meta.url);const cfg=JSON.parse(fs.readFileSync(new URL('app.json',root)));const tabs=cfg.tabBar.list.map(x=>x.pagePath);
  assert.equal(tabs.length,4);
  for(const page of cfg.pages.filter(p=>!tabs.includes(p))) {
    assert(fs.readFileSync(new URL(page+'.wxml',root),'utf8').includes('<business-nav />'),page);
    assert.equal(JSON.parse(fs.readFileSync(new URL(page+'.json',root))).usingComponents['business-nav'],'../../components/business-nav/business-nav');
  }
});
