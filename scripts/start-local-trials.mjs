/** Local standalone QA only: never expose the fake WeChat gateway publicly. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url));
const catalog=path.join(root,'.local-data','medicine-catalog','catalog.json');
const logs=path.join(root,'.local-data','logs');
await mkdir(path.dirname(catalog),{recursive:true});await mkdir(logs,{recursive:true});
try{await writeFile(catalog,JSON.stringify({version:1,entries:[]}),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
await stat(path.join(root,'apps','api','dist','app.js')).catch(()=>{throw new Error('先运行 npm run build --workspace @home-medicine/api');});
let info;
try{info=JSON.parse(execFileSync('docker',['inspect','medbox-pg-test'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))[0];}catch{throw new Error('本项目本机测试数据库 medbox-pg-test 未就绪');}
const values=Object.fromEntries(info.Config.Env.map(item=>{const index=item.indexOf('=');return[item.slice(0,index),item.slice(index+1)];}));
const database=new URL('postgresql://127.0.0.1:55432/medbox_flutter_qa_20261003');database.username=values.POSTGRES_USER||'postgres';database.password=values.POSTGRES_PASSWORD||'';
if(!database.password)throw new Error('本机数据库凭据未就绪');
for(const config of [{port:13306,openid:'dev-openid-medbox-qa-20261003'},{port:13307,openid:'dev-openid-mini-qa-20261004'}]){
 const health='http://127.0.0.1:'+config.port+'/api/v1/health/local-app-trial';
 try{const response=await fetch(health,{signal:globalThis.AbortSignal.timeout(5000)});if(response.ok&&(await response.json()).mode==='local-app-trial'){console.log(JSON.stringify({port:config.port,status:'already-running'}));continue;}}catch{ /* The service may not be running yet. */ }
 const log=await open(path.join(logs,'local-api-'+config.port+'.log'),'a');
 const child=spawn(process.execPath,['scripts/dev-simulator-server.mjs',String(config.port),'qwen3.5:9b'],{cwd:root,env:{...process.env,DATABASE_URL:database.toString(),DEV_OPENID:config.openid,MEDICINE_CATALOG_PROVIDER:'local',MEDICINE_CATALOG_LOCAL_FILE:catalog},detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
 child.unref();await log.close();
 let ready=false;for(let attempt=0;attempt<25;attempt++){await new Promise(resolve=>setTimeout(resolve,200));try{const response=await fetch(health,{signal:globalThis.AbortSignal.timeout(5000)});ready=response.ok&&(await response.json()).serverPid===child.pid;if(ready)break;}catch{ /* The service may not be running yet. */ }}
 if(!ready)throw new Error('本机试用服务启动失败，请检查本机日志与数据库迁移');
 console.log(JSON.stringify({port:config.port,status:'started',pid:child.pid,catalogProvider:'local'}));
}
