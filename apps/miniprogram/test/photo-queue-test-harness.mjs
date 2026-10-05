import assert from 'node:assert/strict';
import {loadPage, makePageContext, makeSessionScopeModule} from './runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
function harness(behavior = {}) {
  const scope = makeSessionScopeModule({userId:'independent-synthetic-user', familyId:'independent-synthetic-family'});
  const key = scope.scopedStorageKey('medicine-photo-drafts');
  const storage = new Map(), files = new Map(), handles = new Map();
  const calls = {write:0, unlink:0, close:0, recognize:0, store:0, create:0, upload:0, cover:0, get:0};
  let fdCounter = 0;
  const fs = {
    readFile: o => behavior.read ? behavior.read(o) : o.success({data:'/9j/2Q=='}),
    open: o => {assert.equal(o.flag, 'wx');if(files.has(o.filePath))return o.fail({errMsg:'exists'});files.set(o.filePath, 0);const fd=`fd-${++fdCounter}`;handles.set(fd,o.filePath);o.success({fd});},
    write: o => {calls.write++; assert.ok(read().some(d=>d.photos.some(p=>p.path===handles.get(o.fd)&&p.ownedLocal?.state==='reserved')));const done=()=>{files.set(handles.get(o.fd),o.data.byteLength);o.success({bytesWritten:o.data.byteLength});};if(behavior.write)behavior.write(o,done);else done();},
    close: o => {calls.close++;const done=()=>{handles.delete(o.fd);o.success({});};if(behavior.close)behavior.close(o,done);else done();},
    unlink: o => {calls.unlink++;const done=()=>{files.delete(o.filePath);o.success({});};if(behavior.unlink)behavior.unlink(o,done);else done();},
  };
  const {definition}=loadPage('pages/medicine-edit/medicine-edit.ts',{
    setTimeoutFn:()=>{},
    modules:{'session-scope':scope,'../../services/auth':{ensureLoggedIn:async()=>{}},'../../services/api':{ApiError:class extends Error{},api:{
      recognizeMedicine:async()=>{calls.recognize++;const result={warnings:[],draft:{name:null,specification:null,manufacturer:null,approvalNumber:null,purposeCategory:null}};return behavior.recognize?behavior.recognize(result):result;},
      createMedicine:async()=>{calls.create++;const result={id:'synthetic-created',batches:[{id:'synthetic-batch'}]};return behavior.create?behavior.create(result):result;},
      getMedicine:async()=>{calls.get++;return {id:'synthetic-created',batches:[{id:'synthetic-batch'}]};},
      setMedicineCover:async()=>{calls.cover++;},
      uploadLeafletPhoto:async()=>{calls.upload++;const result={photo:{id:'synthetic-photo'}};return behavior.upload?behavior.upload(result):result;},
    }}},
    wx:{env:{USER_DATA_PATH:'/independent'},getSystemInfoSync:()=>({SDKVersion:'3.17.3'}),getFileSystemManager:()=>fs,
      base64ToArrayBuffer:()=>new Uint8Array([1,2,3,4]).buffer,
      chooseMedia:async()=>behavior.choose?behavior.choose():{tempFiles:[{tempFilePath:'/picker-synthetic.jpg',size:4}]},
      getStorageSync:k=>storage.has(k)?copy(storage.get(k)):undefined,
      setStorageSync:(k,v)=>{calls.store++;behavior.store?.(k,v);storage.set(k,copy(v));},removeStorageSync:k=>storage.delete(k),
      showModal:o=>behavior.modal?behavior.modal(o):o.success({confirm:true}),
    },
  });
  const page=()=>{const p=makePageContext(definition);p.touchedFields={};p.photoScopeKey=key;p.draftStorageKey=scope.scopedStorageKey('medicine-edit-draft');p.data.name='Original synthetic name';return p;};
  const a=page();
  const fields=()=>{const p=page();p.data.photoDrafts=[{id:'temporary',photos:[],fields:{}}];p.data.activePhotoDraftId='temporary';p.persistPhotoDrafts();const result=read()[0].fields;storage.delete(key);return result;};
  const baseFields=fields();calls.store=0;
  function draft(id='photo-100-first',status='review') {const path=`/independent/${id}-box_front-100.jpg`;return {id,status,thumbnail:path,fields:copy(baseFields),medicineId:'',photos:[{path,mimeType:'image/jpeg',purpose:'box_front',batchIndex:0,ownedLocal:{path,draftId:id,scopeKey:key,state:'ready',byteLength:4}}]};}
  function read(){return copy(storage.get(key)??[]);}
  function seed(queue){storage.set(key,copy(queue));for(const d of queue)for(const p of d.photos)files.set(p.path,4);}
  function attach(p,queue,id=queue[0]?.id??''){p.data.photoDrafts=copy(queue);p.data.activePhotoDraftId=id;if(id)Object.assign(p.data,copy(queue.find(d=>d.id===id).fields));}
  return {a,page,draft,read,seed,attach,storage,files,handles,calls,key,scope};
}
export {harness, edit, select, remove};
const edit=(page,field,value)=>page.onFieldInput({currentTarget:{dataset:{field}},detail:{value}});
const select=(page,id)=>page.onSelectPhotoDraft({currentTarget:{dataset:{id}}});
const remove=(page,id)=>page.onDeletePhotoDraft({currentTarget:{dataset:{id}}});
