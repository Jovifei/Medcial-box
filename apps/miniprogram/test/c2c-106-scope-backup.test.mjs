import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPage, makePageContext } from './runtime.mjs';

class SessionFailure extends Error {
  constructor(code, generation) {
    super(code);
    this.code=code;
    this.statusCode=code==='UNAUTHORIZED'?401:0;
    this.invalidatedSession={token:code==='UNAUTHORIZED'?'':'synthetic',generation};
  }
}

test('C2C-03 create, preview and restore own 401 clear busy without a second onShow',async()=>{
  for(const action of ['create','preview','restore']){
    let generation=1, scope='synthetic-family';
    const identity=()=>({token:scope?'synthetic':'',generation});
    const expire=async()=>{scope=null;generation++;throw new SessionFailure('UNAUTHORIZED',generation);};
    const {definition}=loadPage('pages/backup-restore/backup-restore.ts',{
      modules:{
        '../../services/api':{
          api:{createJsonBackup:expire,previewJsonBackup:expire,restoreJsonBackup:expire},
          ApiError:SessionFailure,captureSessionIdentity:identity,
          isCurrentSession:id=>id.generation===generation&&id.token===identity().token,
        },
        '../../services/auth':{ensureLoggedIn:async()=>{}},
        '../../services/temporary-share-files':{
          temporaryShareScope:()=>scope,recoverTemporaryShareFiles:async()=>{},
          cleanupTemporaryShareFile:async()=>true,registerTemporaryShareFile:()=>true,
        },
      },
      wx:{
        chooseMessageFile:o=>o.success({tempFiles:[{path:'/synthetic.json',name:'synthetic.json'}]}),
        getFileSystemManager:()=>({readFile:o=>o.success({data:JSON.stringify({version:'synthetic'})})}),
      },
    });
    const page=makePageContext(definition);
    page.setData({backupJson:'old-family-private',statusText:'old-private'});
    if(action==='restore'){
      page.backupOperationIdentity=identity();
      page.backupOperationScope=scope;
      page.pendingImportPayload={version:'synthetic'};
      page.pendingConfirmationToken='synthetic-confirm';
      page.setData({importPreview:{valid:true},restoreAllowed:true});
    }
    if(action==='create') await page.onCreateBackup();
    if(action==='preview') await page.onChooseImport();
    if(action==='restore') await page.onConfirmRestore();
    assert.equal(page.data.busy,false,action);
    assert.equal(page.data.backupJson,'',action);
    assert.equal(page.data.importPreview,null,action);
    assert.equal(page.pendingImportPayload,null,action);
    assert.match(page.data.errorMessage,/重新登录/,action);
  }
});

test('C2C-04 server-driven family change erases private view before navigation even when navigation never completes',async()=>{
  const cases=[
    {path:'pages/index/index.ts',seed:{allItems:[{name:'A-private'}],items:[{name:'A-private'}],familyName:'A-family'},verify:p=>{assert.equal(p.data.allItems.length,0);assert.equal(p.data.items.length,0);assert.equal(p.data.familyName,'');}},
    {path:'pages/medicine-detail/medicine-detail.ts',seed:{medicineId:'A-med',medicineSummary:{id:'A-med'},name:'A-private',coverPhotoPath:'/private',leafletPhotos:[{id:'old'}],notes:[{id:'old'}]},verify:p=>{assert.equal(p.data.medicineSummary,null);assert.equal(p.data.name,'');assert.equal(p.data.coverPhotoPath,'');assert.equal(p.data.notes.length,0);}},
    {path:'pages/pending/pending.ts',seed:{items:[{id:'A-private'}],lastUpdated:'A-private'},verify:p=>{assert.equal(p.data.items.length,0);assert.equal(p.data.lastUpdated,'');}},
    {path:'pages/restock/restock.ts',seed:{items:[{id:'A-private'}],busyId:'A-private'},verify:p=>{assert.equal(p.data.items.length,0);assert.equal(p.data.busyId,'');}},
    {path:'pages/stocktake/stocktake.ts',seed:{stocktake:{id:'A-private'},items:[{id:'A-private'}],submitting:true},verify:p=>{assert.equal(p.data.stocktake,null);assert.equal(p.data.items.length,0);assert.equal(p.data.submitting,false);}},
  ];
  for(const scenario of cases){
    let generation=1;
    const session=()=>({token:'synthetic',generation});
    let navigated=false, page;
    const {definition}=loadPage(scenario.path,{
      modules:{
        '../../services/api':{api:{},ApiError:SessionFailure,readToken:()=> 'synthetic',
          captureSessionIdentity:session,isCurrentSession:id=>id.token==='synthetic'&&id.generation===generation},
        '../../services/auth':{ensureLoggedIn:async()=>{generation++;throw new SessionFailure('SESSION_SCOPE_CHANGED',generation);}},
      },
      wx:{reLaunch:()=>{navigated=true;scenario.verify(page);}},
    });
    page=makePageContext(definition);
    page.setData(scenario.seed);
    page.displayedIdentity=session();
    if(scenario.path.includes('medicine-detail'))page.displayedMedicineId='A-med';
    await page.refresh();
    assert.equal(navigated,true,scenario.path);
    scenario.verify(page);
  }
});
