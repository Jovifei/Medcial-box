import assert from 'node:assert/strict';
import test from 'node:test';
import {loadPage,makePageContext,loadService,makeSessionScopeModule} from '../apps/miniprogram/test/runtime.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
class ApiError extends Error{constructor(code,message,statusCode,invalidatedSession){super(message);Object.assign(this,{code,statusCode,invalidatedSession});}}
function actor(){let token='A',generation=1;return{captureSessionIdentity:()=>({token,generation}),isCurrentSession:id=>id?.token===token&&id?.generation===generation,clear:()=>{token='';generation++;},switch:()=>{token='B';generation++;}};}
for(const route of ['index','medicine-detail','pending','restock','stocktake'])test(`own 401 cleanup on ${route} reaches login instead of a stuck spinner`,async()=>{
 const state=actor(),routes=[];
 const {definition}=loadPage(`pages/${route}/${route}.ts`,{modules:{'../../services/api':{...state,readToken:()=>state.captureSessionIdentity().token,ApiError,api:{}},'../../services/auth':{ensureLoggedIn:async()=>{state.clear();throw new ApiError('UNAUTHENTICATED','expired',401,state.captureSessionIdentity());}}},wx:{reLaunch:o=>routes.push(o.url)}});
 const page=makePageContext(definition);if(route==='medicine-detail')page.setData({medicineId:'m'});
 await page.refresh();assert.equal(routes[0],'/pages/login/login');
});
test('backup late failure cannot leave a surviving page permanently busy after a family switch',async()=>{
 const state=actor(),gate=deferred();let who='A';
 const {definition}=loadPage('pages/backup-restore/backup-restore.ts',{modules:{'../../services/api':{...state,ApiError,api:{createJsonBackup:()=>gate.promise}},'../../services/auth':{ensureLoggedIn:async()=>{}},'../../services/temporary-share-files':{temporaryShareScope:()=>who,cleanupTemporaryShareFile:async()=>true,recoverTemporaryShareFiles:async()=>{},registerTemporaryShareFile:()=>true}}});
 const page=makePageContext(definition),pending=page.onCreateBackup();await tick();who='B';state.switch();gate.reject(Error('old failure'));await pending;page.onShow();assert.equal(page.data.busy,false);assert.equal(page.data.backupJson,'');
});
test('stocktake ignores old conflict status after identity changes during post-submit refresh',async()=>{
 const state=actor(),gate=deferred();
 const {definition}=loadPage('pages/stocktake/stocktake.ts',{modules:{'../../services/api':{...state,ApiError,api:{submitStocktakeItems:async()=>({results:[{outcome:'conflict'}]})}},'../../services/auth':{ensureLoggedIn:async()=>{}}}});
 const page=makePageContext(definition);page.setData({stocktake:{id:'s'},items:[]});page.refresh=()=>gate.promise;
 const action=page.onSubmit();await tick();state.switch();page.setData({errorMessage:'new household'});gate.resolve();await action;assert.equal(page.data.errorMessage,'new household');
});
test('restore scope change is reported with its owned identity instead of pretending unchanged',async()=>{
 const state=actor(),scope=makeSessionScopeModule({userId:'u',familyId:'old'});
 const auth=loadService('services/auth.ts',{modules:{'./api':{...state,ApiError,api:{getAuthMe:async()=>({user:{id:'u'},family:{id:'new'}})},beginSessionTransition:()=>{state.switch();return state.captureSessionIdentity();},staleSessionError:()=>new ApiError('STALE_SESSION','stale',0)},'./session-scope':scope}});
 await assert.rejects(auth.ensureLoggedIn({allowInteractive:false,rejectScopeChange:true}),e=>e.code==='SESSION_SCOPE_CHANGED'&&state.isCurrentSession(e.invalidatedSession));
});
for(const route of ['index','medicine-detail','pending','restock','stocktake']){
 test(`stale 401 from ${route} cannot redirect a newer identity`,async()=>{
  const state=actor(),routes=[],gate=deferred();let invalidated;
  const {definition}=loadPage(`pages/${route}/${route}.ts`,{modules:{'../../services/api':{...state,readToken:()=>state.captureSessionIdentity().token,ApiError,api:{}},'../../services/auth':{ensureLoggedIn:()=>gate.promise}},wx:{reLaunch:o=>routes.push(o.url)}});
  const page=makePageContext(definition);if(route==='medicine-detail')page.setData({medicineId:'m'});
  const pending=page.refresh();state.clear();invalidated=state.captureSessionIdentity();state.switch();gate.reject(new ApiError('UNAUTHENTICATED','expired',401,invalidated));await pending;assert.deepEqual(routes,[]);
 });
 test(`own verified household change in ${route} routes to selection, not a frozen old view`,async()=>{
  const state=actor(),routes=[];
  const {definition}=loadPage(`pages/${route}/${route}.ts`,{modules:{'../../services/api':{...state,readToken:()=>state.captureSessionIdentity().token,ApiError,api:{}},'../../services/auth':{ensureLoggedIn:async()=>{state.switch();throw new ApiError('SESSION_SCOPE_CHANGED','changed',0,state.captureSessionIdentity());}}},wx:{reLaunch:o=>routes.push(o.url)}});
  const page=makePageContext(definition);if(route==='medicine-detail')page.setData({medicineId:'m'});
  await page.refresh();assert.deepEqual(routes,['/pages/family-entry/family-entry']);
 });
}
function backupFixture(){
 const state=actor();let who='A',approve;
 const calls=[];
 const backup={schemaVersion:1,backupId:'synthetic',medicines:[]};
 const {definition}=loadPage('pages/backup-restore/backup-restore.ts',{modules:{
  '../../services/api':{...state,ApiError,api:{previewJsonBackup:async()=>({valid:true,duplicateBackup:false,confirmationToken:'synthetic-token',inventorySettings:{stocktakeInterval:'monthly'},medicineCount:0,likelyMatches:[],errors:[]}),restoreJsonBackup:async()=>{calls.push('write');return{restoredCount:0};}}},
  '../../services/auth':{ensureLoggedIn:async()=>{}},
  '../../services/temporary-share-files':{temporaryShareScope:()=>who,recoverTemporaryShareFiles:async()=>{}},
 },wx:{chooseMessageFile:o=>o.success({tempFiles:[{path:'synthetic.json',name:'synthetic.json'}]}),getFileSystemManager:()=>({readFile:o=>o.success({data:JSON.stringify(backup)})}),showModal:o=>{approve=o.success;}}});
 const page=makePageContext(definition);
 return{page,calls,switch:()=>{state.switch();who='B';},approve:()=>approve({confirm:true})};
}
test('backup import confirmation cannot write after scope changes inside the modal',async()=>{
 const f=backupFixture();await f.page.onChooseImport();assert.equal(f.page.data.restoreAllowed,true);
 const action=f.page.onConfirmRestore();await tick();f.switch();f.page.onShow();f.approve();await action;assert.deepEqual(f.calls,[]);assert.equal(f.page.data.restoreAllowed,false);assert.equal(f.page.data.busy,false);
});
test('same-identity backup preview still permits exactly one confirmed restore',async()=>{
 const f=backupFixture();await f.page.onChooseImport();const action=f.page.onConfirmRestore();await tick();f.approve();await action;assert.deepEqual(f.calls,['write']);assert.equal(f.page.data.busy,false);assert.equal(f.page.data.restoreAllowed,false);
});
test('missing backup scope reports actionable state without getting stuck busy',async()=>{
 const {definition}=loadPage('pages/backup-restore/backup-restore.ts',{modules:{'../../services/api':{ApiError,api:{}},'../../services/auth':{ensureLoggedIn:async()=>{}},'../../services/temporary-share-files':{temporaryShareScope:()=>null}}});const page=makePageContext(definition);await page.onCreateBackup();assert.equal(page.data.busy,false);assert.match(page.data.errorMessage,/选择家庭/);
});
