import assert from 'node:assert/strict';
import {loadPage,makePageContext,makeSessionScopeModule} from 'file:///E:/project/medcial_box/apps/miniprogram/test/runtime.mjs';
const scope=makeSessionScopeModule({userId:'synthetic-user-a',familyId:'synthetic-family-a'});const writes=[];
const {definition}=loadPage('pages/plan-detail/plan-detail.ts',{modules:{'../../services/api':{api:{},ApiError:class extends Error{}},'../../services/auth':{ensureLoggedIn:async()=>{}},'../../services/draft-guard':{clearDirtyDraft(){},registerDirtyDraft(){}},'../../services/session-scope':scope},wx:{setStorageSync(k,v){writes.push({key:k,value:v});}}});
const page=makePageContext(definition);Object.assign(page.data,{planId:'synthetic-plan-a',dosageText:'PRIVATE_A_DOSAGE',timeSlots:['08:00']});page.dirty=true;
scope.writeSessionScope({userId:'synthetic-user-b',familyId:'synthetic-family-b'});page.onUnload();
assert.equal(writes.length,1);assert.ok(writes[0].key.includes('synthetic-user-b:synthetic-family-b'));assert.equal(writes[0].value.dosageText,'PRIVATE_A_DOSAGE');
console.log(JSON.stringify({finding:'OLD_PLAN_DRAFT_WRITTEN_UNDER_NEW_SESSION_SCOPE',writes}));
