import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { candidateAt, hash, verifyEvidence } from './family-pilot-evidence.mjs';
function fixture(run) {
  const dir=mkdtempSync(join(tmpdir(),'medbox-pilot-'));
  const put=(name,bytes)=>{writeFileSync(join(dir,name),bytes);return {path:name,sha256:hash(bytes)};};
  const photo=Buffer.from('synthetic-owned-photo-bytes');
  const snapshot={families:[{id:'f',name:'Household'}],members:[{id:'u',family_id:'f',role:'owner'}],medicines:[{id:'m',family_id:'f',name:'preserve content'}],batches:[{id:'b',medicine_id:'m',quantity:2}],photos:[{id:'p',family_id:'f',medicine_id:'m',storage_key:'leaflets/p.png',size_bytes:photo.length}],drafts:[{id:'d',family_id:'f',payload:{name:'pending input'}}],careProfiles:[{id:'care',family_id:'f',display_name:'Preserve profile'}],plans:[{id:'plan',family_id:'f',status:'active'}],planSlots:[{id:'slot',plan_id:'plan',time_of_day:'09:00'}],doseOccurrences:[],careGrants:[],doseReminders:[],reminders:[{id:'reminder',family_id:'f',status:'pending'}],schemaMigrations:[{name:'001_initial.sql',checksum:'a'.repeat(64),applied_at:'2026-10-12T00:00:00.000Z'}]};
  const evidence={candidate:candidateAt(),layer:'SYNTHETIC',before:put('before.json',JSON.stringify(snapshot)),after:put('after.json',JSON.stringify(snapshot)),photos:[{id:'p',storageKey:'leaflets/p.png',...put('photo.png',photo)}],backupDatabase:put('database.dump',Buffer.from('synthetic test binary dump')),backupPhotos:put('photos.tar.gz',Buffer.from('synthetic test archive')),buildImage:'sha256:'+'a'.repeat(64)};
  evidence.sourcePhotos=[{id:'p',storageKey:'leaflets/p.png',...put('source-photo.png',photo)}];
  const file=join(dir,'evidence.json');
  const save=()=>writeFileSync(file,JSON.stringify(evidence));save();
  try {run({dir,put,evidence,snapshot,file,save});} finally {rmSync(dir,{recursive:true});}
}
test('actual artifact checks pass and recover after corrupt-photo repair',()=>fixture(({dir,file})=>{
  verifyEvidence(file,{restore:true});writeFileSync(join(dir,'photo.png'),'corrupt');assert.throws(()=>verifyEvidence(file,{restore:true}));writeFileSync(join(dir,'photo.png'),'synthetic-owned-photo-bytes');verifyEvidence(file,{restore:true});
}));
test('explicit empty dose collections and applied schema migration receipts survive the evidence round trip',()=>fixture(({snapshot,file})=>{
  for(const table of ['doseOccurrences','careGrants','doseReminders'])assert.deepEqual(snapshot[table],[]);
  assert.equal(snapshot.schemaMigrations.length,1);
  verifyEvidence(file,{restore:true});
}));
test('upgrade evidence retains prior receipts and records a newly applied migration',()=>fixture(f=>{
  const upgraded=structuredClone(f.snapshot);
  upgraded.schemaMigrations.push({name:'002_add_household_scope.sql',checksum:'b'.repeat(64),applied_at:'2026-10-12T00:01:00.000Z'});
  f.evidence.after=f.put('upgraded-after.json',JSON.stringify(upgraded));f.save();
  assert.equal(verifyEvidence(f.file).schemaMigrations,2);
  assert.throws(()=>verifyEvidence(f.file,{restore:true}),'backup restore must preserve the exact receipt set');
}));
test('identical synthetic photo bytes remain paired by household, medicine, photo id, and storage key',()=>fixture(f=>{
  const photo=Buffer.from('synthetic-owned-photo-bytes');
  const secondKey='leaflets/f2/m2/p2.png';
  const snapshot=structuredClone(f.snapshot);
  snapshot.families.push({id:'f2',name:'Second household'});
  snapshot.members.push({id:'u2',family_id:'f2',role:'owner'});
  snapshot.medicines.push({id:'m2',family_id:'f2',name:'Second medicine'});
  snapshot.photos.push({id:'p2',family_id:'f2',medicine_id:'m2',storage_key:secondKey,size_bytes:photo.length});
  f.evidence.before=f.put('two-household-before.json',JSON.stringify(snapshot));
  f.evidence.after=f.put('two-household-after.json',JSON.stringify(snapshot));
  f.evidence.photos.push({id:'p2',storageKey:secondKey,...f.put('photo-two.png',photo)});
  f.evidence.sourcePhotos.push({id:'p2',storageKey:secondKey,...f.put('source-photo-two.png',photo)});
  f.evidence.photos.reverse();f.evidence.sourcePhotos.reverse();f.save();
  assert.equal(f.evidence.photos[0].sha256,f.evidence.photos[1].sha256,'both household fixtures intentionally use the same bytes');
  assert.notEqual(f.evidence.photos[0].storageKey,f.evidence.photos[1].storageKey);
  verifyEvidence(f.file,{restore:true});
  f.evidence.photos.find(item=>item.id==='p2').storageKey='leaflets/p.png';f.save();
  assert.throws(()=>verifyEvidence(f.file,{restore:true}),'photo artifacts must match both id and storage key');
}));
for(const [name,mutate] of [
 ['empty photo hashes',f=>{f.evidence.photos=[];}],
 ['same-size corrupt bytes with forged hash',f=>{f.evidence.photos[0]={...f.evidence.photos[0],...f.put('photo.png','z'.repeat(27))};}],
 ['absent photo file',f=>{f.evidence.photos[0].path='missing.png';}],
 ['corrupted byte claim',f=>{writeFileSync(join(f.dir,'photo.png'),'corrupt');}],
 ['empty before and after',f=>{f.evidence.before=f.put('before.json','{}');f.evidence.after=f.put('after.json','{}');}],
 ['same IDs with content DATA LOST',f=>{f.snapshot.medicines[0].name='DATA LOST';f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['plan time lost with same plan ID',f=>{f.snapshot.planSlots[0].time_of_day='18:00';f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['care profile DATA LOST',f=>{f.snapshot.careProfiles[0].display_name='DATA LOST';f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['ownerless original and restored household',f=>{f.snapshot.members[0].role='member';f.evidence.before=f.put('before.json',JSON.stringify(f.snapshot));f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['owner role changed',f=>{f.snapshot.members[0].role='member';f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['invalid candidate',f=>{f.evidence.candidate.sha='garbage';}],
 ['missing backup',f=>{delete f.evidence.backupDatabase;}],
 ['empty backup',f=>{f.evidence.backupDatabase=f.put('database.dump','');}],
 ['cross-household photo',f=>{f.snapshot.photos[0].family_id='other';f.evidence.before=f.put('before.json',JSON.stringify(f.snapshot));f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['missing empty dose occurrences',f=>{delete f.snapshot.doseOccurrences;f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['null empty care grants',f=>{f.snapshot.careGrants=null;f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['missing empty dose reminders',f=>{delete f.snapshot.doseReminders;f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['missing migration receipt after restore',f=>{f.snapshot.schemaMigrations=[];f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['changed migration receipt checksum after restore',f=>{f.snapshot.schemaMigrations[0].checksum='b'.repeat(64);f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
]) test(`fail closed: ${name}`,()=>fixture(f=>{mutate(f);f.save();assert.throws(()=>verifyEvidence(f.file,{restore:true}));}));

test('manifest caller Boolean requests are SOURCE_ONLY and never executed restore evidence',()=>fixture(({dir})=>{
  const file=join(dir,'manifest.json');
  writeFileSync(file,JSON.stringify({stage:'family-pilot',release:{mergeAllowed:false,productionDeployment:false},secrets:{valuesIncluded:false},requiredChecks:{databaseBackupRestore:true,privatePhotoRestorePairing:true},before:{},after:{},restoreSucceeded:true}));
  const result=JSON.parse(execFileSync(process.execPath,['scripts/check-family-pilot-manifest.mjs',file],{encoding:'utf8'}));
  assert.equal(result.scope,'SOURCE_ONLY');assert.equal(result.sourceContract,'PASS');
  assert.equal(result.databaseBackupRestore,'NOT_RUN');assert.equal(result.privatePhotoRestorePairing,'NOT_RUN');assert.equal(result.productionRestore,'NOT_RUN');
}));
