import assert from 'node:assert/strict';
import {loadApi,loadService,loadPage,makePageContext} from 'file:///E:/project/medcial_box/apps/miniprogram/test/runtime.mjs';
const storage=new Map(); const requests=[]; let modal;
const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync(){throw Error('synthetic removal failure')},request:r=>requests.push(r),showModal:r=>{modal=r},reLaunch(){}};
const scope=loadService('services/session-scope.ts',{wx});
const api=loadApi({wx,modules:{'./session-scope':scope}});
api.storeToken('synthetic-old'); scope.writeSessionScope({userId:'synthetic-old',familyId:'synthetic-family'});
api.clearToken(); assert.equal(api.readToken(),''); assert.equal(scope.readSessionScope(),null);
const coldScope=loadService('services/session-scope.ts',{wx}); const coldApi=loadApi({wx,modules:{'./session-scope':coldScope}});
assert.equal(coldApi.readToken(),'synthetic-old'); assert.equal(coldScope.readSessionScope().userId,'synthetic-old');
console.log('REPRODUCED: failed storage deletion silently revives old token and owner on a fresh module/cold restart. No real storage used.');
const loaded=loadPage('pages/family-settings/family-settings.ts',{wx,modules:{'../../services/api':api,'../../services/auth':{ensureLoggedIn:async()=>{}}}}); const page=makePageContext(loaded.definition);
page.data.role='member'; const leave=page.onLeaveFamily();
api.storeToken('synthetic-new'); scope.writeSessionScope({userId:'synthetic-new',familyId:'synthetic-new-family'});
modal.success({confirm:true}); await Promise.resolve();
assert.match(requests[0].url,/families/); assert.equal(requests[0].header.authorization,'Bearer synthetic-new');
requests[0].success({statusCode:200,data:{}}); await leave;
console.log('REPRODUCED: old family leave confirmation dispatches POST with newer identity token. Only wx.request mocked; real page/API used.');

