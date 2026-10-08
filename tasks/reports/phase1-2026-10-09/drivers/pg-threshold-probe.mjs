import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import vm from 'node:vm';
const base='E:/Claude_allow/Download/medcial_box/phase1-20261008';
const root=base+'/checkout';
const load=path=>import(pathToFileURL(root+'/'+path).href);
const {isolatedPostgres}=await load('apps/api/test/helpers/isolated-pg.mjs');
const {applyMigrations}=await load('apps/api/dist/db/migrations.js');
const {buildServer}=await load('apps/api/dist/app.js');
const {createTestGateway}=await load('apps/api/test/helpers/fake-wechat.mjs');
const ts=createRequire(root+'/package.json')('typescript');
const pageSource=await readFile(root+'/apps/miniprogram/pages/medicine-detail/medicine-detail.ts','utf8');
const ast=ts.createSourceFile('page.ts',pageSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const methods=[];function visit(n){if(ts.isMethodDeclaration(n)&&n.name?.getText(ast)==='onSaveThreshold')methods.push(n);ts.forEachChild(n,visit)}visit(ast);assert.equal(methods.length,1);
const methodJs=ts.transpileModule('globalThis.handler=({'+methods[0].getText(ast)+'});',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const resource=JSON.parse(await readFile(base+'/private-resources.json','utf8'));
assert.equal(new URL(resource.url).pathname,'/medbox_phase1');assert.equal(new URL(resource.url).hostname,'127.0.0.1');
const fixture=await isolatedPostgres(resource.url);await applyMigrations(fixture.pool);
const gateway=createTestGateway();const app=await buildServer({database:fixture.database,wechatGateway:gateway,logger:false});
const result={source_sha:'85bfe729f2089db2ee48040b450293511e8ce9c7',product_baseline:'f675416ced73b59144c1f3d327dcdc741608a84e',scope:'actual page method + actual Fastify route + PostgreSQL; only UI/login boundaries mocked',page_sha256:createHash('sha256').update(pageSource).digest('hex'),pg_container:resource.name,variants:[],cleanup:{fixtureSchema:null}};
function response(r,code){assert.equal(r.statusCode,code,r.body);return code===204?null:r.json()}
try{
 for(const enabled of [true,false]){
  const code=randomUUID();gateway.registerCode(code,'qa-'+code);const auth=response(await app.inject({method:'POST',url:'/api/v1/auth/wechat',payload:{code}}),200);
  const req=(method,url,payload)=>app.inject({method,url:'/api/v1'+url,headers:{authorization:'Bearer '+auth.token},...(payload===undefined?{}:{payload})});
  response(await req('POST','/families',{name:'QA合成家庭-不得服用'}),201);
  let medicine=response(await req('POST','/medicines',{name:'QA合成库存样本-不得服用',brand:'QA品牌',barcodeValue:'6900000000000',populationTags:['adult'],purposeTags:['fever'],batches:[{quantity:2,unit:'box',expiry:{value:'2027-12',precision:'month'}},{quantity:5,unit:'box',expiry:{value:'2028-06-30',precision:'day'}},{quantity:1,unit:'box'}]}),201);
  response(await req('DELETE','/medicines/'+medicine.id+'/batches/'+medicine.batches[2].id),204);
  medicine=response(await req('GET','/medicines/'+medicine.id),200);
  const query=()=>fixture.pool.query('SELECT * FROM medicine_batches WHERE medicine_id=$1 ORDER BY id',[medicine.id]);
  const beforeRows=(await query()).rows;let submitted,updateResponse;
  const sandbox={api:{updateMedicine:async(id,payload)=>{submitted=structuredClone(payload);updateResponse=await req('PUT','/medicines/'+id,payload);return response(updateResponse,200)}},ensureLoggedIn:async()=>{},parseQuantityByUnit:t=>Number(t),unitAllowsDecimals:()=>false,wx:{showToast(){}},showError:e=>{throw e}};
  vm.createContext(sandbox,{codeGeneration:{strings:false,wasm:false}});new vm.Script(methodJs).runInContext(sandbox,{timeout:1000});
  const page={data:{medicineSummary:medicine,savingThreshold:false,thresholdEnabled:enabled,thresholdQuantity:'3',thresholdUnitIndex:0,thresholdUnitValues:['box']},setData(v){Object.assign(this.data,v)},refresh:async()=>{}};
  await sandbox.handler.onSaveThreshold.call(page);
  const after=response(await req('GET','/medicines/'+medicine.id),200);const afterRows=(await query()).rows;
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const assertions={batch_ids_retained:same(after.batches.map(b=>b.id).sort(),medicine.batches.map(b=>b.id).sort()),barcode_retained:after.barcodeValue===medicine.barcodeValue,population_tags_retained:same(after.populationTags,medicine.populationTags),purpose_tags_retained:same(after.purposeTags,medicine.purposeTags),brand_retained:after.brand===medicine.brand,already_deleted_batch_stays_deleted:beforeRows.filter(r=>r.deleted_at!==null).every(old=>afterRows.some(row=>row.id===old.id && same(row,old))),target_threshold_correct:same(after.lowStockThreshold,enabled?{quantity:3,unit:'box'}:null)};
  const stale=await req('PUT','/medicines/'+medicine.id,submitted);
  assertions.stale_version_rejected=stale.statusCode===409;
  result.variants.push({variant:enabled?'enable':'disable',status:Object.values(assertions).every(Boolean)?'PASS':'FAIL',http_status:updateResponse.statusCode,assertions,active_batches_before:medicine.batches.length,active_batches_after:after.batches.length,before_rows:beforeRows,after_rows:afterRows,before_metadata:{barcodeValue:medicine.barcodeValue,populationTags:medicine.populationTags,purposeTags:medicine.purposeTags},after_metadata:{barcodeValue:after.barcodeValue,populationTags:after.populationTags,purposeTags:after.purposeTags},submitted_field_names:Object.keys(submitted)});
 }
 result.status=result.variants.every(r=>r.status==='PASS')?'PASS':'FAIL';
}finally{await app.close();await fixture.close();result.cleanup.fixtureSchema='owned schema removed after snapshot receipt';}
result.finished_at=new Date().toISOString();await writeFile(base+'/pg-threshold-v2-results.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:result.status,variants:result.variants.map(r=>({variant:r.variant,status:r.status,assertions:r.assertions,before:r.active_batches_before,after:r.active_batches_after}))},null,2));process.exitCode=result.status==='PASS'?0:1;
