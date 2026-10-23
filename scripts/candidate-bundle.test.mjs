import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {buildCandidate,verifyCandidate,ciReceipt} from './candidate-bundle.mjs';

const appId='wx0000000000000001',apiBase='https://synthetic.invalid';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'medbox-candidate-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const put=async(name,value)=>{await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),typeof value==='string'?value:JSON.stringify(value));};
 const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:['ignore','pipe','pipe']}).toString().trim();
 git('init');git('config','user.name','Synthetic CI');git('config','user.email','synthetic@example.invalid');
 await put('VERSION.json',{version:'1.0.6',androidBuild:8,channel:'candidate'});
 await put('apps/miniprogram/project.config.json',{appid:appId,libVersion:'3.17.3',setting:{minified:true,uploadWithSourceMap:false,urlCheck:false}});
 await put('apps/miniprogram/app.json',{pages:['pages/index/index'],lazyCodeLoading:'requiredComponents',sitemapLocation:'sitemap.json'});
 await put('apps/miniprogram/sitemap.json',{rules:[{action:'disallow',page:'*'}]});
 await put('apps/miniprogram/app.ts','App({});\n');await put('apps/miniprogram/services/config.ts','export const API_BASE = "http://127.0.0.1:13307";\n');
 await put('apps/miniprogram/pages/index/index.ts','Page({data:{synthetic:true}});\n');
 await put('apps/miniprogram/pages/index/index.wxml','<view>synthetic</view>\n');
 const commit=()=>{git('add','.');git('commit','-qm','合成候选夹具');return git('rev-parse','HEAD');};
 const sha=commit();const options={root,sha,appId,apiBase,output:join(root,'output')};return{root,put,git,commit,options};
}
test('exact candidate is reproducible and ignores a dirty tree and untracked secrets',async t=>{
 const f=await fixture(t);await f.put('apps/miniprogram/pages/index/index.ts','not committed');await f.put('apps/miniprogram/.env','SYNTHETIC_DO_NOT_COPY');
 const first=await buildCandidate(f.options);const second=await buildCandidate({...f.options,output:join(f.root,'second')});assert.deepEqual(first,second);
 assert.equal((await verifyCandidate(f.options)).ok,true);assert.equal(await readFile(join(f.root,'apps/miniprogram/pages/index/index.ts'),'utf8'),'not committed');
 assert.equal(first.stages.realDevice,'NOT_RUN');assert.equal(first.stages.formalRelease,'NOT_AUTHORIZED');
 await assert.rejects(lstat(join(f.options.output,'project/.env')),e=>e.code==='ENOENT');
});
test('symbolic refs and wrong expected identities fail closed',async t=>{
 const f=await fixture(t);await assert.rejects(buildCandidate({...f.options,sha:'HEAD'}),/exact/);await buildCandidate(f.options);
 await assert.rejects(verifyCandidate({...f.options,appId:'wx0000000000000002'}),/mismatch/);
 await assert.rejects(verifyCandidate({...f.options,apiBase:'https://other.invalid'}),/mismatch/);
 await f.put('VERSION.json',{version:'1.0.7',androidBuild:9,channel:'candidate'});const sha=f.commit();await assert.rejects(verifyCandidate({...f.options,sha}),/mismatch/);
});
for(const kind of ['changed','missing','extra','manifest'])test(`candidate verifier rejects ${kind} bytes`,async t=>{
 const f=await fixture(t);await buildCandidate(f.options);const file=join(f.options.output,'project/pages/index/index.ts');
 if(kind==='changed')await writeFile(file,'tampered');if(kind==='missing')await rm(file);if(kind==='extra')await writeFile(join(f.options.output,'project/extra.ts'),'extra');if(kind==='manifest')await writeFile(join(f.options.output,'manifest.json'),'{}');
 await assert.rejects(verifyCandidate(f.options),/changed|mismatch/);
});
test('existing output is never overwritten',async t=>{
 const f=await fixture(t);await mkdir(f.options.output);await writeFile(join(f.options.output,'preserved'),'keep');await assert.rejects(buildCandidate(f.options),e=>e.code==='EEXIST');assert.equal(await readFile(join(f.options.output,'preserved'),'utf8'),'keep');
});
test('symlink output ancestors and candidate entries are refused',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'outside'));await symlink(join(f.root,'outside'),join(f.root,'alias'),'dir');await assert.rejects(buildCandidate({...f.options,output:join(f.root,'alias','new')}),/Symbolic/);
 await buildCandidate(f.options);const file=join(f.options.output,'project/pages/index/index.ts');await rm(file);await symlink(join(f.root,'apps/miniprogram/pages/index/index.ts'),file);await assert.rejects(verifyCandidate(f.options),/Symbolic/);
});
test('unknown tracked production file types cannot enter candidate',async t=>{
 const f=await fixture(t);await f.put('apps/miniprogram/services/private.pem','synthetic');const sha=f.commit();await assert.rejects(buildCandidate({...f.options,sha}),/Unapproved/);
});
test('tracked source symlink cannot be dereferenced into candidate',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);await symlink('config.ts',join(f.root,'apps/miniprogram/services/alias.ts'));const sha=f.commit();await assert.rejects(buildCandidate({...f.options,sha}),/Unapproved/);
});
test('HTTP, credential-bearing origins and tourist appids are rejected before output',async t=>{
 const f=await fixture(t);for(const apiBase of ['http://localhost:13307','https://u:p@synthetic.invalid','https://synthetic.invalid/?token=x'])await assert.rejects(buildCandidate({...f.options,apiBase}));
 await assert.rejects(buildCandidate({...f.options,appId:'touristappid'}));await assert.rejects(lstat(f.options.output),e=>e.code==='ENOENT');
});
test('failed package gate never produces a ready manifest',async t=>{
 const f=await fixture(t);await f.put('apps/miniprogram/sitemap.json',{rules:[]});const sha=f.commit();await assert.rejects(buildCandidate({...f.options,sha}),/gate failed/);await assert.rejects(lstat(join(f.options.output,'manifest.json')),e=>e.code==='ENOENT');
});
test('CI receipt requires all prerequisites and never claims platform acceptance',()=>{
 const input={sha:'a'.repeat(40),runId:'123',attempt:'1',repository:'Jovifei/Medcial-box',results:{verify:'success','backup-docker':'success',flutter:'success'}};
 const receipt=ciReceipt(input);assert.equal(receipt.stages.wechatCompile,'NOT_RUN');assert.equal(receipt.workflowConclusion,'CHECK_GITHUB_AFTER_RUN_COMPLETES');
 for(const bad of ['failure','skipped','cancelled',undefined])assert.throws(()=>ciReceipt({...input,results:{...input.results,flutter:bad}}));
 assert.throws(()=>ciReceipt({...input,sha:'main'}));assert.throws(()=>ciReceipt({...input,repository:'other/repo'}));
});
