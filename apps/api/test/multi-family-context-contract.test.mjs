import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    for(let i=0;i<2;i++) {
      f.push((await pool.query('INSERT INTO families(name,created_by) VALUES($1,$2) RETURNING *',[`Household ${i}`,u[i].id])).rows[0]);
      await pool.query("INSERT INTO family_members(family_id,user_id,role) VALUES($1,$2,'owner')",[f[i].id,u[i].id]);
      await pool.query('INSERT INTO medicines(family_id,name,created_by,updated_by) VALUES($1,$2,$3,$3)',[f[i].id,`Preserved content ${i}`,u[i].id]);
    }
    const before=(await pool.query('SELECT row_to_json(m) AS row FROM medicines m ORDER BY id')).rows;
    const beforeMembers=(await pool.query('SELECT row_to_json(m) AS row FROM family_members m ORDER BY id')).rows;
    await applyMigrations(pool);
    assert.deepEqual(await applyMigrations(pool),[]);
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
