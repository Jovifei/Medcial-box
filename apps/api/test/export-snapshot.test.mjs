import assert from "node:assert/strict";
import test from "node:test";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { authHeader, batchRow, createApp, login, medicineRow, membershipRow } from "./helpers/app.mjs";

test("snapshot freezes options and data for all formats without reading inventory again", async () => {
 const pool=createFakePool(); const app=await createApp(pool,createTestGateway({"js-code-1":"openid-user-1"}));
 await login(app,pool,{membership:membershipRow()});
 pool.always(/FROM medicines WHERE family_id/,{rows:[medicineRow({name:'=危险,"药名"',population_tags:['child'],purpose_tags:['fever']})],rowCount:1});
 pool.always(/FROM medicine_batches WHERE family_id/,{rows:[batchRow({quantity:'12.5',unit:'ml',opened_state:'opened',opened_at:'2026-10-01'})],rowCount:1});
 try {
  const created=await app.inject({method:'POST',url:'/api/v1/exports/snapshot',...authHeader(),payload:{}});
  assert.equal(created.statusCode,200,created.body); const snap=created.json();
  assert.equal(snap.medicines[0].batches[0].quantity,12.5);
  assert.equal(snap.options.includePersonalDosage,false);
  assert.equal(pool.callsMatching(/FROM dosage_notes/).length,0);
  assert.equal(pool.callsMatching(/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/).length,1);
  const inventoryCalls=pool.callsMatching(/FROM medicines WHERE family_id/).length;
  pool.always(/FROM medicines WHERE family_id/,{rows:[medicineRow({name:'修改后药名'})],rowCount:1});
  for(const format of ['markdown','csv','pdf']){
   const response=await app.inject({method:'POST',url:`/api/v1/exports/${format}`,...authHeader(),payload:{snapshotId:snap.snapshotId}});
   assert.equal(response.statusCode,200,response.body);
   const body=response.json();assert.equal(body.snapshotId,snap.snapshotId);assert.equal(body.generatedAt,snap.generatedAt);
   assert.equal(JSON.stringify(body).includes('修改后药名'),false);
   if(format==='markdown') { assert.ok(body.markdown.includes('已开封 2026-10-01')); assert.ok(body.markdown.includes('开封截止')); assert.ok(body.markdown.includes('管理截止')); }
   if(format==='csv'){assert.ok(body.content.startsWith('\ufeff'));assert.ok(body.content.includes('12.5'));assert.ok(body.content.includes('ml'));assert.ok(body.content.includes("'=危险"));assert.ok(body.content.includes('""药名""'));}
   if(format==='pdf') { const bytes=Buffer.from(body.contentBase64,'base64'); assert.equal(bytes.subarray(0,5).toString(),'%PDF-'); const {PDFDocument}=await import('pdf-lib'); const doc=await PDFDocument.load(bytes); assert.ok(doc.getPageCount()>0); assert.equal(doc.getTitle(),'家庭药箱库存清单'); }
  }
  assert.equal(pool.callsMatching(/FROM medicines WHERE family_id/).length,inventoryCalls);
  const mismatch=await app.inject({method:'POST',url:'/api/v1/exports/csv',...authHeader(),payload:{snapshotId:snap.snapshotId,includePersonalDosage:true}});
  assert.equal(mismatch.statusCode,400);
  const unknown=await app.inject({method:'POST',url:'/api/v1/exports/csv',...authHeader(),payload:{snapshotId:'unknown'}});assert.equal(unknown.statusCode,404);
 }finally{await app.close();}
});

test('snapshot expiry, identity boundary and capacity preserve immutable private data', async () => {
 const {ExportSnapshotStore}=await import('../dist/services/export-snapshot.js');
 let now=0; const store=new ExportSnapshotStore(()=>now,1); const options={includePersonalDosage:false,includeArchived:false,includeStorageLocation:true};
 const first=store.put('user','family',[],options);
 assert.equal(store.get(first.snapshotId,'other','family'),null);
 assert.equal(store.get(first.snapshotId,'user','other'),null);
 assert.ok(Object.isFrozen(first.options));
 const second=store.put('user','family',[],options); assert.equal(store.get(first.snapshotId,'user','family'),null);
 now=300000; assert.equal(store.get(second.snapshotId,'user','family'),null);
 assert.throws(()=>new ExportSnapshotStore(Date.now,0),RangeError);
});

test('CSV protects formula prefixes including controls, quotes and newlines', async () => {
 const {csvCell}=await import('../dist/services/csv-export.js');
 assert.equal(csvCell('\u0000\t=SUM(1)'), '"\'\u0000\t=SUM(1)"');
 assert.equal(csvCell('药"名\n第二行'),'"药""名\n第二行"');
 assert.equal(csvCell('普通药品'),'"普通药品"');
});
