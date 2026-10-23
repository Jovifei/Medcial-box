import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {applyMigrations} from '../dist/db/migrations.js';
import {isolatedPostgres} from './helpers/isolated-pg.mjs';
import {buildServer} from '../dist/app.js';
import {createTestGateway} from './helpers/fake-wechat.mjs';

const url=process.env.TEST_DATABASE_URL;
for(const retained of [false,true]) test(`C2C-05 real PG: parallel leave retains ${retained?'a third household':'no dangling selected household'}`,{
  skip:!url && process.env.REQUIRE_POSTGRES_TESTS!=='1',
},async()=>{
  assert.ok(url,'strict PostgreSQL resource required');
  const fixture=await isolatedPostgres(url),{pool,database}=fixture;
  let app,blocker;const requests=[];const blockedPids=new Set();
  try {
    await applyMigrations(pool);
    const member=(await pool.query("INSERT INTO users(openid) VALUES('synthetic-leaver') RETURNING id")).rows[0];
    const owner=(await pool.query("INSERT INTO users(openid) VALUES('synthetic-owner') RETURNING id")).rows[0];
    const families=[];
    for(let i=0;i<(retained?3:2);i++) {
      const family=(await pool.query('INSERT INTO families(name,created_by) VALUES($1,$2) RETURNING id',[`Synthetic household ${i}`,owner.id])).rows[0];
      families.push(family.id);
      await pool.query("INSERT INTO family_members(family_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[family.id,owner.id,member.id]);
      await pool.query('INSERT INTO medicines(family_id,name,created_by,updated_by) VALUES($1,$2,$3,$3)',[family.id,`Untouched stock ${i}`,owner.id]);
    }
    const inventory=(await pool.query('SELECT * FROM medicines ORDER BY id')).rows;
    app=await buildServer({database,wechatGateway:createTestGateway({member:'synthetic-leaver',owner:'synthetic-owner'}),logger:false});
    const login=async code=>{
      const r=await app.inject({method:'POST',url:'/api/v1/auth/wechat',payload:{code}});
      assert.equal(r.statusCode,200,r.body);return r.json().token;
    };
    const tokens=[await login('member'),await login('member')];
    if(retained)tokens.push(await login('member'));
    await login('owner');
    for(let i=0;i<tokens.length;i++)await pool.query('UPDATE sessions SET active_family_id=$2 WHERE token_hash=$1',[createHash('sha256').update(tokens[i]).digest('hex'),families[i]]);
    const otherSessions=(await pool.query('SELECT id,active_family_id FROM sessions WHERE user_id=$1 ORDER BY id',[owner.id])).rows;
    // Hold the shared resource *outside* both requests. On the old implementation
    // each request selects its fallback before waiting on UPDATE. The fix must
    // wait on all user sessions BEFORE reading a fresh fallback snapshot.
    blocker=await pool.connect();await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM sessions WHERE user_id=$1 ORDER BY id FOR UPDATE',[member.id]);
    fixture.observe=({sql,params,pid,run})=>{
      if(params?.[0]===member.id && (/SELECT id FROM sessions WHERE user_id/i.test(sql)||/UPDATE sessions SET active_family_id = \$3 WHERE user_id/i.test(sql))) blockedPids.add(pid);
      return run();
    };
    for(let i=0;i<2;i++) {
      const pending=app.inject({method:'POST',url:'/api/v1/families/leave',headers:{authorization:`Bearer ${tokens[i]}`,'x-family-id':families[i]}});
      const request=Promise.resolve(pending);request.catch(()=>{});requests.push(request);
    }
    {
      const deadline=Date.now()+8000;
      while(true) {
        assert.ok(Date.now()<deadline,'both real PostgreSQL requests must reach the session contention barrier');
        if(blockedPids.size===2) {
          const result=await pool.query('SELECT pid,cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity WHERE pid=ANY($1::int[])',[[...blockedPids]]);
          if(result.rows.length===2 && result.rows.every(row=>row.blockers>0))break;
        }
        await setImmediate();
      }
    }
    await blocker.query('COMMIT');blocker.release();blocker=null;
    for(const result of await Promise.all(requests))assert.equal(result.statusCode,204,result.body);
    const invalid=(await pool.query(`SELECT s.id,s.active_family_id FROM sessions s
      WHERE s.user_id=$1 AND s.active_family_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM family_members m WHERE m.user_id=s.user_id AND m.family_id=s.active_family_id)`,[member.id])).rows;
    assert.deepEqual(invalid,[],'no successful parallel leave may point any session at an exited household');
    const remaining=(await pool.query('SELECT family_id FROM family_members WHERE user_id=$1',[member.id])).rows;
    assert.deepEqual(remaining.map(row=>row.family_id),retained?[families[2]]:[]);
    const selections=(await pool.query('SELECT active_family_id FROM sessions WHERE user_id=$1',[member.id])).rows;
    assert.ok(selections.every(row=>row.active_family_id===(retained?families[2]:null)));
    assert.deepEqual((await pool.query('SELECT id,active_family_id FROM sessions WHERE user_id=$1 ORDER BY id',[owner.id])).rows,otherSessions,'another account must remain untouched');
    assert.equal((await pool.query("SELECT id FROM family_members WHERE user_id=$1 AND role='owner'",[owner.id])).rowCount,families.length);
    assert.deepEqual((await pool.query('SELECT * FROM medicines ORDER BY id')).rows,inventory,'no inventory mutation is part of a leave');
  } finally {
    if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}
    await Promise.allSettled(requests);fixture.observe=null;
    if(app)await app.close();await fixture.close();
  }
});
