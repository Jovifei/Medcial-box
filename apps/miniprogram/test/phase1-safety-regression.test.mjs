import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, loadService, makePageContext } from "./runtime.mjs";

test("AUD-02 family leave and member mutation do not dispatch after confirmation changes identity", async () => {
  let actor="A", generation=1, approve;
  let calls=0;
  const api={
    ApiError: class ApiError extends Error {},
    captureSessionIdentity:()=>({token:actor,generation}),
    isCurrentSession:value=>value.token===actor&&value.generation===generation,
    api:{leaveFamily:async()=>{calls++},transferOwnership:async()=>{calls++},removeMember:async()=>{calls++}},
  };
  const {definition}=loadPage("pages/family-settings/family-settings.ts",{
    modules:{
      "../../services/api":api,
      "../../services/auth":{ensureLoggedIn:async()=>{}},
      "../../services/session-scope":{scopedStorageKey:name=>name+":"+actor},
    },
    wx:{showModal:opts=>{approve=opts.success},showToast(){},reLaunch(){}},
  });
  const page=makePageContext(definition);
  page.setData({role:"member"});
  const leave=page.onLeaveFamily();
  actor="B";generation++;
  approve({confirm:true});
  await leave;
  assert.equal(calls,0);
  page.setData({role:"owner"});
  const transfer=page.onManageMember({currentTarget:{dataset:{id:"member-1",action:"transfer"}}});
  actor="A";generation++;
  approve({confirm:true});
  await transfer;
  assert.equal(calls,0);
});

test("AUD-05 plan unload persists only to its original verified household namespace", () => {
  let actor="A";
  const writes=[];
  const {definition}=loadPage("pages/plan-detail/plan-detail.ts",{
    modules:{
      "../../services/api":{api:{},ApiError:class ApiError extends Error{}},
      "../../services/auth":{ensureLoggedIn:async()=>{}},
      "../../services/draft-guard":{registerDirtyDraft(){},clearDirtyDraft(){}},
      "../../services/session-scope":{scopedStorageKey:(kind,id)=>kind+":"+actor+":"+id},
    },
    wx:{setStorageSync:(key,value)=>writes.push({key,value})},
  });
  const page=makePageContext(definition);
  page.setData({planId:"plan-1"});
  page.draftOwnerKey="plan-edit-draft:A:plan-1";
  page.dirty=true;
  actor="B";
  page.onUnload();
  assert.equal(writes.length,0);
  actor="A";
  page.dirty=true;
  page.persistLocalDraft();
  assert.equal(writes.length,1);
  assert.equal(writes[0].key,"plan-edit-draft:A:plan-1");
});

test("AUD-06 durable temporary file ownership survives a recreated helper and never deletes unrelated paths", async () => {
  const stored=new Map(),files=new Set();
  const wx={
    env:{USER_DATA_PATH:"/qa-owned"},
    getStorageSync:key=>stored.get(key),
    setStorageSync:(key,value)=>stored.set(key,structuredClone(value)),
    getFileSystemManager:()=>({unlink:({filePath,success,fail})=>{
      if(files.delete(filePath))success();
      else fail({errMsg:"ENOENT"});
    }}),
  };
  const scope={scopedStorageKey:kind=>kind+":A:home"};
  const make=()=>loadService("services/temporary-share-files.ts",{wx,modules:{"./session-scope":scope}});
  const first=make();
  const path="/qa-owned/home-medicine-share-123456789012-test.json";
  const outsider="/qa-owned/personal-image.json";
  files.add(path); files.add(outsider);
  assert.equal(first.registerTemporaryShareFile(path),true);
  assert.equal(first.registerTemporaryShareFile(outsider),false);
  const afterRestart=make();
  assert.equal(await afterRestart.recoverTemporaryShareFiles(),true);
  assert.equal(files.has(path),false);
  assert.equal(files.has(outsider),true);
  assert.equal(await afterRestart.cleanupTemporaryShareFile(outsider),false);
});

test("AUD-03 cold-restart after offline logout plus failed durable erase cannot claim success", async () => {
  const token="a".repeat(64);
  const disk=new Map([["home_medicine_session_token",token]]);
  const {loadApi}=await import("./runtime.mjs");
  const api=loadApi({wx:{
    getStorageSync:key=>disk.get(key),
    setStorageSync:(key,value)=>{if(key==="home_medicine_session_token"&&value==="")throw new Error("synthetic disk write failed");disk.set(key,value);},
    removeStorageSync:()=>{throw new Error("synthetic erase failed");},
    request:options=>options.fail({errMsg:"request:fail offline"}),
  }});
  const auth=loadService("services/auth.ts",{
    modules:{"./api":api,"./session-scope":{writeSessionScope(){}}},
    wx:{login(){throw new Error("logout must not start a new login")}},
  });
  await assert.rejects(auth.logout(),error=>error.code==="LOGOUT_NOT_DURABLE");
  api.__resetTokenMemoryForTest();
  assert.equal(api.readToken(),token,"fresh module memory exposes persistent stale token until storage heals");
});

test("AUD-04 account switch while export file is being written prevents stale native share", async () => {
  let actor="A",version=1,writeDone;
  let shared=0;
  const {definition}=loadPage("pages/export-preview/export-preview.ts",{
    modules:{
      "../../services/api":{
        ApiError:class ApiError extends Error{},
        captureSessionIdentity:()=>({token:actor,generation:version}),
        isCurrentSession:id=>id.token===actor&&id.generation===version,
        api:{
          createExportSnapshot:async()=>({snapshotId:"synthetic-snapshot",generatedAt:"2026-10-09"}),
          exportMarkdown:async()=>({markdown:"# Synthetic medicine export",generatedAt:"2026-10-09"}),
        },
      },
      "../../services/auth":{ensureLoggedIn:async()=>{}},
      "../../services/session-scope":{scopedStorageKey:kind=>kind+":"+actor},
    },
    wx:{
      env:{USER_DATA_PATH:"/temporary-test"},
      getFileSystemManager:()=>({
        writeFile:opts=>{writeDone=opts.success;},
        unlink:opts=>opts.success(),
      }),
      shareFileMessage:opts=>{shared++;opts.success({errMsg:"ok"});},
      setClipboardData:opts=>opts.success(),
    },
  });
  const page=makePageContext(definition);
  const work=page.onShareFile();
  for(let i=0;i<40 && !writeDone;i++)await Promise.resolve();
  assert.equal(typeof writeDone,"function","test must hold at the real native-file write boundary");
  actor="B";version++;
  writeDone();
  await work;
  assert.equal(shared,0);
});
