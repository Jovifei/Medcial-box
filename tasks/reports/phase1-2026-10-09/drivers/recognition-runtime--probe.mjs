import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const root=(process.env.PHASE1_ROOT ?? 'E:/project/medcial_box').replaceAll(String.fromCharCode(92),'/');
const load=p=>import(pathToFileURL(root+'/'+p));
const {buildServer}=await load('apps/api/dist/app.js');
const {FakeWechatGateway}=await load('apps/api/dist/auth/wechat.js');
const {createFakePool}=await load('apps/api/test/helpers/fake-pool.mjs');
const {login,membershipRow}=await load('apps/api/test/helpers/app.mjs');
const {OllamaMedicineRecognitionProvider,DashscopeMedicineRecognitionProvider}=await load('apps/api/dist/services/medicine-recognition.js');
const results=[];let calls=0;
const pool=createFakePool();
const app=await buildServer({database:pool,logger:false,wechatGateway:new FakeWechatGateway().registerCode('js-code-1','openid-user-1'),medicineRecognitionProvider:{async recognize(){calls++;return {draft:{},warnings:[],requiresConfirmation:true};}}});
try {
 const token=await login(app,pool,{membership:membershipRow()});const headers={authorization:'Bearer '+token};
 const response=await app.inject({method:'POST',url:'/api/v1/recognitions/medicine',headers,payload:{imageBase64:'A'.repeat(6*1024*1024+4),mimeType:'image/png'}});
 results.push({id:'F07',status:response.statusCode,body:response.json(),providerCalls:calls,expected:413,reproduced:response.statusCode===500&&calls===0});
 const png=Buffer.alloc(128);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(2147483647,16);png.writeUInt32BE(2147483647,20);Buffer.from([73,69,78,68,174,66,96,130]).copy(png,120);
 const extreme=await app.inject({method:'POST',url:'/api/v1/recognitions/medicine',headers,payload:{imageBase64:png.toString('base64'),mimeType:'image/png'}});
 results.push({id:'F03',status:extreme.statusCode,providerCalls:calls,width:2147483647,height:2147483647,inputBytes:128,syntheticEnvelopeNotDecodable:true,reproduced:extreme.statusCode===200&&calls===1});
 for(const imageBytes of [4*1024*1024-1,4*1024*1024,4*1024*1024+1]) {
  const jpg=Buffer.alloc(imageBytes);Buffer.from([255,216,255]).copy(jpg);Buffer.from([255,217]).copy(jpg,imageBytes-2);const before=calls;
  const res=await app.inject({method:'POST',url:'/api/v1/recognitions/medicine',headers,payload:{imageBase64:jpg.toString('base64'),mimeType:'image/jpeg'}});
  results.push({id:'image-byte-boundary',imageBytes,status:res.statusCode,body:res.json(),providerCalls:calls-before,syntheticEnvelopeNotDecodable:true});
 }
}finally{await app.close();}
for(const [name,make] of [['ollama',fetch=>new OllamaMedicineRecognitionProvider('test','http://synthetic.invalid',fetch)],['dashscope',fetch=>new DashscopeMedicineRecognitionProvider('synthetic','test','http://synthetic.invalid',fetch)]]) {
 let bytes=0;const text=JSON.stringify({error:'x'.repeat(2*1024*1024)});const enc=new TextEncoder();let position=0;
 const stream=new ReadableStream({pull(controller){if(position===text.length){controller.close();return;}const chunk=text.slice(position,position+65536);position+=chunk.length;bytes+=chunk.length;controller.enqueue(enc.encode(chunk));}});
 try{await make(async()=>new Response(stream,{status:503})).recognize('synthetic','image/png');}catch(error){results.push({id:'F04-error',provider:name,consumedBytes:bytes,responseBytes:text.length,reason:error.reason,reproduced:bytes===text.length});}
 const content=JSON.stringify({name:'synthetic',ignored:'x'.repeat(2*1024*1024)});const payload=name==='ollama'?{message:{content}}:{choices:[{message:{content}}]};const result=await make(async()=>new Response(JSON.stringify(payload))).recognize('synthetic','image/png');
 results.push({id:'F04-success',provider:name,responseBytes:JSON.stringify(payload).length,draftName:result.draft.name,acceptedOver2MiB:true});
 const broken=new ReadableStream({start(controller){controller.error(new DOMException('synthetic body abort','AbortError'));}});
 try{await make(async()=>new Response(broken)).recognize('synthetic','image/png');}catch(error){results.push({id:'F04-body-abort',provider:name,reason:error.reason,expected:'timeout',reproduced:error.reason==='invalid_json'});}
}
await writeFile(new URL('./results.json',import.meta.url),JSON.stringify({baseline:'85bfe729f2089db2ee48040b450293511e8ce9c7',database:'FAKE_ONLY',network:'NONE',results},null,2));
console.log(JSON.stringify(results,null,2));assert.ok(results[0].reproduced);assert.ok(results[1].reproduced);


