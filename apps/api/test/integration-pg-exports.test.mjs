import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../dist/db/migrations.js';
import { buildServer } from '../dist/app.js';
import { createDatabaseAdapter } from '../dist/db.js';
import { readInventoryExportSnapshot } from '../dist/services/export-snapshot.js';
import { createTestGateway } from './helpers/fake-wechat.mjs';
import { isolatedPostgres } from './helpers/isolated-pg.mjs';
const url=process.env.TEST_DATABASE_URL?.trim();
test('real PG: export transaction sees one inventory version while another client modifies quantities', {skip:!url && process.env.REQUIRE_POSTGRES_TESTS!=='1' ? 'TEST_DATABASE_URL absent' : false}, async()=>{
 assert.ok(url); const fixture=await isolatedPostgres(url); let app;
 try {
  await applyMigrations(fixture.pool); const gateway=createTestGateway(); const code=randomUUID(); gateway.registerCode(code,`export-${code}`);
  app=await buildServer({database:fixture.database,wechatGateway:gateway,logger:{level:'error'}});
  const auth=(await app.inject({method:'POST',url:'/api/v1/auth/wechat',payload:{code}})).json();
  const request=(path,payload)=>app.inject({method:'POST',url:`/api/v1${path}`,headers:{authorization:`Bearer ${auth.token}`},payload});
  const family=await request('/families',{name:'导出合成家庭'}); assert.equal(family.statusCode,201,family.body);
  const created=await request('/medicines',{name:'合成药',batches:[{unit:'ml',quantity:12.5,expiry:{precision:'unknown',value:null}}]}); assert.equal(created.statusCode,201,created.body);
  const familyId=family.json().family.id;
  let changed=false;
  const production=createDatabaseAdapter(fixture.pool);
  const exportingDatabase={query:(...args)=>production.query(...args),withTransaction:fn=>production.withTransaction(tx=>fn({query:async(sql,params)=>{const run=()=>tx.query(sql,params);
   const result=await run();
   if(!changed && /FROM medicines WHERE family_id/.test(sql)) { changed=true; await fixture.pool.query('UPDATE medicine_batches SET quantity=99 WHERE family_id=$1',[familyId]); }
   return result;
  }}))};
  const snapshot=await readInventoryExportSnapshot(exportingDatabase,auth.user.id,familyId,{includePersonalDosage:false,includeArchived:false,includeStorageLocation:true});
  assert.equal(snapshot[0].batches[0].quantity,12.5); assert.equal(Number((await fixture.pool.query('SELECT quantity FROM medicine_batches WHERE family_id=$1',[familyId])).rows[0].quantity),99);
 } finally {fixture.observe=null; if(app)await app.close(); await fixture.close();}
});
