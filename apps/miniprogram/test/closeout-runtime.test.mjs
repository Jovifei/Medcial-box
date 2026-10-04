import assert from 'node:assert/strict';
import test from 'node:test';
import {loadPage, makePageContext, makeSessionScopeModule} from './runtime.mjs';
class ApiError extends Error {}
const auth={'../../services/auth':{ensureLoggedIn:async()=>{}}};
test('stocktake sends decimal ml with the current version, rejects fractional tablets',async()=>{
 const requests=[];
 const {definition}=loadPage('pages/stocktake/stocktake.ts',{modules:{...auth,'../../services/api':{ApiError,api:{submitStocktakeItems:async(id,items)=>{requests.push({id,items});return {results:[]}},completeStocktake:async()=>({completed:true}),getCurrentStocktake:async()=>({stocktake:null})}}}});
 const page=makePageContext(definition);
 page.applySession({id:'s',items:[{batchId:'b',medicineId:'m',medicineName:'liquid',unit:'ml',quantity:10,version:2,result:'pending'}]});
 page.onQuantityInput({currentTarget:{dataset:{index:0}},detail:{value:'12.5'}});
 await page.onSubmit();assert.equal(requests[0]?.items[0].quantity,12.5);assert.equal(requests[0].items[0].version,2);
 page.applySession({id:'s',items:[{batchId:'b',medicineId:'m',medicineName:'tablet',unit:'tablet',quantity:10,version:3,result:'pending'}]});
 page.onQuantityInput({currentTarget:{dataset:{index:0}},detail:{value:'12.5'}});await page.onSubmit();assert.equal(requests.length,1);
});
test('plan cancel offers keep discard continue; durable drafts restore only their owner',async()=>{
 const storage=new Map();const scope=makeSessionScopeModule({userId:'a',familyId:'f'});let backs=0;
 const options={modules:{...auth,'session-scope':scope,'../../services/api':{ApiError,captureSessionIdentity:()=>({token:'test',generation:1}),isCurrentSession:()=>true,staleSessionError:()=>new ApiError('stale'),api:{listCareProfiles:async()=>({careProfiles:[{id:'p',displayName:'me',canManage:true}]})}}},wx:{getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),navigateBack:()=>backs++}};
 const page=makePageContext(loadPage('pages/plan-create/plan-create.ts',options).definition);page.onLoad({});
 page.onFormInput({currentTarget:{dataset:{field:'medicineName'}},detail:{value:'draft'}});page.onCancel();assert.equal(backs,0);assert.equal(page.data.leaveSheetVisible,true);
 page.onLeaveChoice({currentTarget:{dataset:{choice:'continue'}}});assert.equal(backs,0);
 page.onCancel();page.onLeaveChoice({currentTarget:{dataset:{choice:'keep'}}});assert.equal(backs,1);assert.ok(storage.size>0);
 const restored=makePageContext(loadPage('pages/plan-create/plan-create.ts',options).definition);restored.onLoad({});assert.equal(restored.data.draftAvailable,true);restored.onRestoreDraft();assert.equal(restored.data.medicineName,'draft');
 scope.writeSessionScope({userId:'b',familyId:'f'});const foreign=makePageContext(loadPage('pages/plan-create/plan-create.ts',options).definition);foreign.onLoad({});assert.equal(foreign.data.draftAvailable,false);assert.equal(foreign.data.medicineName,'');
});

import {loadApi} from './runtime.mjs';
test('private photo payload binds purpose and exact saved batch, preferences have explicit channels',async()=>{
 const api=loadApi({token:'token'});const calls=[];
 api.wx.request=(request)=>{calls.push(request);request.success({statusCode:200,data:{photo:{id:'photo'}}})};
 await api.api.uploadLeafletPhoto('m','/9j/a','image/jpeg','medicine_entry',{purpose:'expiry',batchId:'b'});
 assert.equal(calls[0].data.purpose,'expiry');assert.equal(calls[0].data.batchId,'b');
 await api.api.updateNotificationPreferences({stockReminderTime:'10:30',timezone:'Asia/Shanghai',channels:['wechat']});
 assert.deepEqual(JSON.parse(JSON.stringify(calls[1].data.channels)),['wechat']);assert.equal(calls[1].data.stockReminderTime,'10:30');
});
test('photo upload failure preserves association and retry does not create another medicine',async()=>{
 let creates=0;let uploads=0;
 const saved={id:'m',batches:[{id:'saved-batch'}]};
 const {definition}=loadPage('pages/medicine-edit/medicine-edit.ts',{setTimeoutFn:()=>{},modules:{...auth,'../../services/api':{ApiError,api:{createMedicine:async()=>{creates++;return saved},getMedicine:async()=>saved,uploadLeafletPhoto:async(id,b64,mime,source,association)=>{uploads++;assert.equal(id,'m');assert.equal(association.batchId,'saved-batch');if(uploads===1)throw new Error('offline');return {photo:{id:'p'}}}}}},wx:{env:{USER_DATA_PATH:'/owned'},getFileSystemManager:()=>({readFile:options=>options.success({data:'/9j/a'})})}});
 const page=makePageContext(definition);page.loadPhotoDrafts();page.data.name='name';page.data.photoDrafts=[{id:'d',thumbnail:'/local.jpg',status:'review',fields:{},medicineId:'',photos:[{path:'/local.jpg',mimeType:'image/jpeg',purpose:'expiry',batchIndex:0}]}];page.data.activePhotoDraftId='d';
 await page.onSubmit();assert.equal(creates,1);assert.equal(page.data.photoDrafts[0].status,'photo_pending');assert.equal(page.data.photoDrafts[0].medicineId,'m');
 await page.onSubmit();assert.equal(creates,1);assert.equal(uploads,2);assert.equal(page.data.photoDrafts.length,0);assert.equal(page.data.activePhotoDraftId,'');
});
test('ten pending photo drafts block adding, switching drafts restores stable id and typed fields',()=>{
 const {definition}=loadPage('pages/medicine-edit/medicine-edit.ts',{modules:{...auth,'../../services/api':{ApiError,api:{}}}});const page=makePageContext(definition);
 const fields={name:'typed medicine',batches:page.data.batches,populationTags:[],purposeTags:[],specification:'',manufacturer:'',approvalNumber:'',barcodeValue:'',ingredients:'',purposeCategory:'',leafletPurpose:'',leafletUsage:'',leafletContraindications:'',leafletPrecautions:'',leafletSource:'',verified:false,scannedBarcode:'',purposeIndex:0};
 page.data.photoDrafts=Array.from({length:10},(_,i)=>({id:'d'+i,status:'review',fields:{...fields,name:'typed'+i},photos:[]}));
 page.onNewPhotoDraft();assert.equal(page.data.photoDrafts.length,10);
 page.onSelectPhotoDraft({currentTarget:{dataset:{id:'d4'}}});assert.equal(page.data.name,'typed4');assert.equal(page.data.activePhotoDraftId,'d4');
});

test('manual create retries keep one operation key after an uncertain outcome',async()=>{
 const keys=[];
 const {definition}=loadPage('pages/medicine-edit/medicine-edit.ts',{setTimeoutFn:()=>{},modules:{...auth,'../../services/api':{ApiError,api:{createMedicine:async payload=>{keys.push(payload.idempotencyKey);if(keys.length===1)throw new Error('connection lost');return {id:'m',batches:[]}}}}}});
 const page=makePageContext(definition);page.data.name='manual';
 await page.onSubmit();await page.onSubmit();assert.ok(keys[0]);assert.equal(keys[0],keys[1]);
});

test('export formats reuse one authorized snapshot and changed options request a new one',async()=>{
 let snapshots=0;const calls=[];
 const {definition}=loadPage('pages/export-preview/export-preview.ts',{modules:{...auth,'../../services/api':{ApiError,api:{createExportSnapshot:async ()=>({snapshotId:'s'+(++snapshots),generatedAt:'2026-10-03',expiresAt:'later'}),exportMarkdown:async p=>{calls.push(p);return {markdown:'md',generatedAt:'now'}},exportCsv:async p=>{calls.push(p);return {content:'csv',fileName:'x.csv',mimeType:'text/csv'}},exportPdf:async p=>{calls.push(p);return {contentBase64:'JVBERg==',fileName:'x.pdf',mimeType:'application/pdf'}}}}}});
 const page=makePageContext(definition);await page.refresh();page.setData({format:'csv'});await page.refresh();page.setData({format:'pdf'});await page.refresh();
 assert.equal(snapshots,1);assert.deepEqual(calls.map(c=>c.snapshotId),['s1','s1','s1']);assert.ok(calls.every(c=>c.includePersonalDosage===false));
 page.setData({includeStorageLocation:false});await page.refresh();assert.equal(snapshots,2);assert.equal(calls.at(-1).snapshotId,'s2');
});

test('uncertain create freezes attempted payload and form mutations until original retry resolves',async()=>{
 const payloads=[];const scope=makeSessionScopeModule({userId:'a',familyId:'f'});const storage=new Map();
 const {definition}=loadPage('pages/medicine-edit/medicine-edit.ts',{setTimeoutFn:()=>{},modules:{...auth,'session-scope':scope,'../../services/api':{ApiError,api:{createMedicine:async p=>{payloads.push(JSON.parse(JSON.stringify(p)));if(payloads.length===1)throw new Error('timeout');return {id:'m',batches:[]}}}}},wx:{getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v)}});
 const page=makePageContext(definition);page.data.name='original';await page.onSubmit();
 page.onFieldInput({currentTarget:{dataset:{field:'name'}},detail:{value:'changed'}});assert.equal(page.data.name,'original');
 assert.equal(page.data.attemptedPayload.name,'original');await page.onSubmit();assert.deepEqual(payloads[0],payloads[1]);
});
