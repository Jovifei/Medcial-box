import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateAt, hash, verifyEvidence } from './family-pilot-evidence.mjs';
function fixture(run) {
  const dir=mkdtempSync(join(tmpdir(),'medbox-pilot-'));
  const put=(name,bytes)=>{writeFileSync(join(dir,name),bytes);return {path:name,sha256:hash(bytes)};};
  const photo=Buffer.from('synthetic-owned-photo-bytes');
  const snapshot={families:[{id:'f',name:'Household'}],members:[{id:'u',family_id:'f',role:'owner'}],medicines:[{id:'m',family_id:'f',name:'preserve content'}],batches:[{id:'b',medicine_id:'m',quantity:2}],photos:[{id:'p',family_id:'f',medicine_id:'m',storage_key:'leaflets/p.png',size_bytes:photo.length}],drafts:[{id:'d',family_id:'f',payload:{name:'pending input'}}],plans:[{id:'plan',family_id:'f',status:'active'}],reminders:[{id:'reminder',family_id:'f',status:'pending'}]};
  const evidence={candidate:candidateAt(),layer:'SYNTHETIC',before:put('before.json',JSON.stringify(snapshot)),after:put('after.json',JSON.stringify(snapshot)),photos:[{id:'p',storageKey:'leaflets/p.png',...put('photo.png',photo)}],backupDatabase:put('database.dump',Buffer.from('synthetic test binary dump')),backupPhotos:put('photos.tar.gz',Buffer.from('synthetic test archive')),buildImage:'sha256:'+'a'.repeat(64)};
  evidence.sourcePhotos=[{id:'p',storageKey:'leaflets/p.png',...put('source-photo.png',photo)}];
  const file=join(dir,'evidence.json');
  const save=()=>writeFileSync(file,JSON.stringify(evidence));save();
  try {run({dir,put,evidence,snapshot,file,save});} finally {rmSync(dir,{recursive:true});}
}
test('actual artifact checks pass and recover after corrupt-photo repair',()=>fixture(({dir,file})=>{
  verifyEvidence(file,{restore:true});writeFileSync(join(dir,'photo.png'),'corrupt');assert.throws(()=>verifyEvidence(file,{restore:true}));writeFileSync(join(dir,'photo.png'),'synthetic-owned-photo-bytes');verifyEvidence(file,{restore:true});
}));
for(const [name,mutate] of [
 ['empty photo hashes',f=>{f.evidence.photos=[];}],
 ['same-size corrupt bytes with forged hash',f=>{f.evidence.photos[0]={...f.evidence.photos[0],...f.put('photo.png','z'.repeat(27))};}],
 ['absent photo file',f=>{f.evidence.photos[0].path='missing.png';}],
 ['corrupted byte claim',f=>{writeFileSync(join(f.dir,'photo.png'),'corrupt');}],
 ['empty before and after',f=>{f.evidence.before=f.put('before.json','{}');f.evidence.after=f.put('after.json','{}');}],
 ['same IDs with content DATA LOST',f=>{f.snapshot.medicines[0].name='DATA LOST';f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['owner role changed',f=>{f.snapshot.members[0].role='member';f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
 ['invalid candidate',f=>{f.evidence.candidate.sha='garbage';}],
 ['missing backup',f=>{delete f.evidence.backupDatabase;}],
 ['empty backup',f=>{f.evidence.backupDatabase=f.put('database.dump','');}],
 ['cross-household photo',f=>{f.snapshot.photos[0].family_id='other';f.evidence.before=f.put('before.json',JSON.stringify(f.snapshot));f.evidence.after=f.put('after.json',JSON.stringify(f.snapshot));}],
]) test(`fail closed: ${name}`,()=>fixture(f=>{mutate(f);f.save();assert.throws(()=>verifyEvidence(f.file,{restore:true}));}));
