import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../dist/app.js';
import { applyMigrations } from '../dist/db/migrations.js';
import { LocalMedicineCatalogProvider } from '../dist/services/local-medicine-catalog.js';
import { createTestGateway } from './helpers/fake-wechat.mjs';
import { isolatedPostgres } from './helpers/isolated-pg.mjs';

const url=process.env.TEST_DATABASE_URL?.trim()??'';
test('real PostgreSQL local barcode lookup isolates families and omits private inventory fields', {skip: !url&&process.env.REQUIRE_POSTGRES_TESTS!=='1'}, async()=>{
  assert.ok(url);
  const fixture=await isolatedPostgres(url);
  const gateway=createTestGateway();
  let app;
  try {
    await applyMigrations(fixture.pool);
    app=await buildServer({database:fixture.database,wechatGateway:gateway,medicineCatalogProvider:new LocalMedicineCatalogProvider(),logger:false});
    const call=(token,method,path,body)=>app.inject({method,url:'/api/v1'+path,headers:{authorization:'Bearer '+token},...(body?{payload:body}:{})});
    async function family(){const code=randomUUID();gateway.registerCode(code,'catalog-'+code);const login=await app.inject({method:'POST',url:'/api/v1/auth/wechat',payload:{code}});assert.equal(login.statusCode,200);const token=login.json().token;const create=await call(token,'POST','/families',{name:'Synthetic catalog '+code});assert.equal(create.statusCode,201);return token;}
    const a=await family();const b=await family();
    const barcode='6900000000019';
    const created=await call(a,'POST','/medicines',{name:'JF-UI-TEST-private-A',barcodeValue:barcode,brand:'synthetic brand',leaflet:{purposeSummary:'PRIVATE-LEAFLET',reviewStatus:'unverified'},batches:[{quantity:99,unit:'box',expiry:{value:'2028-06',precision:'month'},storageLocation:'PRIVATE-LOCATION'}]});
    assert.equal(created.statusCode,201);
    const own=await call(a,'POST','/medicine-catalog/candidates',{barcode,consentToShare:false});assert.equal(own.statusCode,200);
    assert.equal(own.json().candidates[0].name,'JF-UI-TEST-private-A');assert.equal(own.json().candidates[0].leaflet,null);
    for(const value of ['PRIVATE-LEAFLET','PRIVATE-LOCATION','quantity','2028-06','batches','familyId'])assert.equal(own.body.includes(value),false,value);
    const other=await call(b,'POST','/medicine-catalog/candidates',{barcode,consentToShare:false});assert.equal(other.statusCode,200);assert.equal(other.json().candidates.length,0);
    const ownName=await call(a,'POST','/medicine-catalog/candidates',{name:'JF-UI-TEST-private',consentToShare:false});assert.equal(ownName.statusCode,200);assert.equal(ownName.json().candidates[0].name,'JF-UI-TEST-private-A');
    const otherName=await call(b,'POST','/medicine-catalog/candidates',{name:'JF-UI-TEST-private',consentToShare:false});assert.equal(otherName.statusCode,200);assert.equal(otherName.json().candidates.length,0);
    const deleted=await call(a,'DELETE','/medicines/'+created.json().id);assert.equal(deleted.statusCode,204);
    const after=await call(a,'POST','/medicine-catalog/candidates',{barcode,consentToShare:false});assert.equal(after.statusCode,200);assert.equal(after.json().candidates.length,0);
  } finally {if(app)await app.close();await fixture.close();}
});
