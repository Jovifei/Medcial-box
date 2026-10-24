// Exact-commit, offline candidate packaging. This never uploads, deploys or contacts an API.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, parse, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateClientConfig} from './prepare-miniprogram.mjs';
import {checkMiniProgramPackage} from './check-miniprogram-package.mjs';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const prefix = 'apps/miniprogram/';
const roots = new Set(['app.json', 'app.ts', 'app.wxss', 'sitemap.json', 'project.config.json']);
const production = /^(pages|services|components|assets)\//;
const excluded = /(^|\/)(test|typings|node_modules|dist|compiled)(\/|$)|(^|\/)\.|(?:private\.config|project\.private\.config|package|tsconfig)\.json$|\.map$/;
const extension = /\.(ts|json|wxml|wxss|png|jpe?g)$/i;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = value => JSON.stringify(value, null, 2) + '\n';
const stages = Object.freeze({sourcePackage:'PASS',wechatCompile:'NOT_RUN',wechatUpload:'NOT_RUN',realDevice:'NOT_RUN',androidInstall:'NOT_RUN',deployment:'NOT_PERFORMED',formalRelease:'NOT_AUTHORIZED'});
function git(root, args) {return execFileSync('git', ['-C', root, ...args], {maxBuffer:8*1024*1024});}
function exact(root, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('An exact 40-hex commit SHA is required');
  if (git(root, ['rev-parse', sha+'^{commit}']).toString().trim() !== sha) throw new Error('Commit mismatch');
}
function safeName(name) {
  const control=[...name].some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127);
  if (!name || name.includes('\\') || name.split('/').some(part => !part || part==='.' || part==='..') || control) throw new Error('Unsafe source path');
}
function plan(root, sha, appId, apiBase) {
  exact(root, sha);
  const config = validateClientConfig(appId, apiBase);
  const files = new Map();
  const entries = git(root, ['ls-tree','-r','-z',sha,'--','apps/miniprogram']).toString().split('\0').filter(Boolean);
  let sourceBytes = 0;
  for (const entry of entries) {
    const split=entry.indexOf('\t');
    const [mode,type,blob]=entry.slice(0,split).split(' ');
    const gitPath=entry.slice(split+1), name=gitPath.slice(prefix.length);
    safeName(name);
    if (excluded.test(name)) continue;
    if (!roots.has(name) && !production.test(name)) continue;
    if (mode!=='100644' || type!=='blob' || !extension.test(name)) throw new Error('Unapproved production source: '+name);
    const bytes=git(root,['cat-file','blob',blob]);
    sourceBytes+=bytes.length;
    if (sourceBytes>4*1024*1024) throw new Error('Candidate source budget exceeded');
    files.set(name,bytes);
  }
  for (const required of ['app.json','app.ts','project.config.json','services/config.ts']) if (!files.has(required)) throw new Error('Missing source: '+required);
  const project=JSON.parse(files.get('project.config.json').toString());
  project.appid=config.appId;
  project.projectname='JF小药箱-候选-'+sha.slice(0,7);
  project.setting={...project.setting,urlCheck:true};
  files.set('project.config.json',Buffer.from(jsonBytes(project)));
  files.set('services/config.ts',Buffer.from('// Generated public client configuration; no server secrets.\nexport const API_BASE = '+JSON.stringify(config.apiBase)+';\n'));
  const version=JSON.parse(git(root,['show',sha+':VERSION.json']).toString());
  if (version.channel!=='candidate' || typeof version.version!=='string' || !Number.isSafeInteger(version.androidBuild)) throw new Error('Candidate version metadata required');
  const hashes=Object.fromEntries([...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,bytes])=>[name,{sha256:sha256(bytes),bytes:bytes.length}]));
  const manifest={schemaVersion:1,kind:'MEDBOX_SOURCE_CANDIDATE',sourceSha:sha,sourceTree:git(root,['rev-parse',sha+'^{tree}']).toString().trim(),miniTree:git(root,['rev-parse',sha+':apps/miniprogram']).toString().trim(),version,client:config,files:hashes,packageSha256:sha256(JSON.stringify(hashes)),stages};
  return {files,manifest};
}
async function noLinks(path) {
  const absolute=resolve(path),base=parse(absolute).root;
  let at=base;
  for (const part of relative(base,absolute).split(/[\\/]/).filter(Boolean)) {
    at=join(at,part);
    try {if ((await lstat(at)).isSymbolicLink()) throw new Error('Symbolic links are not allowed: '+at);}
    catch(error) {if (error.code!=='ENOENT') throw error;}
  }
}
async function reserve(output) {
  await noLinks(output);
  await mkdir(dirname(output),{recursive:true});
  await noLinks(dirname(output));
  await mkdir(output); // Exclusive: do not replace any pre-existing candidate.
}
async function inventory(root, prefixPath='') {
  const result=[];
  for (const entry of await readdir(join(root,prefixPath),{withFileTypes:true})) {
    const name=prefixPath+entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symbolic link in candidate: '+name);
    if (entry.isDirectory()) result.push(...await inventory(root,name+'/'));
    else if (entry.isFile()) result.push(name);
    else throw new Error('Non-regular candidate file: '+name);
  }
  return result.sort();
}
export async function buildCandidate({root=workspace,sha,appId,apiBase,output}) {
  if (!output) throw new Error('A fresh output directory is required');
  const expected=plan(root,sha,appId,apiBase);
  const destination=resolve(output),project=join(destination,'project');
  await reserve(destination);
  await mkdir(project);
  for (const [name,bytes] of expected.files) {
    await mkdir(dirname(join(project,name)),{recursive:true});
    await writeFile(join(project,name),bytes,{flag:'wx'});
  }
  const gate=await checkMiniProgramPackage(project);
  if (!gate.ok) throw new Error('Candidate package gate failed: '+gate.errors.join('; '));
  // The manifest is the completion marker; partial output never counts as ready.
  await writeFile(join(destination,'manifest.json'),jsonBytes(expected.manifest),{flag:'wx'});
  await verifyCandidate({root,sha,appId,apiBase,output:destination});
  return expected.manifest;
}
export async function verifyCandidate({root=workspace,sha,appId,apiBase,output}) {
  if (!output) throw new Error('Candidate directory required');
  const destination=resolve(output);
  await noLinks(destination);
  const expected=plan(root,sha,appId,apiBase);
  const manifestPath=join(destination,'manifest.json');
  if (!(await lstat(manifestPath)).isFile() || (await lstat(manifestPath)).isSymbolicLink()) throw new Error('Manifest must be a regular file');
  if ((await lstat(manifestPath)).size>512*1024) throw new Error('Manifest too large');
  const actualManifest=await readFile(manifestPath,'utf8');
  if (actualManifest!==jsonBytes(expected.manifest)) throw new Error('Candidate manifest/source/config mismatch');
  const names=await inventory(destination);
  const expectedNames=['manifest.json',...[...expected.files.keys()].map(name=>'project/'+name)].sort();
  if (JSON.stringify(names)!==JSON.stringify(expectedNames)) throw new Error('Candidate file set mismatch');
  for (const [name,bytes] of expected.files) {
    if ((await lstat(join(destination,'project',name))).size !== bytes.length) throw new Error('Candidate size changed: '+name);
    const actual=await readFile(join(destination,'project',name));
    if (!actual.equals(bytes)) throw new Error('Candidate bytes changed: '+name);
  }
  const gate=await checkMiniProgramPackage(join(destination,'project'));
  if (!gate.ok) throw new Error('Candidate package gate failed: '+gate.errors.join('; '));
  return {ok:true,sourceSha:sha,miniTree:expected.manifest.miniTree,packageSha256:expected.manifest.packageSha256,files:expected.files.size,stages};
}
export function ciReceipt({sha,runId,attempt,repository,results}) {
  if (!/^[0-9a-f]{40}$/.test(sha??'') || !/^[1-9][0-9]*$/.test(String(runId)) || !/^[1-9][0-9]*$/.test(String(attempt)) || repository!=='Jovifei/Medcial-box') throw new Error('Exact CI identity required');
  for (const key of ['verify','backup-docker','flutter']) if (results?.[key]!=='success') throw new Error('Required CI prerequisite not successful: '+key);
  return {schemaVersion:1,sourceSha:sha,runId:String(runId),attempt:Number(attempt),repository,prerequisites:Object.fromEntries(['verify','backup-docker','flutter'].map(key=>[key,results[key]])),workflowConclusion:'CHECK_GITHUB_AFTER_RUN_COMPLETES',attestation:'UNSIGNED_CI_RECEIPT_NOT_A_SIGNATURE',stages};
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),command=args.shift();
  const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  try {
    if (command==='receipt') {
      const value=ciReceipt({sha:option('--sha'),runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,repository:process.env.GITHUB_REPOSITORY,results:JSON.parse(process.env.MEDBOX_JOB_RESULTS??'{}')});
      const file=option('--output');if (!file) throw new Error('Receipt output required');
      await noLinks(file);await mkdir(dirname(resolve(file)),{recursive:true});
      await writeFile(file,jsonBytes(value),{flag:'wx'});console.info(jsonBytes(value));
    } else {
      const options={root:option('--root')??workspace,sha:option('--sha'),appId:option('--appid'),apiBase:option('--api-base'),output:option('--output')};
      if (!['build','verify'].includes(command)) throw new Error('Use build, verify or receipt');
      console.info(jsonBytes(await (command==='build'?buildCandidate(options):verifyCandidate(options))));
    }
  } catch(error) {console.error(error instanceof Error?error.message:'Candidate operation failed');process.exitCode=1;}
}
