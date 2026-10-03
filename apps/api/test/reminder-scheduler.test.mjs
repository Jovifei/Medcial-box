import assert from "node:assert/strict";
import test from "node:test";

const scheduler = await import("../dist/jobs/reminder-scheduler.js").catch(() => null);

test("expiry reminder milestones are 30, 7, 1 and 0 days in Asia/Shanghai", () => {
  assert.ok(scheduler, "reminder scheduler has not been implemented");
  const now = new Date("2026-09-28T04:00:00Z"); // Shanghai 12:00 on Sep 28
  assert.deepEqual(scheduler.reminderMilestones("2026-10-28", now), [30]);
  assert.deepEqual(scheduler.reminderMilestones("2026-10-05", now), [7]);
  assert.deepEqual(scheduler.reminderMilestones("2026-09-29", now), [1]);
  assert.deepEqual(scheduler.reminderMilestones("2026-09-28", now), [0]);
  assert.deepEqual(scheduler.reminderMilestones("2026-09-27", now), []);
});

test("reminder delivery window starts at 09:00 Asia/Shanghai", () => {
  assert.ok(scheduler, "reminder scheduler has not been implemented");
  assert.equal(scheduler.isWithinReminderWindow(new Date("2026-09-28T00:59:00Z")), false);
  assert.equal(scheduler.isWithinReminderWindow(new Date("2026-09-28T01:00:00Z")), true);
  assert.equal(scheduler.isWithinReminderWindow(new Date("2026-09-28T15:00:00Z")), true);
});

test("scheduler does not query inventory or consume consent when template unavailable", async () => {
  assert.ok(scheduler, "reminder scheduler has not been implemented");
  let queried = false;
  const result = await scheduler.dispatchDueReminderMessages(
    { query: async () => { queried = true; return { rows: [], rowCount: 0 }; } },
    { send: async () => ({ messageId: "unexpected" }) },
    { available: false, templateId: "configured-template" },
    new Date("2026-09-28T00:59:00Z"),
  );
  assert.deepEqual(result, { queued: 0, sent: 0, failed: 0 });
  assert.equal(queried, false);
});
