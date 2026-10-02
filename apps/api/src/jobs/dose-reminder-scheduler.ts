/**
 * 服药提醒调度（R4）：与库存提醒分表分模板，互不挤占一次性订阅授权。
 *
 * 规则（与方案三.5 一致）：
 * - 用户必须先在小程序主动订阅；没有可用授权就不排队，也不假装已提醒；
 * - 排队时只排"到点且仍未确认"的实例，且只在时间点后 90 分钟内有效；
 * - 发送前复核：计划仍在进行、实例仍未确认、收件人仍有权限且仍是家庭成员；
 * - 超时旧事件不集中补发（超过窗口直接取消，并把授权退还）；
 * - 已确认、暂停、结束或撤销授权后，排队中的事件立即取消。
 */
import type { Database } from "../types.js";
import type {
  DoseMessageSender,
  ReminderTemplateConfig,
} from "../services/subscribe-messages.js";
import { SubscribeMessageUnavailableError } from "../services/subscribe-messages.js";

const CLAIM_BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;
/** 服药提醒的有效窗口（分钟）：超过就不再补发。 */
export const DOSE_REMINDER_WINDOW_MINUTES = 90;

const DOSE_PAGE = "pages/medication-plans/medication-plans";

interface ShanghaiClock {
  date: string;
  minutes: number;
  timeText: string;
}

/** 统一按上海时区取"今天"和当前分钟数，避免服务器时区差异。 */
export function shanghaiClock(now: Date): ShanghaiClock {
  const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
  const date = shifted.toISOString().slice(0, 10);
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const timeText = `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
  return { date, minutes, timeText };
}

function weekdayOf(dateText: string): string {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${dateText}T12:00:00Z`).getUTCDay()];
}

function padTime(minutes: number): string {
  const safe = Math.max(0, Math.min(23 * 60 + 59, minutes));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}:00`;
}

/** 与"今日安排"同逻辑的批量物化：提醒不能依赖有人打开过页面。 */
export async function materializeDoseOccurrencesForDate(
  database: Pick<Database, "query">,
  date: string,
): Promise<number> {
  // B08/R01：物化时保存当时的计划快照，历史日期显示不随编辑漂移；
  // 冲突目标为"活动实例"部分唯一索引，作废行让位，改期后同一时间点可重新物化。
  const result = await database.query(
    `INSERT INTO dose_occurrences (family_id, plan_id, slot_id, care_profile_id, dose_date, time_of_day,
                                   medicine_name_snapshot, dosage_text_snapshot, care_profile_name_snapshot, plan_version_snapshot)
     SELECT p.family_id, p.id, s.id, p.care_profile_id, $1::date, s.time_of_day,
            p.medicine_name, p.dosage_text, c.display_name, p.version
     FROM medication_plans p
     JOIN plan_time_slots s ON s.plan_id = p.id AND s.archived_at IS NULL
     JOIN care_profiles c ON c.id = p.care_profile_id
     WHERE p.status = 'active'
       AND p.start_date <= $1::date
       AND (p.end_date IS NULL OR p.end_date >= $1::date)
       AND $2 = ANY(p.weekdays)
     ON CONFLICT (slot_id, dose_date) WHERE superseded_at IS NULL DO NOTHING`,
    [date, weekdayOf(date)],
  );
  return result.rowCount ?? 0;
}

/** 有权限收到该照护对象提醒的成员：本人关联、创建者或已授权家人，且仍是家庭成员。 */
async function recipientIdsFor(
  database: Pick<Database, "query">,
  familyId: string,
  careProfileId: string,
  linkedUserId: string | null,
): Promise<string[]> {
  if (linkedUserId !== null) return [linkedUserId];
  const rows = await database.query<{ user_id: string }>(
    `SELECT fm.user_id FROM family_members fm
     WHERE fm.family_id = $1
       AND (
         EXISTS (SELECT 1 FROM care_profiles c WHERE c.id = $2 AND c.created_by = fm.user_id)
         OR EXISTS (SELECT 1 FROM care_grants g WHERE g.care_profile_id = $2 AND g.member_user_id = fm.user_id AND g.can_view)
       )
     ORDER BY fm.user_id`,
    [familyId, careProfileId],
  );
  return rows.rows.map((row) => row.user_id);
}

async function claimGrant(
  database: Pick<Database, "query">,
  familyId: string,
  userId: string,
  templateId: string,
): Promise<string | null> {
  const grant = await database.query<{ id: string }>(
    `SELECT id FROM wechat_subscription_grants
     WHERE family_id = $1 AND user_id = $2 AND template_id = $3 AND consumed_at IS NULL
     ORDER BY accepted_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
    [familyId, userId, templateId],
  );
  const grantId = grant.rows[0]?.id;
  if (grantId === undefined) return null;
  await database.query(
    "UPDATE wechat_subscription_grants SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL",
    [grantId],
  );
  return grantId;
}

/** 取消排队事件并把一次性授权退还（用户主动操作导致的取消不应消耗授权）。 */
export async function cancelDoseReminders(
  database: Pick<Database, "query">,
  whereClause: string,
  params: unknown[],
): Promise<number> {
  const cancelled = await database.query<{ id: string; subscription_grant_id: string | null }>(
    `UPDATE dose_reminder_deliveries
     SET status = 'cancelled', next_attempt_at = now()
     WHERE status IN ('queued', 'sending', 'failed', 'blocked') AND ${whereClause}
     RETURNING id, subscription_grant_id`,
    params,
  );
  const grants = cancelled.rows.map((row) => row.subscription_grant_id).filter((id): id is string => id !== null);
  if (grants.length > 0) {
    await database.query(
      "UPDATE wechat_subscription_grants SET consumed_at = NULL WHERE id = ANY($1::uuid[])",
      [grants],
    );
  }
  return cancelled.rowCount ?? 0;
}

export async function cancelDoseRemindersForOccurrence(
  database: Pick<Database, "query">,
  occurrenceId: string,
): Promise<number> {
  return cancelDoseReminders(database, "occurrence_id = $1", [occurrenceId]);
}

export async function cancelDoseRemindersForPlan(
  database: Pick<Database, "query">,
  planId: string,
): Promise<number> {
  return cancelDoseReminders(
    database,
    "plan_id = $1",
    [planId],
  );
}

export async function cancelDoseRemindersForMember(
  database: Pick<Database, "query">,
  familyId: string,
  userId: string,
): Promise<number> {
  return cancelDoseReminders(database, "family_id = $1 AND user_id = $2", [familyId, userId]);
}

export interface DoseQueueResult {
  queued: number;
  skippedNoGrant: number;
  materialized: number;
  reason: "ok" | "template_unavailable";
}

/** 排队：为到点未确认的实例，按可用的一次性授权排队（无授权不排队）。 */
export async function queueDoseReminders(
  database: Database,
  config: ReminderTemplateConfig,
  now: Date = new Date(),
): Promise<DoseQueueResult> {
  if (!config.doseAvailable) return { queued: 0, skippedNoGrant: 0, materialized: 0, reason: "template_unavailable" };
  const clock = shanghaiClock(now);
  const materialized = await materializeDoseOccurrencesForDate(database, clock.date);
  const lowerBound = padTime(clock.minutes - DOSE_REMINDER_WINDOW_MINUTES);
  const upperBound = padTime(clock.minutes);

  const due = await database.query<{
    id: string;
    family_id: string;
    plan_id: string;
    care_profile_id: string;
    linked_user_id: string | null;
    time_of_day: string;
  }>(
    `SELECT o.id, o.family_id, o.plan_id, o.care_profile_id,
            c.linked_user_id, o.time_of_day::text AS time_of_day
     FROM dose_occurrences o
     JOIN medication_plans p ON p.id = o.plan_id
     JOIN care_profiles c ON c.id = o.care_profile_id
     WHERE o.dose_date = $1::date AND o.status = 'pending' AND p.status = 'active'
       AND o.superseded_at IS NULL
       AND o.time_of_day <= $2::time AND o.time_of_day >= $3::time
     ORDER BY o.time_of_day, o.id`,
    [clock.date, upperBound, lowerBound],
  );

  let queued = 0;
  let skippedNoGrant = 0;
  for (const occurrence of due.rows) {
    const recipients = await recipientIdsFor(
      database,
      occurrence.family_id,
      occurrence.care_profile_id,
      occurrence.linked_user_id,
    );
    for (const userId of recipients) {
      // B05：先落投递行（唯一键 user_id+occurrence_id），成功后才占用授权。
      // 重复排队撞唯一键时不消耗任何授权；无可用授权则回收本次插入的行。
      const outcome = await database.withTransaction(async (tx) => {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO dose_reminder_deliveries
           (family_id, user_id, plan_id, occurrence_id, dose_date, time_of_day, template_id, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5::date, $6::time, $7, $8)
           ON CONFLICT (user_id, occurrence_id) DO NOTHING
           RETURNING id`,
          [occurrence.family_id, userId, occurrence.plan_id, occurrence.id,
            clock.date, occurrence.time_of_day, config.doseTemplateId, now],
        );
        const deliveryId = inserted.rows[0]?.id;
        if (deliveryId === undefined) return "duplicate" as const;
        const grantId = await claimGrant(tx, occurrence.family_id, userId, config.doseTemplateId);
        if (grantId === null) {
          await tx.query("DELETE FROM dose_reminder_deliveries WHERE id = $1", [deliveryId]);
          return "no_grant" as const;
        }
        await tx.query(
          "UPDATE dose_reminder_deliveries SET subscription_grant_id = $2 WHERE id = $1",
          [deliveryId, grantId],
        );
        return "queued" as const;
      });
      if (outcome === "queued") queued += 1;
      else skippedNoGrant += 1;
    }
  }
  return { queued, skippedNoGrant, materialized, reason: "ok" };
}

interface ClaimedDose {
  id: string;
  user_id: string;
  openid: string;
  plan_id: string;
  occurrence_id: string;
  attempts: number;
  dose_date: string;
  time_of_day: string;
  subscription_grant_id: string | null;
  plan_status: string;
  occurrence_status: string;
  occurrence_superseded: boolean;
  slot_active: boolean;
  schedule_still_covers: boolean;
  is_member: boolean;
  has_access: boolean;
}

export interface DoseDispatchResult {
  sent: number;
  failed: number;
  cancelled: number;
  blocked: number;
}

/** 发送：领取后逐条复核，任何一条不满足条件就取消并退还授权。 */
export async function dispatchDoseReminders(
  database: Database,
  sender: DoseMessageSender,
  config: ReminderTemplateConfig,
  now: Date = new Date(),
): Promise<DoseDispatchResult> {
  const result: DoseDispatchResult = { sent: 0, failed: 0, cancelled: 0, blocked: 0 };
  if (!config.doseAvailable) return result;
  const clock = shanghaiClock(now);
  const lowerBound = padTime(clock.minutes - DOSE_REMINDER_WINDOW_MINUTES);
  const upperBound = padTime(clock.minutes);

  const claimed = await database.withTransaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `WITH candidates AS (
         SELECT id FROM dose_reminder_deliveries
         WHERE status IN ('queued', 'failed', 'sending') AND next_attempt_at <= $1
         ORDER BY next_attempt_at, id
         FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE dose_reminder_deliveries d
       SET status = 'sending', attempts = attempts + 1, next_attempt_at = $1 + interval '5 minutes'
       FROM candidates c WHERE d.id = c.id RETURNING d.id`,
      [now, CLAIM_BATCH_SIZE],
    );
    const ids = rows.rows.map((row) => row.id);
    if (ids.length === 0) return [];
    const detailed = await tx.query<ClaimedDose>(
      `SELECT d.id, d.user_id, u.openid, d.plan_id, d.occurrence_id, d.attempts,
              d.dose_date::text AS dose_date, d.time_of_day::text AS time_of_day,
              d.subscription_grant_id,
              p.status AS plan_status, o.status AS occurrence_status,
              o.superseded_at IS NOT NULL AS occurrence_superseded,
              EXISTS (SELECT 1 FROM plan_time_slots s WHERE s.id = o.slot_id AND s.archived_at IS NULL) AS slot_active,
              (p.start_date <= o.dose_date AND (p.end_date IS NULL OR p.end_date >= o.dose_date)
               AND (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from o.dose_date)::int + 1] = ANY(p.weekdays)) AS schedule_still_covers,
              EXISTS (SELECT 1 FROM family_members fm WHERE fm.family_id = d.family_id AND fm.user_id = d.user_id) AS is_member,
              (
                c.linked_user_id = d.user_id
                OR c.created_by = d.user_id
                OR EXISTS (SELECT 1 FROM care_grants g
                           WHERE g.care_profile_id = o.care_profile_id AND g.member_user_id = d.user_id AND g.can_view)
              ) AS has_access
       FROM dose_reminder_deliveries d
       JOIN users u ON u.id = d.user_id
       JOIN dose_occurrences o ON o.id = d.occurrence_id
       JOIN care_profiles c ON c.id = o.care_profile_id
       JOIN medication_plans p ON p.id = d.plan_id
       WHERE d.id = ANY($1::uuid[])`,
      [ids],
    );
    return detailed.rows;
  });

  for (const delivery of claimed) {
    // 逐条复核：计划/实例状态、成员身份与照护权限都可能在排队之后变化。
    const stale = delivery.dose_date !== clock.date ||
      delivery.time_of_day > upperBound || delivery.time_of_day < lowerBound;
    const invalid = !delivery.is_member || !delivery.has_access ||
      delivery.plan_status !== "active" || delivery.occurrence_status !== "pending" ||
      delivery.occurrence_superseded || !delivery.slot_active || !delivery.schedule_still_covers;
    if (stale || invalid || delivery.attempts > MAX_ATTEMPTS) {
      await database.query(
        "UPDATE dose_reminder_deliveries SET status = $2, last_error_code = $3, next_attempt_at = now() WHERE id = $1",
        [delivery.id, invalid ? "blocked" : "cancelled",
          invalid ? (delivery.is_member ? "ACCESS_REVOKED" : "NOT_A_MEMBER") : "EXPIRED"],
      );
      if (delivery.subscription_grant_id !== null) {
        await database.query(
          "UPDATE wechat_subscription_grants SET consumed_at = NULL WHERE id = $1",
          [delivery.subscription_grant_id],
        );
      }
      if (invalid) result.blocked += 1;
      else result.cancelled += 1;
      continue;
    }
    try {
      const sent = await sender.sendDose({
        openid: delivery.openid,
        page: DOSE_PAGE,
        doseDate: delivery.dose_date,
        timeText: delivery.time_of_day.slice(0, 5),
      });
      await database.query(
        "UPDATE dose_reminder_deliveries SET status = 'sent', message_id = $2, sent_at = now(), next_attempt_at = now() WHERE id = $1",
        [delivery.id, sent.messageId],
      );
      result.sent += 1;
    } catch (error) {
      const code = error instanceof SubscribeMessageUnavailableError ? "NOTIFICATION_UNAVAILABLE" : "SEND_FAILED";
      await database.query(
        "UPDATE dose_reminder_deliveries SET status = 'failed', last_error_code = $2, next_attempt_at = now() + interval '5 minutes' WHERE id = $1",
        [delivery.id, code],
      );
      result.failed += 1;
    }
  }
  return result;
}

/**
 * 定时调度：与库存提醒一样由环境变量开启，模板不可用时直接不启动。
 * 每轮先排队（按可用授权），再发送（发送前复核）。
 */
export function startDoseReminderScheduler(
  database: Database,
  sender: DoseMessageSender,
  config: ReminderTemplateConfig,
  logger: { warn(message: string): void },
): () => void {
  if (process.env.WECHAT_DOSE_REMINDER_SCHEDULER_ENABLED !== "true" || !config.doseAvailable) return () => undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void queueDoseReminders(database, config)
      .then(() => dispatchDoseReminders(database, sender, config))
      .catch(() => logger.warn("dose reminder scheduler pass failed"))
      .finally(() => { running = false; });
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
