import assert from "node:assert/strict";
import test from "node:test";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { authHeader, batchRow, createApp, login, medicineRow, membershipRow } from "./helpers/app.mjs";
import { createTestGateway } from "./helpers/fake-wechat.mjs";

async function fixture() {
  const pool = createFakePool();
  const app = await createApp(pool, createTestGateway({ "js-code-1": "openid-user-1" }));
  await login(app, pool, { membership: membershipRow() });
  return { pool, app, auth: authHeader() };
}

test("AUD-01 threshold PATCH only touches threshold, never deletes batches or resets barcode/tags", async () => {
  const { pool, app, auth } = await fixture();
  try {
    pool.always(/FROM medicines WHERE id .*FOR UPDATE/, { rows: [medicineRow({ id:"m-1",version:2,barcode_value:"690123",population_tags:["adult"],purpose_tags:["pain"] })], rowCount: 1 });
    pool.on(/UPDATE medicines SET low_stock_threshold_quantity=/, {
      rows: [medicineRow({ id:"m-1",version:3,barcode_value:"690123",population_tags:["adult"],purpose_tags:["pain"],low_stock_threshold_quantity:2,low_stock_threshold_unit:"box" })],rowCount:1,
    });
    pool.always(/FROM medicine_batches WHERE medicine_id/, {
      rows: [batchRow({id:"b-1",medicine_id:"m-1",quantity:2,lot_number:"A"}),batchRow({id:"b-2",medicine_id:"m-1",quantity:4,lot_number:"B"})],rowCount:2,
    });
    const res = await app.inject({method:"PATCH",url:"/api/v1/medicines/m-1/low-stock-threshold",...auth,payload:{lowStockThreshold:{quantity:2,unit:"box"},version:2}});
    assert.equal(res.statusCode,200,res.body);
    assert.equal(res.json().barcodeValue,"690123");
    assert.deepEqual(res.json().populationTags,["adult"]);
    assert.deepEqual(res.json().purposeTags,["pain"]);
    assert.equal(res.json().batches.length,2);
    assert.equal(pool.callsMatching(/DELETE|UPDATE medicine_batches SET/).length,0);
    assert.equal(pool.callsMatching(/UPDATE medicines SET low_stock_threshold_quantity/).length,1);
    const sql=pool.callsMatching(/UPDATE medicines SET low_stock_threshold_quantity/)[0].sql;
    const assignments=sql.split(/\\bWHERE\\b/)[0];
    for(const forbidden of ["barcode_value =", "purpose_tags =", "population_tags =", "leaflet_", "specification ="]) {
      assert.equal(assignments.includes(forbidden),false,forbidden+" must not be assigned");
    }
    const bad=await app.inject({method:"PATCH",url:"/api/v1/medicines/m-1/low-stock-threshold",...auth,payload:{lowStockThreshold:null,version:3,batches:[]}});
    assert.equal(bad.statusCode,400,bad.body);
  } finally { await app.close(); }
});

test("AUD-14 quantity-only PATCH uses stored unit, retains physical metadata and rejects invalid/stale edits", async () => {
  const {pool,app,auth}=await fixture();
  try {
    pool.always(/FROM medicines WHERE id .*FOR UPDATE/, {rows:[medicineRow({id:"m-1",version:7})],rowCount:1});
    pool.always(/FROM medicine_batches .*FOR UPDATE/, {rows:[batchRow({id:"b-1",medicine_id:"m-1",unit:"ml",version:4,expiry_value:"2027-12",expiry_precision:"month",lot_number:"LOT-9",storage_location:"冰箱"})],rowCount:1});
    pool.on(/UPDATE medicine_batches SET quantity=/,{rows:[batchRow({id:"b-1",medicine_id:"m-1",quantity:"2.345",unit:"ml",version:5,expiry_value:"2027-12",expiry_precision:"month",lot_number:"LOT-9",storage_location:"冰箱"})],rowCount:1});
    pool.always(/UPDATE medicines SET version = version \+ 1/,{rows:[{id:"m-1"}],rowCount:1});
    const url="/api/v1/medicines/m-1/batches/b-1/quantity";
    const ok=await app.inject({method:"PATCH",url,...auth,payload:{quantity:2.345,version:4}});
    assert.equal(ok.statusCode,200,ok.body);
    assert.equal(ok.json().quantity,2.345);
    assert.equal(ok.json().unit,"ml");
    assert.equal(ok.json().lotNumber,"LOT-9");
    assert.equal(ok.json().storageLocation,"冰箱");
    assert.equal(ok.json().expiry.value,"2027-12");
    const sql=pool.callsMatching(/UPDATE medicine_batches SET quantity=/)[0].sql;
    for(const forbidden of ["lot_number =", "expiry_value =", "unit =", "storage_location =", "opened_state ="]) assert.equal(sql.includes(forbidden),false);
    const bad=await app.inject({method:"PATCH",url,...auth,payload:{quantity:2.3456,version:4}});
    assert.equal(bad.statusCode,400,bad.body);
    const unexpected=await app.inject({method:"PATCH",url,...auth,payload:{quantity:1,version:4,unit:"tablet"}});
    assert.equal(unexpected.statusCode,400,unexpected.body);
    const stale=await app.inject({method:"PATCH",url,...auth,payload:{quantity:1,version:4}});
    assert.equal(stale.statusCode,409,stale.body);
  } finally { await app.close(); }
});
