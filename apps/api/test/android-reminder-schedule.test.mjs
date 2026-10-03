import assert from "node:assert/strict";
import test from "node:test";
import { createApp, scriptMultiUserSessions, authHeader, TOKEN } from "./helpers/app.mjs";
import { createFakePool } from "./helpers/fake-pool.mjs";

const path = "/api/v1/medication-plans/reminder-schedule";
async function fixture(member = true) {
  const database = createFakePool();
  scriptMultiUserSessions(database, [{ token: TOKEN, userId: "user-1", openid: "synthetic", membership: member ? {id:"m",family_id:"family-1",role:"member"} : null }]);
  return { database, app: await createApp(database) };
}

test("Android reminder projection requires a current authenticated family", async () => {
  const {app,database} = await fixture(false);
  try {
    assert.equal((await app.inject({url:path})).statusCode,401);
    assert.equal((await app.inject({url:path,...authHeader()})).statusCode,404);
    assert.equal(database.callsMatching(/INSERT INTO dose_occurrences/).length,0);
  } finally { await app.close(); }
});

test("Android reminder projection has server-owned seven-day range and exact generic keys", async () => {
  const {app,database} = await fixture();
  const date = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  database.always(/SELECT o.id, o.dose_date::text AS dose_date/, [{id:"opaque",dose_date:date,time_of_day:"23:59:00",medicine_name:"must never leak",dosage_text:"must never leak",care_profile_id:"must never leak"}]);
  try {
    const response=await app.inject({url:path,...authHeader()});
    assert.equal(response.statusCode,200,response.body);
    const result=response.json();
    assert.deepEqual(Object.keys(result).sort(),["endDate","entries","startDate","timezone"]);
    assert.equal(result.startDate,date);
    assert.equal(Date.parse(result.endDate)-Date.parse(result.startDate),6*86400000);
    assert.equal(result.timezone,"Asia/Shanghai");
    assert.deepEqual(result.entries,[{occurrenceId:"opaque",date,time:"23:59",label:"有一项用药安排待确认"}]);
    const inserts=database.callsMatching(/INSERT INTO dose_occurrences/);
    assert.equal(inserts.length,7);
    for(const call of inserts) {
      assert.ok(call.params.includes("family-1"));
      assert.ok(call.params.includes("user-1"));
      assert.match(call.sql,/family_members/);
      assert.match(call.sql,/receive_dose_reminders/);
      assert.match(call.sql,/notification_preferences/);
      assert.match(call.sql,/'android'/);
      assert.doesNotMatch(call.sql,/can_view|can_manage/);
    }
    const selection=database.callsMatching(/SELECT o.id, o.dose_date::text AS dose_date/)[0];
    assert.match(selection.sql,/family_members/);
    assert.match(selection.sql,/receive_dose_reminders/);
    assert.match(selection.sql,/o.status = 'pending'/);
    assert.match(selection.sql,/o.superseded_at IS NULL/);
    assert.match(selection.sql,/s.archived_at IS NULL/);
    assert.match(selection.sql,/c.archived_at IS NULL/);
  } finally { await app.close(); }
});

test("Android reminder range cannot request arbitrary historical dates or expanded windows", async () => {
  const {app,database}=await fixture();
  try {
    for(const query of ["date=2000-01-01","days=999","startDate=2000-01-01","familyId=other"]) {
      const response=await app.inject({url:`${path}?${query}`,...authHeader()});
      assert.equal(response.statusCode,400,response.body);
    }
    assert.equal(database.callsMatching(/INSERT INTO dose_occurrences/).length,0);
  } finally { await app.close(); }
});
