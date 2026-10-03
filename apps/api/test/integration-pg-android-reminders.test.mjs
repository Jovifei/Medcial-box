import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { issueSessionToken } from "../dist/auth/session.js";
import { isolatedPostgres } from "./helpers/isolated-pg.mjs";

const url=process.env.TEST_DATABASE_URL?.trim()??"";
const required=process.env.REQUIRE_POSTGRES_TESTS==="1";
const path="/medication-plans/reminder-schedule";
const date=(offset=0)=>new Date(Date.now()+8*3600000+offset*86400000).toISOString().slice(0,10);
const status=(r,code=200)=>{assert.equal(r.statusCode,code,r.body);return code===204?null:r.json();};

test("real PostgreSQL: receive-only Android projection preserves all private boundaries",{skip:!url&&!required?"TEST_DATABASE_URL absent: optional local PostgreSQL suite":false},async(t)=>{
  assert.ok(url,"REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL");
  const fixture=await isolatedPostgres(url);const{pool,database}=fixture;let app;
  try{
    await applyMigrations(pool);
    let beforeProjection;
    app=await buildServer({database:{
      ...database,
      async query(sql,params){
        if(beforeProjection && /SELECT o.id, o.dose_date::text AS dose_date/.test(sql)){
          const change=beforeProjection;beforeProjection=null;await change();
        }
        return database.query(sql,params);
      },
    },logger:false});
    const request=(user,method,p,payload)=>app.inject({method,url:`/api/v1${p}`,headers:{authorization:`Bearer ${user.token}`},...(payload===undefined?{}:{payload})});
    async function user(){const id=randomUUID();await pool.query("INSERT INTO users(id,openid) VALUES($1,$2)",[id,`synthetic-${id}`]);return{id,...await issueSessionToken(database,id)};}
    const owner=await user(),receiver=await user(),viewer=await user(),manager=await user(),stranger=await user();
    const group=status(await request(owner,"POST","/families",{name:"Synthetic reminder family"}),201);
    for(const member of [receiver,viewer,manager])await pool.query("INSERT INTO family_members(family_id,user_id,role) VALUES($1,$2,'member')",[group.family.id,member.id]);
    status(await request(stranger,"POST","/families",{name:"Other synthetic family"}),201);
    async function preferences(who,channels=["android"]){status(await request(who,"PUT","/notification-preferences",{stockReminderTime:"09:00",channels}));}
    for(const member of [owner,receiver,viewer,manager,stranger])await preferences(member);
    async function profile(name="Private patient",linked=false){return status(await request(owner,"POST",linked?"/care-profiles/self":"/care-profiles",{displayName:name}),201);}
    async function plan(p,extra={}){return status(await request(owner,"POST","/medication-plans",{careProfileId:p.id,medicineName:"Private medicine",dosageText:"Private dosage",timeSlots:["23:59"],startDate:date(1),...extra}),201);}
    async function grant(p,who,flags){status(await request(owner,"POST",`/care-profiles/${p.id}/grants`,{memberUserId:who.id,canView:false,canManage:false,receiveDoseReminders:false,...flags}));}
    const patient=await profile();const active=await plan(patient);
    await grant(patient,receiver,{receiveDoseReminders:true});
    await grant(patient,viewer,{canView:true});
    await grant(patient,manager,{canManage:true});
    function entries(result){assert.deepEqual(Object.keys(result).sort(),["endDate","entries","startDate","timezone"]);assert.equal(result.timezone,"Asia/Shanghai");for(const item of result.entries){assert.deepEqual(Object.keys(item).sort(),["date","label","occurrenceId","time"]);assert.equal(item.label,"有一项用药安排待确认");assert.match(item.occurrenceId,/^[0-9a-f-]{36}$/);assert.ok(item.date>=date()&&item.date<=date(6));}return result.entries;}
    await t.test("receiver-only gets generic authoritative instances but no detail/history/confirmation permission",async()=>{
      const projected=entries(status(await request(receiver,"GET",path)));assert.equal(projected.length,6);
      const full=status(await request(owner,"GET",`/medication-plans/schedule?date=${date(1)}`));
      assert.equal(projected[0].occurrenceId,full.entries[0].occurrenceId);
      assert.deepEqual(status(await request(receiver,"GET",`/medication-plans/schedule?date=${date(1)}`)).entries,[]);
      status(await request(receiver,"GET",`/medication-plans/${active.planId}`),403);
      status(await request(receiver,"GET",`/medication-plans/${active.planId}/history`),403);
      status(await request(receiver,"POST",`/dose-occurrences/${projected[0].occurrenceId}/confirm`,{action:"taken",idempotencyKey:randomUUID()}),403);
      assert.deepEqual(entries(status(await request(viewer,"GET",path))),[]);
      assert.deepEqual(entries(status(await request(manager,"GET",path))),[]);
      assert.equal(entries(status(await request(owner,"GET",path))).length,6);
      await grant(patient,manager,{canManage:true,receiveDoseReminders:true});
      assert.equal(entries(status(await request(manager,"GET",path))).length,6);
      await grant(patient,manager,{canManage:true});
      assert.equal((await pool.query("SELECT can_view,can_manage FROM care_grants WHERE care_profile_id=$1 AND member_user_id=$2",[patient.id,receiver.id])).rows[0].can_view,false);
    });
    await t.test("private self profiles ignore other-member grants and family administrators gain no access",async()=>{
      const mine=await profile("Private self",true);await plan(mine);
      // Malformed historical grants must not defeat linked-account privacy.
      await pool.query("INSERT INTO care_grants(care_profile_id,member_user_id,can_view,can_manage,receive_dose_reminders,created_by,family_id) VALUES($1,$2,true,true,true,$3,$4)",[mine.id,receiver.id,owner.id,group.family.id]);
      assert.equal(entries(status(await request(receiver,"GET",path))).length,6);
      assert.equal(entries(status(await request(owner,"GET",path))).length,12);
      const otherSelf=status(await request(receiver,"POST","/care-profiles/self",{displayName:"Receiver private"}),201);
      status(await request(receiver,"POST","/medication-plans",{careProfileId:otherSelf.id,medicineName:"Hidden from owner",dosageText:"Hidden",timeSlots:["23:59"],startDate:date(1)}),201);
      assert.equal(entries(status(await request(owner,"GET",path))).length,12);
      status(await request(receiver,"POST",`/care-profiles/${otherSelf.id}/archive`));
    });
    await t.test("other family and no Android opt-in yield no projection or cross-family materialization",async()=>{
      assert.deepEqual(entries(status(await request(stranger,"GET",path))),[]);
      const unseen=await profile();await plan(unseen);
      const before=(await pool.query("SELECT count(*)::int n FROM dose_occurrences WHERE care_profile_id=$1",[unseen.id])).rows[0].n;
      assert.equal(before,0);
      await request(receiver,"GET",path);
      assert.equal((await pool.query("SELECT count(*)::int n FROM dose_occurrences WHERE care_profile_id=$1",[unseen.id])).rows[0].n,0);
      for(const channels of [[],["wechat"]]){await preferences(receiver,channels);assert.deepEqual(entries(status(await request(receiver,"GET",path))),[]);}
      await preferences(receiver);
    });
    await t.test("authoritative status, slot, date, weekday and supersession rules filter pending future instances",async()=>{
      const before=entries(status(await request(receiver,"GET",path)));const old=before[0].occurrenceId;
      status(await request(owner,"POST",`/dose-occurrences/${old}/confirm`,{action:"taken",idempotencyKey:randomUUID()}));
      assert.equal(entries(status(await request(receiver,"GET",path))).length,5);
      const skipped=before[1].occurrenceId;
      status(await request(owner,"POST",`/dose-occurrences/${skipped}/confirm`,{action:"skipped",idempotencyKey:randomUUID()}));
      assert.equal(entries(status(await request(receiver,"GET",path))).length,4);
      const pending=before[2].occurrenceId;
      status(await request(owner,"PUT",`/medication-plans/${active.planId}`,{version:1,dosageText:"Changed private dosage"}));
      const changed=entries(status(await request(receiver,"GET",path)));
      assert.equal(changed.length,4);assert.ok(!changed.some(e=>e.occurrenceId===pending));
      assert.ok((await pool.query("SELECT superseded_at FROM dose_occurrences WHERE id=$1",[pending])).rows[0].superseded_at);
      const weekday=["sun","mon","tue","wed","thu","fri","sat"][new Date(`${date(3)}T12:00:00Z`).getUTCDay()];
      const restricted=await plan(patient,{startDate:date(2),endDate:date(4),weekdays:[weekday],timeSlots:["12:34"]});
      const matching=entries(status(await request(receiver,"GET",path))).filter(e=>e.time==="12:34");assert.equal(matching.length,1);assert.equal(matching[0].date,date(3));
      await pool.query("UPDATE plan_time_slots SET archived_at=now() WHERE plan_id=$1",[restricted.planId]);
      assert.equal(entries(status(await request(receiver,"GET",path))).filter(e=>e.time==="12:34").length,0);
      status(await request(owner,"POST",`/medication-plans/${active.planId}/pause`,{version:2}));assert.deepEqual(entries(status(await request(receiver,"GET",path))),[]);
      status(await request(owner,"POST",`/medication-plans/${active.planId}/end`,{version:3}));assert.deepEqual(entries(status(await request(receiver,"GET",path))),[]);
      const p2=await profile();await plan(p2);await grant(p2,receiver,{receiveDoseReminders:true});assert.equal(entries(status(await request(receiver,"GET",path))).length,6);
      status(await request(owner,"POST",`/care-profiles/${p2.id}/archive`));assert.deepEqual(entries(status(await request(receiver,"GET",path))),[]);
    });
    await t.test("final SELECT rechecks revocation, channel withdrawal and removal after preHandler and materialization",async()=>{
      const p=await profile();await plan(p);await grant(p,receiver,{receiveDoseReminders:true});
      assert.equal(entries(status(await request(receiver,"GET",path))).length,6);
      beforeProjection=()=>pool.query("DELETE FROM care_grants WHERE care_profile_id=$1 AND member_user_id=$2",[p.id,receiver.id]);
      assert.deepEqual(entries(status(await request(receiver,"GET",path))),[]);
      await grant(p,receiver,{receiveDoseReminders:true});
      beforeProjection=()=>pool.query("UPDATE notification_preferences SET channels='{}' WHERE user_id=$1",[receiver.id]);
      assert.deepEqual(entries(status(await request(receiver,"GET",path))),[]);
      await preferences(receiver);
      beforeProjection=()=>pool.query("DELETE FROM family_members WHERE user_id=$1",[receiver.id]);
      assert.deepEqual(entries(status(await request(receiver,"GET",path))),[]);
      await pool.query("INSERT INTO family_members(family_id,user_id,role) VALUES($1,$2,'member')",[group.family.id,receiver.id]);
      status(await request(owner,"POST",`/care-profiles/${p.id}/archive`));
    });
    await t.test("grant revocation, channel withdrawal and membership removal take effect on the next read",async()=>{
      const p=await profile();await plan(p);await grant(p,receiver,{receiveDoseReminders:true});
      assert.equal(entries(status(await request(receiver,"GET",path))).length,6);
      status(await request(owner,"DELETE",`/care-profiles/${p.id}/grants/${receiver.id}`));assert.deepEqual(entries(status(await request(receiver,"GET",path))),[]);
      await grant(p,receiver,{receiveDoseReminders:true});await preferences(receiver,[]);assert.deepEqual(entries(status(await request(receiver,"GET",path))),[]);await preferences(receiver);
      await pool.query("DELETE FROM family_members WHERE user_id=$1",[receiver.id]);status(await request(receiver,"GET",path),404);
    });
  }finally{if(app)await app.close();await fixture.close();}
});
