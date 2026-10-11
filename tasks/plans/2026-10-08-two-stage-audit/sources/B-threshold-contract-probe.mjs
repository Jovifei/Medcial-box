#!/usr/bin/env node
/**
 * Read-only contract probe for the audited mini-program onSaveThreshold path.
 * Run after `npm run build`, using a reviewed local checkout.
 * Does NOT start Fastify, connect to PostgreSQL, call a provider, or edit source.
 * It executes the actual TS page method (transpiled in a stub UI context), then
 * invokes the checkout's built validateMedicineUpdateInput().
 * A successful probe is NOT an end-to-end / PostgreSQL / release PASS.
 * Exit 0: this narrow contract retained data; 1: loss-risk reproduced;
 * 2: setup/interface changed, evidence insufficient. Rebase tests; never waive.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const HASH = text => createHash('sha256').update(text).digest('hex');
const AUDITED_SHA = 'f675416ced73b59144c1f3d327dcdc741608a84e';
function argsOf(args) {
  const result = {};
  for (let i=0; i<args.length; i++) {
    if (!['--repo','--out'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--'))
      throw new Error('Usage: node 04_probe_threshold_contract.mjs --repo <checkout> --out <new-report.json>');
    result[args[i].slice(2)] = args[++i];
  }
  if (!result.repo || !result.out) throw new Error('Both --repo and --out are required.');
  return result;
}
async function main() {
  const options = argsOf(process.argv.slice(2));
  const root = resolve(options.repo), out = resolve(options.out);
  // This loads only packages installed in the target repository, not a global SDK.
  const requireAtRepo = createRequire(join(root,'package.json'));
  const ts = requireAtRepo('typescript');
  const pagePath = join(root,'apps/miniprogram/pages/medicine-detail/medicine-detail.ts');
  const inputPath = join(root,'apps/api/src/inputs.ts');
  const compiledPath = join(root,'apps/api/dist/inputs.js');
  const [pageSource, inputSource, builtSource] = await Promise.all([pagePath,inputPath,compiledPath].map(p=>readFile(p,'utf8')));
  const source = ts.createSourceFile(pagePath,pageSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const matches = [];
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name && node.name.getText(source)==='onSaveThreshold') matches.push(node);
    ts.forEachChild(node,visit);
  }
  visit(source);
  if (matches.length!==1) throw new Error('Expected exactly one onSaveThreshold method; source changed. Adapt the regression test, do not mark PASS.');
  const module = ts.transpileModule(`globalThis.extracted = ({${matches[0].getText(source)}});`,{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},reportDiagnostics:true,
  });
  if ((module.diagnostics??[]).some(d=>d.category===ts.DiagnosticCategory.Error)) throw new Error('Page method transpilation failed.');
  const { validateMedicineUpdateInput } = await import(pathToFileURL(compiledPath).href);
  if (typeof validateMedicineUpdateInput!=='function') throw new Error('Production validator not found; run the locked build or adapt the test.');
  const medicine = {
    id:'00000000-0000-4000-8000-000000000001', version:1,
    name:'QA合成库存样本-不得服用', brand:'QA品牌', specification:'测试规格', manufacturer:'QA测试厂家',
    approvalNumber:null, barcodeValue:'QA-BARCODE-SENTINEL', activeIngredients:['QA合成成分'],
    purposeCategory:'other', populationTags:['adult'], purposeTags:['other'],
    leaflet:{purposeSummary:null,packageUsageSummary:null,contraindicationsSummary:null,precautionsSummary:null,source:null,reviewStatus:'unverified'},
    batches:[
      {id:'00000000-0000-4000-8000-000000000011',version:1,lotNumber:'QA-LOT-A',quantity:2,unit:'box',expiryValue:'2027-12',expiryPrecision:'month'},
      {id:'00000000-0000-4000-8000-000000000012',version:1,lotNumber:'QA-LOT-B',quantity:5,unit:'box',expiryValue:'2028-06-30',expiryPrecision:'day'},
    ],
  };
  const results=[];
  for (const enabled of [true,false]) {
    const calls=[],toasts=[];
    const sandbox={
      api:{updateMedicine:async(id,payload)=>{calls.push({id,payload:JSON.parse(JSON.stringify(payload))});return medicine;}},
      ensureLoggedIn:async()=>{},
      // Only a valid integer input is tested. These stubs exclude quantity validation from this probe's claim.
      parseQuantityByUnit:(text,unit)=>unit==='box'&&/^\d+$/.test(text)?Number(text):null,
      unitAllowsDecimals:()=>false,
      wx:{showToast:arg=>toasts.push(arg)},
      showError:error=>{throw error;},
    };
    vm.createContext(sandbox,{codeGeneration:{strings:false,wasm:false}});
    new vm.Script(module.outputText).runInContext(sandbox,{timeout:1000});
    const page={data:{medicineSummary:structuredClone(medicine),savingThreshold:false,thresholdEnabled:enabled,thresholdQuantity:'3',thresholdUnitIndex:0,thresholdUnitValues:['box']},
      setData(value){Object.assign(this.data,value);},refresh:async()=>{}};
    await sandbox.extracted.onSaveThreshold.call(page);
    if(calls.length!==1)throw new Error(`Expected one updateMedicine request, got ${calls.length}; path changed. Adapt tests.`);
    const request=calls[0];
    const parsed=validateMedicineUpdateInput(request.payload,medicine.batches);
    const assertions=[];
    function check(name,ok,details){assertions.push({name,ok,details});}
    check('validator_accepts_request',parsed.ok,parsed.ok?'accepted':parsed.message);
    if(parsed.ok){
      const value=parsed.value;
      check('all_existing_batch_ids_retained',JSON.stringify(value.batches.map(b=>b.id).sort())===JSON.stringify(medicine.batches.map(b=>b.id).sort()),{beforeIds:medicine.batches.map(b=>b.id),afterIds:value.batches.map(b=>b.id)});
      check('barcode_retained',value.barcodeValue===medicine.barcodeValue,{before:medicine.barcodeValue,after:value.barcodeValue});
      for(const key of ['populationTags','purposeTags']) check(`${key}_retained`,JSON.stringify(value[key])===JSON.stringify(medicine[key]),{before:medicine[key],after:value[key]});
    }
    results.push({variant:enabled?'enable_threshold':'disable_threshold',synthetic_request:request,assertions,
      result:assertions.every(a=>a.ok)?'CONTRACT_PRESERVED_ONLY':'LOSS_RISK_REPRODUCED'});
  }
  let head=null;
  try{head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
  const report={kind:'READ_ONLY_CONTRACT_PROBE_NOT_DATABASE_TEST',created_at:new Date().toISOString(),audited_sha:AUDITED_SHA,local_head:head,
    local_head_matches_audit:head===AUDITED_SHA,production_files:{page_sha256:HASH(pageSource),inputs_source_sha256:HASH(inputSource),inputs_dist_sha256:HASH(builtSource)},
    limitations:['Run a fresh locked npm build before this probe. Source and dist hashes are recorded, not a reproducible-build proof.',
      'Actual page method and production validator executed; wx/network/login/refresh are stubs.',
      'No Fastify routing, SQL, PostgreSQL transaction, device, photo, or model was executed.',
      'A changed endpoint or method requires adapting this probe; do not interpret setup failure as fixed.',
      'Source audit separately connects empty parsed batches to deleteBatch; real PostgreSQL reproduction is REG-01/02.'],
    results,release_verdict:'NOT_ASSESSED_BY_THIS_PROBE'};
  await mkdir(dirname(out),{recursive:true});
  await writeFile(out,JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(`Report created: ${out}`);
  for(const r of results) console.log(`${r.variant}: ${r.result}`);
  process.exitCode=results.some(r=>r.result==='LOSS_RISK_REPRODUCED')?1:0;
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=2;});
