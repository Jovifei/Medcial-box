import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessCandidateReadiness, unverifiedStages, writeReadiness } from './candidate-readiness.mjs';

const sha = '1'.repeat(40), digest = 'a'.repeat(64);
const fixture = () => ({
  manifest: {
    schemaVersion:1, kind:'MEDBOX_SOURCE_CANDIDATE', sourceSha:sha,
    sourceTree:'2'.repeat(40), miniTree:'3'.repeat(40), packageSha256:digest,
    version:{version:'1.0.6',channel:'candidate',androidBuild:8},
    client:{appId:'wx1f6dd99d28aab8e5',apiBase:'https://medbox.joviluma.com'},
    files:{'app.ts':{bytes:18,sha256:digest}},stages:{...unverifiedStages},
  },
  receipt:{
    schemaVersion:1,sourceSha:sha,repository:'Jovifei/Medcial-box',
    runId:'1001',attempt:1,prerequisites:{verify:'success','backup-docker':'success',flutter:'success'},
    workflowConclusion:'CHECK_GITHUB_AFTER_RUN_COMPLETES',
    attestation:'UNSIGNED_CI_RECEIPT_NOT_A_SIGNATURE',stages:{...unverifiedStages},
  },
});
test('1.0.6 intake retains the fixed identity and forbids declaring untested deployment ready',()=>{
  const {manifest,receipt}=fixture();
  const report=assessCandidateReadiness(manifest,receipt);
  assert.equal(report.sourceSha,sha);
  assert.equal(report.packageSha256,digest);
  assert.equal(report.status,'ENGINEERING_CANDIDATE_ONLY');
  assert.equal(report.releaseAllowed,false);
  assert.equal(report.ci.independentGitHubRunVerification,'REQUIRED');
  assert.equal(report.ci.signature,'NONE');
  assert.equal(report.stages.realDevice,'NOT_RUN');
  assert.equal(report.stages.deployment,'NOT_PERFORMED');
  assert.equal(report.stages.formalRelease,'NOT_AUTHORIZED');
});
test('cross-SHA, failed prerequisite, rogue client and false device/production claims are rejected',()=>{
  for(const mutation of [
    p=>{p.receipt.sourceSha='0'.repeat(40);},
    p=>{p.receipt.prerequisites.verify='failure';},
    p=>{delete p.receipt.prerequisites.flutter;},
    p=>{p.manifest.client.apiBase='http://private.invalid';},
    p=>{p.manifest.version.version='1.0.5';},
    p=>{p.manifest.stages.realDevice='PASS';},
    p=>{p.receipt.stages.formalRelease='PASS';},
    p=>{p.receipt.attestation='SIGNED';},
    p=>{p.receipt.workflowConclusion='SUCCESS';},
    p=>{p.manifest.files['app.ts'].sha256='not-a-digest';},
  ]){
    const pair=fixture();mutation(pair);
    assert.throws(()=>assessCandidateReadiness(pair.manifest,pair.receipt));
  }
});
test('candidate intake writes a new immutable report and rejects replacing an existing one',async(t)=>{
  const fs=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'medbox-readiness-'));
  try{
    const manifestPath=join(root,'manifest.json'),receiptPath=join(root,'receipt.json'),
      outputPath=join(root,'out','readiness.json');
    const {manifest,receipt}=fixture();
    await writeFile(manifestPath,JSON.stringify(manifest));
    await writeFile(receiptPath,JSON.stringify(receipt));
    const report=await writeReadiness({manifestPath,receiptPath,outputPath});
    assert.equal(report.releaseAllowed,false);
    assert.equal(JSON.parse(await readFile(outputPath,'utf8')).sourceSha,sha);
    await assert.rejects(writeReadiness({manifestPath,receiptPath,outputPath}),/EEXIST/);
    await t.test('a symlink manifest is rejected when the host permits creating one',async(subtest)=>{
      const target=join(root,'real.json'),link=join(root,'manifest-link.json');
      await writeFile(target,JSON.stringify(manifest));
      try { await symlink(target,link); } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') { subtest.skip('host does not permit creating a symlink'); return; }
        throw error;
      }
      await assert.rejects(writeReadiness({manifestPath:link,receiptPath,outputPath:join(root,'never.json')}),/regular JSON/);
    });
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
