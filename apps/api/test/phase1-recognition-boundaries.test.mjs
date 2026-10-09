import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { buildServer } from "../dist/app.js";
import { OllamaMedicineRecognitionProvider } from "../dist/services/medicine-recognition.js";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { login, membershipRow } from "./helpers/app.mjs";
import { createTestGateway } from "./helpers/fake-wechat.mjs";

const bytes = size => {
  const value = Buffer.alloc(size);
  value.set([255,216,255],0);
  value.set([255,217],size-2);
  return value.toString("base64");
};
const tiny = bytes(200);

test("AUD-07 large image: exact 4MiB reaches provider, +1 fails 4xx without provider call", async () => {
  const pool = createFakePool();
  let calls = 0;
  const app = await buildServer({
    database:pool,logger:false,wechatGateway:createTestGateway({"js-code-1":"openid-user-1"}),
    medicineRecognitionProvider:{ async recognize() { calls++; return {draft:{name:"合成药"},warnings:[],requiresConfirmation:true}; } },
  });
  try{
    const token=await login(app,pool,{membership:membershipRow()});
    const headers={authorization:`Bearer ${token}`};
    const endpoint="/api/v1/recognitions/medicine";
    const good=await app.inject({method:"POST",url:endpoint,headers,payload:{imageBase64:bytes(4*1024*1024),mimeType:"image/jpeg"}});
    assert.equal(good.statusCode,200,good.body.slice(0,300));
    assert.equal(good.json().requiresConfirmation,true);
    const tooLarge=await app.inject({method:"POST",url:endpoint,headers,payload:{imageBase64:bytes(4*1024*1024+1),mimeType:"image/jpeg"}});
    assert.equal(tooLarge.statusCode,400,tooLarge.body.slice(0,300));
    assert.equal(calls,1);
    assert.equal(pool.callsMatching(/INSERT INTO medicines|INSERT INTO medicine_batches/).length,0);
  }finally{await app.close();}
});

test("AUD-08 Fastify parser keeps sanitized HTTP413 for a body larger than the route limit", async () => {
  const pool=createFakePool();
  const app=await buildServer({database:pool,logger:false,wechatGateway:createTestGateway({"js-code-1":"openid-user-1"})});
  try{
    const token=await login(app,pool,{membership:membershipRow()});
    const response=await app.inject({method:"POST",url:"/api/v1/recognitions/medicine",
      headers:{authorization:`Bearer ${token}`},payload:{imageBase64:"A".repeat(7*1024*1024),mimeType:"image/jpeg"}});
    assert.equal(response.statusCode,413,response.body.slice(0,300));
    assert.equal(response.json().error.code,"VALIDATION_ERROR");
    assert.equal(response.body.includes("stack"),false);
  }finally{await app.close();}
});

test("AUD-09/10 oversized JSON stream is canceled and later normal OCR still succeeds", async () => {
  let canceled=0;
  const many = new Uint8Array(600*1024).fill(65);
  const huge = new OllamaMedicineRecognitionProvider("synthetic","http://fake.test",async()=>new Response(
    new ReadableStream({
      start(controller){controller.enqueue(many);},
      cancel(){canceled++;}
    }),{status:200}));
  await assert.rejects(huge.recognize(tiny,"image/jpeg"),error=>error.reason==="invalid_json");
  assert.equal(canceled,1,"oversized body reader must cancel remaining stream");
  const normal=new OllamaMedicineRecognitionProvider("synthetic","http://fake.test",async()=>new Response(
    JSON.stringify({message:{content:JSON.stringify({name:"合成药",specification:"12小时"})}})));
  const result=await normal.recognize(tiny,"image/jpeg");
  assert.equal(result.draft.name,"合成药");
  assert.equal(result.draft.specification,null);
  assert.equal(result.requiresConfirmation,true);
});

test("AUD-10 AbortError during body-read is transport failure, malformed JSON is invalid_json",async()=>{
  const abort=new OllamaMedicineRecognitionProvider("synthetic","http://fake.test",async()=>new Response(
    new ReadableStream({start(c){c.error(new DOMException("synthetic aborted","AbortError"));}}),{status:200}));
  await assert.rejects(abort.recognize(tiny,"image/jpeg"),error=>error.reason==="provider_unavailable");
  const syntax=new OllamaMedicineRecognitionProvider("synthetic","http://fake.test",async()=>new Response(
    JSON.stringify({message:{content:"NOT JSON"}}),{status:200}));
  await assert.rejects(syntax.recognize(tiny,"image/jpeg"),error=>error.reason==="invalid_json");
});
