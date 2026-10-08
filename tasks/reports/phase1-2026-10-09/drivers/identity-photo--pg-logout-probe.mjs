import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const base='E:/Claude_allow/Download/medcial_box/phase1-20261008',root=base+'/checkout',out=base+'/identity-photo';
const expected='85bfe729f2089db2ee48040b450293511e8ce9c7';
assert.equal(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),expected);
const resource=JSON.parse(await readFile(base+'/private-resources.json','utf8'));
const url=new URL(resource.url); assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/medbox_phase1');
assert.equal(resource.id,'aa5539db35e8f221a60ffe36a8ead89ff9e62b6a67021c04a91acf67d99c710a');
const info=JSON.parse(execFileSync('docker',['inspect',resource.name],{encoding:'utf8'}))[0];
assert.equal(info.Id,resource.id);assert.equal(info.Config.Labels['medbox.audit'],'phase1-20261008');assert.equal(info.Config.Labels['medbox.owner'],'root');
const load=p=>import(pathToFileURL(root+'/'+p).href);
const {isolatedPostgres}=await load('apps/api/test/helpers/isolated-pg.mjs');
const {applyMigrations}=await load('apps/api/dist/db/migrations.js');
const {buildServer}=await load('apps/api/dist/app.js');
const {createTestGateway}=await load('apps/api/test/helpers/fake-wechat.mjs');
const {loadApi,loadService}=await load('apps/miniprogram/test/runtime.mjs');
const files=['apps/miniprogram/services/api.ts','apps/miniprogram/services/auth.ts','apps/miniprogram/services/session-scope.ts','apps/miniprogram/test/runtime.mjs','apps/api/src/auth/session.ts','apps/api/src/routes/auth.ts','apps/api/dist/auth/session.js','apps/api/dist/routes/auth.js','apps/api/dist/app.js','apps/api/dist/db/migrations.js','apps/api/test/helpers/isolated-pg.mjs'];
const hashes={};for(const file of files)hashes[file]=createHash('sha256').update(await readFile(root+'/'+file)).digest('hex');
const result={source_sha:expected,scope:'real mini auth/API/session modules + Fastify + isolated PostgreSQL; platform storage and offline request mocked; cold restart uses fresh modules, not OS process restart',container_id:resource.id,hashes,subcases:[],status:'NOT_RUN',cleanup:{ownedSchema:null}};
const fixture=await isolatedPostgres(resource.url); let app;
try{
 await applyMigrations(fixture.pool); const gateway=createTestGateway();app=await buildServer({database:fixture.database,wechatGateway:gateway,logger:false});
 for(const offline of [true,false]){
  const code=randomUUID();gateway.registerCode(code,'qa-logout-'+code);
  const login=await app.inject({method:'POST',url:'/api/v1/auth/wechat',payload:{code}});assert.equal(login.statusCode,200);const session=login.json();
  const storage=new Map();let observedLogoutStatus=null;
  const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync(){throw Error('synthetic persistent removal failure')},request(options){
   const path=new URL(options.url).pathname;
   if(offline&&path==='/api/v1/auth/logout'){options.fail({errMsg:'request:fail ERR_INTERNET_DISCONNECTED'});return;}
   app.inject({method:options.method,url:path,headers:options.header,...(options.data===undefined?{}:{payload:options.data})}).then(r=>{if(path==='/api/v1/auth/logout')observedLogoutStatus=r.statusCode;options.success({statusCode:r.statusCode,data:r.body?r.json():{}})},()=>options.fail({errMsg:'request:fail'}));
  }};
  const scope=loadService('services/session-scope.ts',{wx});const api=loadApi({wx,modules:{'./session-scope':scope}});const auth=loadService('services/auth.ts',{wx,modules:{'./api':api,'./session-scope':scope}});
  api.storeToken(session.token);scope.writeSessionScope({userId:session.user.id,familyId:''});
  let logoutError=null;try{await auth.logout()}catch(e){logoutError=e.code}
  assert.equal(api.readToken(),'');assert.equal(scope.readSessionScope(),null);
  assert.equal(logoutError,offline?'NETWORK_ERROR':null);
  const coldScope=loadService('services/session-scope.ts',{wx});const coldApi=loadApi({wx,modules:{'./session-scope':coldScope}});
  assert.equal(coldApi.readToken(),session.token);assert.equal(coldScope.readSessionScope().userId,session.user.id);
  const me=await app.inject({method:'GET',url:'/api/v1/auth/me',headers:{authorization:'Bearer '+coldApi.readToken()}});
  assert.equal(me.statusCode,offline?200:401);
  if(offline)assert.equal(me.json().user.id,session.user.id);
  result.subcases.push({id:offline?'offline-revoke-failure-and-storage-removal-failure':'successful-revoke-and-storage-removal-failure',assertion_status:'PASS',logout_error_code:logoutError,server_logout_status:observedLogoutStatus,memory_token_cleared:true,memory_scope_cleared:true,cold_token_resurrected:true,cold_scope_resurrected:true,actual_auth_me_status:me.statusCode,defect_status:offline?'VALID_SESSION_RESURRECTION_REPRODUCED':'REVOKED_TOKEN_REJECTED_CONTROL_PASS'});
 }
 result.status='PASS';
}finally{if(app)await app.close();await fixture.close();result.cleanup.ownedSchema='removed';result.finished_at=new Date().toISOString();await writeFile(out+'/pg-logout-results.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({status:result.status,subcases:result.subcases,cleanup:result.cleanup},null,2));
