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

test("AUD-06 real backup page: switch household during pending write never shares A JSON; original owner cleanup",async()=>{
  let actor="A",generation=1,writeDone,shared=0;
  const storage=new Map(),files=new Set();
  const wx={
    env:{USER_DATA_PATH:"/qa-owned"},
    getStorageSync:key=>storage.get(key),
    setStorageSync:(key,value)=>storage.set(key,structuredClone(value)),
    getFileSystemManager:()=>({
      writeFile:opts=>{files.add(opts.filePath);writeDone=opts.success;},
      unlink:opts=>{files.delete(opts.filePath);opts.success();}
    }),
    shareFileMessage:opts=>{shared++;opts.success();}
  };
  const scopes={scopedStorageKey:kind=>kind+":"+actor};
  const helpers=loadService("services/temporary-share-files.ts",{wx,modules:{"./session-scope":scopes}});
  const modules={
    "../../services/api":{
      ApiError:class ApiError extends Error {},
      captureSessionIdentity:()=>({token:actor,generation}),
      isCurrentSession:id=>id.token===actor&&id.generation===generation,
      api:{createJsonBackup:async()=>({backupId:"synthetic-only",exportedAt:"2026-10-10",medicines:[]})}
    },
    "../../services/auth":{ensureLoggedIn:async()=>{}},
    "../../services/temporary-share-files":helpers
  };
  const {definition}=loadPage("pages/backup-restore/backup-restore.ts",{wx,modules});
  const page=makePageContext(definition);
  const pending=page.onCreateBackup();
  for(let i=0;i<40&&!writeDone;i++)await Promise.resolve();
  assert.equal(typeof writeDone,"function");
  const path=[...files][0];
  assert.ok(storage.get("temporary-shared-files:A").includes(path));
  actor="B";generation++;
  writeDone();
  await pending;
  assert.equal(shared,0);
  assert.equal(files.has(path),false);
  assert.deepEqual(storage.get("temporary-shared-files:A"),[]);
  assert.equal(await helpers.recoverTemporaryShareFiles(),true);
});

test("AUD-06 durable share receipt: failed delete remains for original family, cold restart retries only own paths",async()=>{
  let actor="A", failDelete=true;
  const store=new Map(), files=new Set();
  const wx={env:{USER_DATA_PATH:"/qa-owned"},getStorageSync:k=>store.get(k),
    setStorageSync:(k,v)=>store.set(k,structuredClone(v)),
    getFileSystemManager:()=>({unlink:opts=>{
      if(failDelete){opts.fail({errMsg:"EACCES"});return;}
      files.delete(opts.filePath);opts.success();
    }})};
  const scopes={scopedStorageKey:kind=>kind+":"+actor};
  const helper=()=>loadService("services/temporary-share-files.ts",{wx,modules:{"./session-scope":scopes}});
  const path="/qa-owned/home-medicine-share-123456789012-failure.json";
  files.add(path);
  assert.equal(helper().registerTemporaryShareFile(path),true);
  assert.equal(await helper().cleanupTemporaryShareFile(path),false);
  actor="B";
  assert.equal(await helper().recoverTemporaryShareFiles(),true);
  assert.equal(files.has(path),true);
  assert.equal(await helper().cleanupTemporaryShareFile(path),false);
  actor="A";failDelete=false;
  assert.equal(await helper().recoverTemporaryShareFiles(),true);
  assert.equal(files.has(path),false);
  assert.deepEqual(store.get("temporary-shared-files:A"),[]);
});

test("AUD-06 same-family share and native cancel both clean registered originals",async()=>{
  for (const cancel of [false,true]) {
    const files=new Set(),storage=new Map();
    let dispatched=0;
    const wx={
      env:{USER_DATA_PATH:"/qa-owned"},
      getStorageSync:k=>storage.get(k),
      setStorageSync:(k,v)=>storage.set(k,structuredClone(v)),
      getFileSystemManager:()=>({
        writeFile:opts=>{files.add(opts.filePath);opts.success();},
        unlink:opts=>{files.delete(opts.filePath);opts.success();}
      }),
      shareFileMessage:opts=>{dispatched++;if(cancel)opts.fail({errMsg:"cancel"});else opts.success();}
    };
    const scopes={scopedStorageKey:kind=>kind+":A"};
    const helpers=loadService("services/temporary-share-files.ts",{wx,modules:{"./session-scope":scopes}});
    const {definition}=loadPage("pages/backup-restore/backup-restore.ts",{wx,modules:{
      "../../services/api":{
        ApiError:class ApiError extends Error {},
        captureSessionIdentity:()=>({token:"A",generation:1}),
        isCurrentSession:id=>id.token==="A"&&id.generation===1,
        api:{createJsonBackup:async()=>({backupId:"synthetic",exportedAt:"2026-10-10",medicines:[]})}
      },
      "../../services/auth":{ensureLoggedIn:async()=>{}},
      "../../services/temporary-share-files":helpers,
    }});
    const page=makePageContext(definition);
    await page.onCreateBackup();
    assert.equal(dispatched,1);
    assert.equal(files.size,0);
    assert.deepEqual(storage.get("temporary-shared-files:A"),[]);
    assert.equal(Boolean(page.data.errorMessage),cancel);
  }
});
