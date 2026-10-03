import type { Database } from "../types.js";
import { daysUntilExpiry } from "../domain/expiry.js";
import { buildFamilyMedicineSummaries } from "../routes/medicines.js";
import { listMedicines } from "../repositories/medicines.js";
import { toBatchSummary, type MedicineBatchRow } from "../repositories/batches.js";
import type { ReminderTemplateConfig, SubscribeMessageSender } from "../services/subscribe-messages.js";

const MILESTONES = [30, 7, 1, 0] as const;
const CLAIM_BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;

export function isWithinReminderWindow(now: Date): boolean {
  if (!Number.isFinite(now.getTime())) return false;
  const hourText = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).find((part) => part.type === "hour")?.value;
  return hourText !== undefined && Number(hourText) >= 9;
}

export function reminderMilestones(deadlineDate: string, now: Date): number[] {
  const days = daysUntilExpiry({ value: deadlineDate, precision: "day" }, now);
  if (days === null) return [];
  return MILESTONES.filter((milestone) => milestone === days);
}

function labelForMilestone(daysBefore: number): string {
  if (daysBefore === 0) return "今天到期";
  if (daysBefore === 1) return "明天到期";
  return `${daysBefore} 天后到期`;
}

async function queueOneDelivery(
  database: Database,
  familyId: string,
  userId: string,
  medicineId: string,
  batchId: string,
  deadlineDate: string,
  daysBefore: number,
  templateId: string,
): Promise<boolean> {
  return database.withTransaction(async (tx) => {
    const grant = await tx.query<{ id: string }>(
      `SELECT id FROM wechat_subscription_grants
       WHERE family_id = $1 AND user_id = $2 AND template_id = $3 AND consumed_at IS NULL
       ORDER BY accepted_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
      [familyId, userId, templateId],
    );
    const grantId = grant.rows[0]?.id;
    if (grantId === undefined) return false;
    const delivery = await tx.query<{ id: string }>(
      `INSERT INTO reminder_deliveries
       (family_id, user_id, medicine_id, batch_id, deadline_date, days_before, template_id, subscription_grant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, batch_id, deadline_date, days_before) DO NOTHING
       RETURNING id`,
      [familyId, userId, medicineId, batchId, deadlineDate, daysBefore, templateId, grantId],
    );
    if (delivery.rowCount === 0) return false;
    await tx.query(
      "UPDATE wechat_subscription_grants SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL",
      [grantId],
    );
    return true;
  });
}

interface ClaimedDelivery {
  id: string;
  user_id: string;
  openid: string;
  medicine_id: string;
  medicine_name: string;
  batch_id: string;
  deadline_date: string;
  days_before: number;
  attempts: number;
  is_archived: boolean;
  medicine_deleted_at: Date | string | null;
  batch_deleted_at: Date | string | null;
  disposition_status: string;
  /** 领取时复核的成员关系；移除成员后必须为真拦下，绝不调用发送器。 */
  is_member: boolean;
}

/**
 * 作废孤儿任务：收件人已不属于该家庭（被移除或已退出）时，
 * 未发送的提醒必须停止；已越过发送边界的任务仅请求取消，授权不再复用。
 * 这同时覆盖成员移除流程之外的历史数据。
 */
export async function blockDeliveriesForDepartedMembers(database: Database): Promise<number> {
  const blocked = await database.query<{ id: string }>(
    `UPDATE reminder_deliveries d
     SET status = CASE WHEN d.send_started_at IS NULL THEN 'blocked' ELSE d.status END,
         cancel_requested = true, last_error_code = 'NOT_A_MEMBER', next_attempt_at = now()
     WHERE d.status IN ('queued', 'failed', 'sending') AND NOT d.cancel_requested
       AND NOT EXISTS (
         SELECT 1 FROM family_members fm
         WHERE fm.family_id = d.family_id AND fm.user_id = d.user_id
       )
     RETURNING d.id`,
  );
  if (blocked.rowCount === 0) return 0;
  await database.query(
    `UPDATE wechat_subscription_grants g
     SET consumed_at = COALESCE(g.consumed_at, now())
     WHERE g.consumed_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM family_members fm
         WHERE fm.family_id = g.family_id AND fm.user_id = g.user_id
       )`,
  );
  return blocked.rowCount ?? 0;
}

/**
 * 成员被移除或主动退出时立即取消其排队任务与未使用的订阅授权，
 * 让"不再属于这个家庭"在同一事务内生效，而不是等到下一轮调度。
 */
export async function cancelDeliveriesForMember(
  database: { query: Database["query"] },
  familyId: string,
  userId: string,
): Promise<void> {
  await database.query(
    `UPDATE reminder_deliveries
     SET status = CASE WHEN send_started_at IS NULL THEN 'blocked' ELSE status END,
         cancel_requested = true, last_error_code = 'NOT_A_MEMBER', next_attempt_at = now()
     WHERE family_id = $1 AND user_id = $2 AND status IN ('queued', 'failed', 'sending') AND NOT cancel_requested`,
    [familyId, userId],
  );
  await database.query(
    `UPDATE wechat_subscription_grants
     SET consumed_at = COALESCE(consumed_at, now())
     WHERE family_id = $1 AND user_id = $2 AND consumed_at IS NULL`,
    [familyId, userId],
  );
}

async function claimDeliveries(database: Database, now: Date): Promise<ClaimedDelivery[]> {
  return database.withTransaction(async (tx) => {
    const claimed = await tx.query<{ id: string }>(
      `WITH candidates AS (
         SELECT id FROM reminder_deliveries
         WHERE status IN ('queued', 'failed', 'sending') AND next_attempt_at <= $1
           AND send_started_at IS NULL AND NOT cancel_requested
         ORDER BY next_attempt_at, id
         FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE reminder_deliveries d
       SET status = 'sending', attempts = attempts + 1, next_attempt_at = $1 + interval '5 minutes'
       FROM candidates c WHERE d.id = c.id RETURNING d.id`,
      [now, CLAIM_BATCH_SIZE],
    );
    const ids = claimed.rows.map((row) => row.id);
    if (ids.length === 0) return [];
    const rows = await tx.query<ClaimedDelivery>(
      `SELECT d.id, d.user_id, u.openid, d.medicine_id, m.name AS medicine_name,
              d.batch_id, d.deadline_date::text, d.days_before, d.attempts,
              m.is_archived, m.deleted_at AS medicine_deleted_at,
              b.deleted_at AS batch_deleted_at, b.disposition_status,
              EXISTS (
                SELECT 1 FROM family_members fm
                WHERE fm.family_id = d.family_id AND fm.user_id = d.user_id
              ) AS is_member
       FROM reminder_deliveries d
       JOIN users u ON u.id = d.user_id
       JOIN medicines m ON m.id = d.medicine_id AND m.family_id = d.family_id
       JOIN medicine_batches b ON b.id = d.batch_id AND b.family_id = d.family_id
       WHERE d.id = ANY($1::uuid[])`,
      [ids],
    );
    return rows.rows;
  });
}

async function blockClaimedDelivery(database: Pick<Database, "query">, delivery: ClaimedDelivery, code: string): Promise<void> {
  await database.query(
    `UPDATE reminder_deliveries SET status = 'blocked', last_error_code = $3
     WHERE id = $1 AND attempts = $2 AND status = 'sending' AND send_started_at IS NULL`,
    [delivery.id, delivery.attempts, code],
  );
}

export async function dispatchDueReminderMessages(
  database: Database,
  sender: SubscribeMessageSender,
  config: ReminderTemplateConfig,
  now: Date = new Date(),
): Promise<{ queued: number; sent: number; failed: number }> {
  if (!config.available) return { queued: 0, sent: 0, failed: 0 };

  let queued = 0;
  const families = await database.query<{ family_id: string }>(
    "SELECT DISTINCT family_id FROM family_members ORDER BY family_id",
  );
  for (const { family_id: familyId } of families.rows) {
    const rows = await listMedicines(database, familyId, false);
    const medicines = await buildFamilyMedicineSummaries(database, familyId, rows, now);
    const members = await database.query<{ user_id: string }>(
      `SELECT fm.user_id FROM family_members fm LEFT JOIN notification_preferences np ON np.user_id=fm.user_id
       WHERE fm.family_id = $1 AND $2::time >= COALESCE(np.stock_reminder_time, '09:00'::time)
         AND ('wechat'=ANY(np.channels) OR np.user_id IS NULL) ORDER BY fm.user_id`,
      [familyId, new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 19)],
    );
    for (const medicine of medicines) {
      for (const batch of medicine.batches) {
        if (batch.dispositionStatus === "handled") continue;
        const deadlineDate = batch.managementExpiryDate;
        if (deadlineDate === null || deadlineDate === undefined) continue;
        for (const daysBefore of reminderMilestones(deadlineDate, now)) {
          for (const member of members.rows) {
            if (await queueOneDelivery(database, familyId, member.user_id, medicine.id, batch.id, deadlineDate, daysBefore, config.templateId)) {
              queued += 1;
            }
          }
        }
      }
    }
  }

  // 先作废已经不属于任何家庭的任务，再领取，避免旧任务消耗新授权。
  await blockDeliveriesForDepartedMembers(database);
  const claimed = await claimDeliveries(database, now);
  let sent = 0;
  let failed = 0;
  for (const delivery of claimed) {
    const preference = (await database.query<{ stock_reminder_time: string; channels: string[] }>("SELECT stock_reminder_time::text, channels FROM notification_preferences WHERE user_id=$1", [delivery.user_id])).rows[0];
    const localTime = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 19);
    if (preference !== undefined && (!preference.channels.includes("wechat") || localTime < preference.stock_reminder_time)) {
      await blockClaimedDelivery(database, delivery, "PREFERENCE_CHANGED");
      continue;
    }

    // This is the claim snapshot. Current membership is checked again in the
    // atomic send boundary below, together with lease ownership and opt-out.
    if (!delivery.is_member) {
      await blockClaimedDelivery(database, delivery, "NOT_A_MEMBER");
      continue;
    }
    // 里程碑复核：重试时当前剩余天数必须仍等于原事件天数（A08）。
    // 例如"30 天后到期"的任务不能在只剩 28 天时补发——过时事件取消，而不是消耗新的订阅机会。
    const daysLeft = daysUntilExpiry({ value: delivery.deadline_date, precision: "day" }, now);
    if (daysLeft === null || daysLeft !== delivery.days_before) {
      await blockClaimedDelivery(database, delivery, "STALE_MILESTONE");
      continue;
    }
    const obsolete = delivery.is_archived || delivery.medicine_deleted_at !== null || delivery.batch_deleted_at !== null ||
      delivery.disposition_status === "handled";
    if (obsolete) {
      await blockClaimedDelivery(database, delivery, "STALE_EVENT");
      continue;
    }
    if (delivery.attempts > MAX_ATTEMPTS) {
      await blockClaimedDelivery(database, delivery, "RETRY_EXHAUSTED");
      continue;
    }
    // The durable boundary is the last operation before the external send.
    // Only an eligible owner of this not-started lease may cross it. Once set,
    // a timeout, process crash or failed settlement must never trigger a resend.
    const started = await database.withTransaction(async (tx) => {
      // Re-read the actual batch, not the pre-claim inventory snapshot. Hold a
      // shared row lock until the marker commits so expiry/opening edits cannot
      // slip between validation and the send boundary. Unrelated changes (for
      // example quantity or storage location) do not invalidate this event.
      const current = await tx.query<MedicineBatchRow>(
        `SELECT b.* FROM medicine_batches b
         JOIN reminder_deliveries d ON d.batch_id = b.id AND d.family_id = b.family_id
         WHERE d.id = $1 FOR SHARE OF b`,
        [delivery.id],
      );
      const batch = current.rows[0];
      if (batch === undefined || batch.deleted_at !== null || batch.disposition_status === "handled" ||
          toBatchSummary(batch, now).managementExpiryDate !== delivery.deadline_date) {
        await blockClaimedDelivery(tx, delivery, "STALE_EVENT");
        return false;
      }
      const boundary = await tx.query<{ id: string }>(
        `UPDATE reminder_deliveries d
         SET send_started_at = now(), next_attempt_at = now() + interval '5 minutes'
         WHERE d.id = $1 AND d.attempts = $2 AND d.status = 'sending'
           AND d.send_started_at IS NULL AND NOT d.cancel_requested
           AND EXISTS (SELECT 1 FROM family_members fm WHERE fm.family_id = d.family_id AND fm.user_id = d.user_id)
           AND NOT EXISTS (SELECT 1 FROM notification_preferences np WHERE np.user_id = d.user_id
                           AND (NOT ('wechat' = ANY(np.channels)) OR np.stock_reminder_time > $3::time))
           AND EXISTS (SELECT 1 FROM medicines m JOIN medicine_batches b ON b.medicine_id = m.id
                       WHERE m.id = d.medicine_id AND m.family_id = d.family_id AND NOT m.is_archived AND m.deleted_at IS NULL
                         AND b.id = d.batch_id AND b.family_id = d.family_id AND b.deleted_at IS NULL AND b.disposition_status <> 'handled')
         RETURNING d.id`,
        [delivery.id, delivery.attempts, localTime],
      );
      if (boundary.rowCount === 0) await blockClaimedDelivery(tx, delivery, "ELIGIBILITY_CHANGED");
      return boundary.rowCount !== 0;
    });
    if (!started) continue;
    try {
      const result = await sender.send({
        openid: delivery.openid,
        page: "pages/pending/pending",
        medicineName: delivery.medicine_name,
        deadlineDate: delivery.deadline_date,
        eventLabel: labelForMilestone(delivery.days_before),
      });
      const settled = await database.query<{ id: string }>(
        `UPDATE reminder_deliveries SET status = 'sent', message_id = $2, sent_at = $3, last_error_code = NULL
         WHERE id = $1 AND attempts = $4 AND status = 'sending' AND send_started_at IS NOT NULL
         RETURNING id`,
        [delivery.id, result.messageId, now, delivery.attempts],
      );
      if (settled.rowCount !== 0) sent += 1;
    } catch {
      // The request may have arrived, or a successful response may have failed
      // to settle in the database. Retain the boundary and consumed grant for
      // reconciliation; failed is diagnostic, never a permission to resend.
      const uncertain = await database.query<{ id: string }>(
        `UPDATE reminder_deliveries SET status = 'failed', last_error_code = 'DELIVERY_UNCERTAIN'
         WHERE id = $1 AND attempts = $2 AND status = 'sending' AND send_started_at IS NOT NULL
         RETURNING id`,
        [delivery.id, delivery.attempts],
      );
      if (uncertain.rowCount !== 0) failed += 1;
    }
  }
  return { queued, sent, failed };
}

export function startReminderScheduler(
  database: Database,
  sender: SubscribeMessageSender,
  config: ReminderTemplateConfig,
  logger: { warn(message: string): void },
): () => void {
  if (process.env.WECHAT_REMINDER_SCHEDULER_ENABLED !== "true" || !config.available) return () => undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void dispatchDueReminderMessages(database, sender, config)
      .catch(() => logger.warn("reminder scheduler pass failed"))
      .finally(() => { running = false; });
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
