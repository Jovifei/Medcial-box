import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, copyFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { candidateAt, hash, verifyEvidence } from '../../../scripts/family-pilot-evidence.mjs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { applyMigrations } from '../dist/db/migrations.js';
import { isolatedPostgres } from './helpers/isolated-pg.mjs';
import { buildServer } from '../dist/app.js';
import { createTestGateway } from './helpers/fake-wechat.mjs';
const url=process.env.TEST_DATABASE_URL;
test('real PG: old two-household upgrade/rerun and session/invitation/product isolation', {skip:!url && process.env.REQUIRE_POSTGRES_TESTS!=='1'},async()=>{
  assert(url,'strict PG resource required');
  const fixture=await isolatedPostgres(url);
  const {pool,database}=fixture;
  const oldDir=await mkdtemp(join(tmpdir(),'medbox-legacy-migrations-'));
  let app;
  try {
    for(const name of await readdir('db/migrations')) if(Number(name.split('_')[0])<=31) await copyFile(join('db/migrations',name),join(oldDir,name));
    await applyMigrations(pool,oldDir);
    const u=(await pool.query("INSERT INTO users(openid) VALUES('synthetic-a'),('synthetic-b') RETURNING *")).rows;
    const f=[];
    const photoBytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaDjwHwAEhAJgikCezQAAAABJRU5ErkJggg==","base64");
    for(let i=0;i<2;i++) {
      f.push((await pool.query('INSERT INTO families(name,created_by) VALUES($1,$2) RETURNING *',[`Household ${i}`,u[i].id])).rows[0]);
      await pool.query("INSERT INTO family_members(family_id,user_id,role) VALUES($1,$2,'owner')",[f[i].id,u[i].id]);
      const medicine=(await pool.query('INSERT INTO medicines(family_id,name,created_by,updated_by) VALUES($1,$2,$3,$3) RETURNING *',[f[i].id,`Preserved content ${i}`,u[i].id])).rows[0];
      const batch=(await pool.query("INSERT INTO medicine_batches(family_id,medicine_id,quantity,unit,expiry_value,expiry_precision,created_by,updated_by) VALUES($1,$2,2,'box','2099-12','month',$3,$3) RETURNING id",[f[i].id,medicine.id,u[i].id])).rows[0];
      await pool.query("INSERT INTO medicine_leaflet_photos(family_id,medicine_id,storage_key,content_type,size_bytes,created_by,purpose,upload_completed_at) VALUES($1,$2,$3,'image/png',$5,$4,'box_front',now())",[f[i].id,medicine.id,`leaflets/fixture-${i}.png`,u[i].id,photoBytes.length]);
      const care=(await pool.query("INSERT INTO care_profiles(family_id,display_name,linked_user_id,created_by) VALUES($1,'Synthetic profile',$2,$2) RETURNING id",[f[i].id,u[i].id])).rows[0];
      await pool.query("INSERT INTO medication_plans(family_id,care_profile_id,medicine_id,medicine_name,dosage_text,start_date,created_by) VALUES($1,$2,$3,'Synthetic medicine','Owner supplied synthetic text','2099-01-01',$4)",[f[i].id,care.id,medicine.id,u[i].id]);
      await pool.query("INSERT INTO reminder_deliveries(family_id,user_id,medicine_id,batch_id,deadline_date,days_before,template_id) VALUES($1,$2,$3,$4,'2099-12-31',30,'synthetic-unused')",[f[i].id,u[i].id,medicine.id,batch.id]);
    }
    await pool.query("INSERT INTO plan_time_slots(plan_id,time_of_day) SELECT id,'09:00'::time FROM medication_plans");
    const before=(await pool.query('SELECT row_to_json(m) AS row FROM medicines m ORDER BY id')).rows;
    const beforeMembers=(await pool.query('SELECT row_to_json(m) AS row FROM family_members m ORDER BY id')).rows;
    const readSnapshot=async()=>{
      const tables={families:'families',members:'family_members',medicines:'medicines',batches:'medicine_batches',photos:'medicine_leaflet_photos',careProfiles:'care_profiles',plans:'medication_plans',planSlots:'plan_time_slots',doseOccurrences:'dose_occurrences',careGrants:'care_grants',doseReminders:'dose_reminder_deliveries',reminders:'reminder_deliveries'};
      const snapshot={drafts:f.map((family,i)=>({id:`draft-${i}`,family_id:family.id,user_id:u[i].id,fields:{name:`Pending input ${i}`},requestKey:`original-${i}`}))};
      for(const [key,table] of Object.entries(tables)) snapshot[key]=(await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
      return snapshot;
    };
    const originalSnapshot=await readSnapshot();
    await applyMigrations(pool);
    assert.deepEqual(await applyMigrations(pool),[]);
    const upgradedSnapshot=await readSnapshot();
    assert.deepEqual(upgradedSnapshot,originalSnapshot);
    // Artifacts are emitted from real SQL results plus scoped synthetic client input.
    const artifactDir=resolve('../../var/family-pilot-upgrade',candidateAt('../../').sha);
    await mkdir(artifactDir,{recursive:true});
    try {
      const put=async(name,bytes)=>{await writeFile(join(artifactDir,name),bytes);return {path:name,sha256:hash(bytes)};};
      const sourcePhotos=[];
      for(const photo of originalSnapshot.photos) sourcePhotos.push({id:photo.id,storageKey:photo.storage_key,...await put(`source-${photo.id}.png`,photoBytes)});
      const evidence={candidate:candidateAt('../../'),layer:'SYNTHETIC',before:await put('before.json',JSON.stringify(originalSnapshot)),after:await put('after.json',JSON.stringify(upgradedSnapshot)),photos:[],sourcePhotos};
      for(const photo of upgradedSnapshot.photos) evidence.photos.push({id:photo.id,storageKey:photo.storage_key,...await put(`after-${photo.id}.png`,photoBytes)});
      const evidenceFile=join(artifactDir,'evidence.json');await writeFile(evidenceFile,JSON.stringify(evidence));
      verifyEvidence(evidenceFile,{root:'../../'});
      for(const helper of ['upgrade-persistence-matrix.mjs','release-candidate-hardening.mjs']) execFileSync(process.execPath,[resolve('../../scripts',helper),'--evidence',evidenceFile],{cwd:resolve('../..'),stdio:'pipe'});
    } finally { /* Retain synthetic artifact bytes for exact-SHA CI receipt. */ }
    assert.deepEqual((await pool.query('SELECT row_to_json(m) AS row FROM medicines m ORDER BY id')).rows,before);
    assert.deepEqual((await pool.query('SELECT row_to_json(m) AS row FROM family_members m ORDER BY id')).rows,beforeMembers);
    const gateway=createTestGateway({a:'synthetic-a',b:'synthetic-b'});
    app=await buildServer({database,wechatGateway:gateway,logger:false});
    const login=async code=>(await app.inject({method:'POST',url:'/api/v1/auth/wechat',payload:{code}})).json().token;
    const tokenA=await login('a'), deviceA2=await login('a'), tokenB=await login('b');
    const req=(token,method,path,payload,scope)=>app.inject({method,url:'/api/v1'+path,headers:{authorization:`Bearer ${token}`,...(scope?{'x-family-id':scope}:{})},payload});
    const expect=(res,code)=>{assert.equal(res.statusCode,code,res.body);return code===204?null:res.json();};
    const code=expect(await req(tokenB,'POST','/families/invitations'),201).invitationCode;
    assert.equal(expect(await req(tokenA,'POST','/families/invitations/preview',{invitationCode:code}),200).family.id,f[1].id);
    const accepted=await Promise.all([req(tokenA,'POST','/families/invitations/accept',{code}),req(tokenA,'POST','/families/invitations/accept',{code})]);
    for(const res of accepted) assert.equal(expect(res,200).family.id,f[1].id);
    assert.equal((await pool.query('SELECT * FROM family_members WHERE user_id=$1',[u[0].id])).rowCount,2);
    assert.equal(expect(await req(tokenA,'GET','/auth/me'),200).family.id,f[1].id);
    assert.equal(expect(await req(deviceA2,'GET','/auth/me'),200).family.id,f[0].id);
    assert.equal(expect(await req(tokenA,'GET','/families/current'),200).family.id,f[1].id);
    assert.equal(expect(await req(tokenA,'GET','/medicines'),200).medicines[0].name,'Preserved content 1');
    assert.equal(expect(await req(tokenA,'GET','/medicines',undefined,f[0].id),200).medicines[0].name,'Preserved content 0');
    expect(await req(tokenA,'POST','/families/not-a-uuid/switch'),400);
    expect(await req(tokenB,'POST',`/families/${f[0].id}/switch`),404);
    const secondCode=expect(await req(tokenB,'POST','/families/invitations'),201).invitationCode;
    expect(await req(tokenA,'POST','/families/invitations/accept',{code:secondCode}),200);
    assert.equal((await pool.query('SELECT used_at FROM family_invites WHERE token_hash=encode(sha256($1::bytea),\'hex\')',[Buffer.from(secondCode)])).rows[0].used_at,null);
    expect(await req(tokenA,'POST','/families/leave'),204);
    assert.equal(expect(await req(deviceA2,'GET','/families/current'),200).family.role,'owner');
    expect(await req(tokenA,'GET','/medicines',undefined,f[1].id),404);
    expect(await req(deviceA2,'POST','/families/leave'),409);
    assert.deepEqual((await pool.query('SELECT row_to_json(m) AS row FROM medicines m ORDER BY id')).rows,before);
    // The old synthetic household fixtures remain unchanged throughout join/switch/leave.
    if(process.env.MEDBOX_PILOT_EVIDENCE_DIR) await writeFile(join(process.env.MEDBOX_PILOT_EVIDENCE_DIR,'two-family-upgrade.json'),JSON.stringify({before,after:(await pool.query('SELECT row_to_json(m) AS row FROM medicines m ORDER BY id')).rows}));
  } finally {if(app)await app.close();await fixture.close();await rm(oldDir,{recursive:true});}
});

test('real PG: partially upgraded legacy user keeps two household roles, IDs and complete medicine content', {skip:!url && process.env.REQUIRE_POSTGRES_TESTS!=='1'}, async()=>{
  assert(url,'strict PG resource required');
  const fixture=await isolatedPostgres(url);
  const oldDir=await mkdtemp(join(tmpdir(),'medbox-partial-migrations-'));
  try {
    for(const name of await readdir('db/migrations')) if(Number(name.split('_')[0])<=31) await copyFile(join('db/migrations',name),join(oldDir,name));
    await applyMigrations(fixture.pool,oldDir);
    const users=(await fixture.pool.query("INSERT INTO users(openid) VALUES('synthetic-existing-owner'),('synthetic-other-owner') RETURNING id")).rows;
    const families=(await fixture.pool.query("INSERT INTO families(name,created_by) VALUES('Existing A',$1),('Existing B',$2) RETURNING id",users.map(u=>u.id))).rows;
    // Model an earlier installation that removed the single-user constraint but
    // stopped before 033/034. Repair must not delete the second membership.
    await fixture.pool.query('ALTER TABLE family_members DROP CONSTRAINT family_members_user_id_key');
    await fixture.pool.query("INSERT INTO family_members(family_id,user_id,role) VALUES($1,$3,'owner'),($2,$4,'owner'),($2,$3,'member')",[families[0].id,families[1].id,users[0].id,users[1].id]);
    for(const [i,family] of families.entries()) await fixture.pool.query('INSERT INTO medicines(family_id,name,created_by,updated_by) VALUES($1,$2,$3,$3)',[family.id,`Original full content ${i}`,users[i].id]);
    const snapshot=async()=>({members:(await fixture.pool.query('SELECT * FROM family_members ORDER BY id')).rows,medicines:(await fixture.pool.query('SELECT * FROM medicines ORDER BY id')).rows,families:(await fixture.pool.query('SELECT * FROM families ORDER BY id')).rows});
    const before=await snapshot();await applyMigrations(fixture.pool);assert.deepEqual(await snapshot(),before);
    assert.deepEqual(await applyMigrations(fixture.pool),[]);assert.deepEqual(await snapshot(),before);
    assert.deepEqual((await fixture.pool.query('SELECT role FROM family_members WHERE user_id=$1 ORDER BY role',[users[0].id])).rows.map(r=>r.role),['member','owner']);
  } finally {await fixture.close();await rm(oldDir,{recursive:true});}
});
