import assert from 'node:assert/strict';
import {loadPage,makePageContext,loadApi} from 'file:///E:/project/medcial_box/apps/miniprogram/test/runtime.mjs';
let token='synthetic-token-a',write,shares=[],copies=[];
const apiModule=loadApi({wx:{getStorageSync:()=>token,setStorageSync(k,v){token=v},removeStorageSync(){token=''},request(o){o.success({statusCode:200,data:o.url.endsWith('/snapshot')?{snapshotId:'synthetic-snapshot-a'}:{markdown:'PRIVATE_FAMILY_A_EXPORT',generatedAt:'2026-10-08T00:00:00Z'}})}}});
const {definition}=loadPage('pages/export-preview/export-preview.ts',{modules:{'../../services/api':apiModule,'../../services/auth':{ensureLoggedIn:async()=>{}}},wx:{env:{USER_DATA_PATH:'/synthetic'},getFileSystemManager:()=>({writeFile(o){write=o},unlink(o){o.success()}}),shareFileMessage(o){shares.push(o);o.success()},setClipboardData(o){copies.push(o);o.success()}}});
const page=makePageContext(definition);const pending=page.onShareFile();while(!write)await new Promise(r=>setImmediate(r));
apiModule.clearToken();assert.equal(token,'');write.success();await pending;
assert.equal(shares.length,1);assert.equal(write.data,'PRIVATE_FAMILY_A_EXPORT');
console.log(JSON.stringify({finding:'EXPORT_NATIVE_SHARE_AFTER_LOGOUT_DURING_FILE_WRITE',shares:shares.length,lastAction:page.data.lastAction}));
