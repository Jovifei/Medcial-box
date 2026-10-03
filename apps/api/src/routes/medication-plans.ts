/**
 * 用药计划（R3）：照护对象、授权、计划与时间点、今日安排物化、幂等确认。
 *
 * 权限语义（migration 016 注释同源）：
 * - 关联账号的照护对象 = 私有计划，仅本人可见可管理（管理员无特权）；
 * - 未关联账号（孩子/老人）由创建者管理，其他家人凭 care_grants
 *   获得 can_view / can_manage（分别配置）；
 * - 修改计划只影响未来实例（暂停/结束仅改变物化条件，既有服药记录保留）；
 * - 确认使用幂等键：重试返回既有结果；纠正以新事件追加，状态随之更新；
 * - 服药记录不自动扣减库存。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { errorBody } from "../types.js";
import { requireFamily } from "../auth/session.js";
import type { Database } from "../types.js";
import {
  cancelDoseReminders,
  cancelDoseRemindersForOccurrence,
  cancelDoseRemindersForPlan,
} from "../jobs/dose-reminder-scheduler.js";
import type { ReminderTemplateConfig } from "../services/subscribe-messages.js";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** B17：正则只保证形状；真实日历校验（闰年/月底）避免 22008 变 500。 */
function isValidCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

interface CareProfileRow {
  id: string;
  display_name: string;
  linked_user_id: string | null;
  created_by: string;
}

interface PlanRow {
  id: string;
  care_profile_id: string;
  medicine_id: string | null;
  medicine_name: string;
  dosage_text: string;
  weekdays: string[] | null;
  start_date: string;
  end_date: string | null;
  status: "active" | "paused" | "ended";
  version: number;
}

interface AccessContext {
  canView: boolean;
  canManage: boolean;
}

/** 计划可见性判定：本人关联=私有；无账号对象按创建者/grants；管理员无特权。 */
async function accessFor(
  database: Pick<Database, "query">,
  profile: CareProfileRow,
  userId: string,
): Promise<AccessContext> {
  if (profile.linked_user_id !== null) {
    const own = profile.linked_user_id === userId;
    return { canView: own, canManage: own };
  }
  if (profile.created_by === userId) return { canView: true, canManage: true };
  const grant = await database.query<{ can_view: boolean; can_manage: boolean }>(
    "SELECT can_view, can_manage FROM care_grants WHERE care_profile_id = $1 AND member_user_id = $2",
    [profile.id, userId],
  );
  if (grant.rows[0] === undefined) return { canView: false, canManage: false };
  return { canView: grant.rows[0].can_view || grant.rows[0].can_manage, canManage: grant.rows[0].can_manage };
}

async function receivesAndroidDose(database: Pick<Database, "query">, profile: CareProfileRow, userId: string): Promise<boolean> {
  const prefs = (await database.query<{ channels: string[] }>("SELECT channels FROM notification_preferences WHERE user_id=$1", [userId])).rows[0];
  if (!prefs?.channels.includes("android")) return false;
  if (profile.linked_user_id === userId || (profile.linked_user_id === null && profile.created_by === userId)) return true;
  if (profile.linked_user_id !== null) return false;
  return (await database.query<{ receive_dose_reminders: boolean }>("SELECT receive_dose_reminders FROM care_grants WHERE care_profile_id=$1 AND member_user_id=$2", [profile.id, userId])).rows[0]?.receive_dose_reminders === true;
}

/** 当前生效的时间点（归档的只保留历史，不再物化）。 */
async function loadSlots(database: Pick<Database, "query">, planId: string): Promise<Array<{ id: string; time: string }>> {
  const slots = await database.query<{ id: string; time_of_day: string }>(
    "SELECT id, time_of_day::text AS time_of_day FROM plan_time_slots WHERE plan_id = $1 AND archived_at IS NULL ORDER BY time_of_day",
    [planId],
  );
  return slots.rows.map((row) => ({ id: row.id, time: row.time_of_day.slice(0, 5) }));
}

async function loadProfile(database: Pick<Database, "query">, familyId: string, profileId: string): Promise<CareProfileRow | null> {
  const rows = await database.query<CareProfileRow>(
    "SELECT id, display_name, linked_user_id, COALESCE(managed_by, created_by) AS created_by FROM care_profiles WHERE id = $1 AND family_id = $2 AND archived_at IS NULL",
    [profileId, familyId],
  );
  return rows.rows[0] ?? null;
}

/** 上海时区的"今天"（与提醒调度同一时区语义）。 */
function shanghaiToday(): string {
  const shanghai = new Date(Date.now() + 8 * 3600 * 1000);
  return shanghai.toISOString().slice(0, 10);
}

/** 上海时区的当前时刻 HH:MM:SS，用于确定编辑作废的"未来"边界（R01）。 */
function shanghaiCurrentTime(): string {
  const shanghai = new Date(Date.now() + 8 * 3600 * 1000);
  return shanghai.toISOString().slice(11, 19);
}

function weekdayOf(dateText: string): Weekday {
  // dateText 是上海日历日；用正午 UTC 计算星期，避免时区回退。
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${dateText}T12:00:00Z`).getUTCDay()] as Weekday;
}

function profileLabel(profile: CareProfileRow): string {
  return profile.display_name;
}

export async function registerMedicationPlanRoutes(
  app: FastifyInstance,
  database: Database,
  templateConfig?: ReminderTemplateConfig,
): Promise<void> {
  // —— 照护对象 ——

  app.post("/api/v1/care-profiles", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const body = request.body as Record<string, unknown> | null;
    const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
    if (displayName === "" || displayName.length > 40) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "照护对象名称需为 1-40 个字符"));
    }
    const rawLinked = body?.linkedUserId;
    // 关联账号的照护对象 = 本人私有计划：只允许为自己创建。
    const linkedUserId = typeof rawLinked === "string" && rawLinked.trim() !== "" ? rawLinked.trim() : null;
    if (linkedUserId !== null && linkedUserId !== ctx.userId) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "关联账号的照护对象只能是自己；家人请用不关联账号的方式创建"));
    }
    if (linkedUserId !== null) {
      const member = await database.query<{ id: string }>(
        "SELECT id FROM family_members WHERE user_id = $1 AND family_id = $2",
        [linkedUserId, ctx.familyId],
      );
      if (member.rowCount === 0) return reply.code(404).send(errorBody("NOT_FOUND", "成员不存在或不在当前家庭"));
    }
    const created = await database.query<CareProfileRow>(
      `INSERT INTO care_profiles (family_id, display_name, linked_user_id, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id, display_name, linked_user_id, created_by`,
      [ctx.familyId, displayName, linkedUserId, ctx.userId],
    );
    const profile = created.rows[0];
    return reply.code(201).send({
      id: profile.id,
      displayName: profile.display_name,
      linkedUserId: profile.linked_user_id,
      isPrivate: profile.linked_user_id !== null,
    });
  });

  // B10：本人档案由服务端绑定当前身份，幂等；客户端不再凭 displayName/linkedUserId 猜"我自己"。
  app.post("/api/v1/care-profiles/self", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const body = request.body as Record<string, unknown> | null;
    const rawName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
    const displayName = rawName === "" ? "我" : rawName.slice(0, 40);
    const member = await database.query<{ id: string }>(
      "SELECT id FROM family_members WHERE user_id = $1 AND family_id = $2",
      [ctx.userId, ctx.familyId],
    );
    if (member.rowCount === 0) return reply.code(404).send(errorBody("NOT_FOUND", "成员不存在或不在当前家庭"));
    const existing = await database.query<CareProfileRow>(
      "SELECT id, display_name, linked_user_id, COALESCE(managed_by, created_by) AS created_by FROM care_profiles WHERE family_id = $1 AND linked_user_id = $2 AND archived_at IS NULL",
      [ctx.familyId, ctx.userId],
    );
    if (existing.rows[0]) {
      const profile = existing.rows[0];
      return reply.code(200).send({
        id: profile.id,
        displayName: profile.display_name,
        linkedUserId: profile.linked_user_id,
        isPrivate: true,
        alreadyExisted: true,
      });
    }
    const created = await database.query<CareProfileRow>(
      `INSERT INTO care_profiles (family_id, display_name, linked_user_id, created_by)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (family_id, linked_user_id) WHERE linked_user_id IS NOT NULL AND archived_at IS NULL DO NOTHING
       RETURNING id, display_name, linked_user_id, created_by`,
      [ctx.familyId, displayName, ctx.userId],
    );
    let profile = created.rows[0];
    let alreadyExisted = false;
    if (profile === undefined) {
      // R06：并发下另一请求已抢先创建本人档案——回读既有行，绝不产生第二个。
      const reread = await database.query<CareProfileRow>(
        "SELECT id, display_name, linked_user_id, COALESCE(managed_by, created_by) AS created_by FROM care_profiles WHERE family_id = $1 AND linked_user_id = $2 AND archived_at IS NULL",
        [ctx.familyId, ctx.userId],
      );
      profile = reread.rows[0];
      alreadyExisted = true;
    }
    if (profile === undefined) {
      return reply.code(500).send(errorBody("INTERNAL_ERROR", "本人档案创建失败，请重试"));
    }
    return reply.code(alreadyExisted ? 200 : 201).send({
      id: profile.id,
      displayName: profile.display_name,
      linkedUserId: profile.linked_user_id,
      isPrivate: true,
      alreadyExisted,
    });
  });

  app.get("/api/v1/care-profiles", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const rows = await database.query<CareProfileRow>(
      "SELECT id, display_name, linked_user_id, COALESCE(managed_by, created_by) AS created_by FROM care_profiles WHERE family_id = $1 AND archived_at IS NULL ORDER BY created_at",
      [ctx.familyId],
    );
    const visible = [];
    for (const profile of rows.rows) {
      const access = await accessFor(database, profile, ctx.userId);
      if (access.canView) visible.push({ id: profile.id, displayName: profileLabel(profile), linkedUserId: profile.linked_user_id, canManage: access.canManage, isPrivate: profile.linked_user_id !== null });
    }
    return { careProfiles: visible };
  });

  app.post<{ Params: { careProfileId: string } }>("/api/v1/care-profiles/:careProfileId/grants", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const profile = await loadProfile(database, ctx.familyId, request.params.careProfileId);
    if (profile === null) return reply.code(404).send(errorBody("NOT_FOUND", "照护对象不存在"));
    const access = await accessFor(database, profile, ctx.userId);
    if (!access.canManage) return reply.code(403).send(errorBody("FORBIDDEN", "只有该照护对象的管理者可以授权"));
    const body = request.body as Record<string, unknown> | null;
    const memberUserId = typeof body?.memberUserId === "string" ? body.memberUserId.trim() : "";
    const canManage = body?.canManage === true;
    const canView = canManage || body?.canView !== false;
    const receiveDoseReminders = body?.receiveDoseReminders === true;
    if (memberUserId === "") return reply.code(400).send(errorBody("VALIDATION_ERROR", "memberUserId 必填"));
    if (memberUserId === ctx.userId) return reply.code(400).send(errorBody("VALIDATION_ERROR", "不需要给自己授权"));
    const member = await database.query<{ id: string }>(
      "SELECT id FROM family_members WHERE user_id = $1 AND family_id = $2",
      [memberUserId, ctx.familyId],
    );
    if (member.rowCount === 0) return reply.code(404).send(errorBody("NOT_FOUND", "成员不存在或不在当前家庭"));
    // 授权他人查看/管理：can_view 恒为 true（canManage 蕴含查看）。
    await database.query(
      `INSERT INTO care_grants (family_id, care_profile_id, member_user_id, can_view, can_manage, created_by, receive_dose_reminders)
       VALUES ($1, $2, $3, $6, $4, $5, $7)
       ON CONFLICT (care_profile_id, member_user_id)
       DO UPDATE SET can_view = EXCLUDED.can_view, can_manage = EXCLUDED.can_manage, created_by = EXCLUDED.created_by, receive_dose_reminders = EXCLUDED.receive_dose_reminders`,
      [ctx.familyId, profile.id, memberUserId, canManage, ctx.userId, canView, receiveDoseReminders],
    );
    if (!receiveDoseReminders) await cancelDoseReminders(database, "user_id = $1 AND plan_id IN (SELECT id FROM medication_plans WHERE care_profile_id = $2)", [memberUserId, profile.id]);
    return { careProfileId: profile.id, memberUserId, canView, canManage, receiveDoseReminders };
  });

  app.get<{ Params: { careProfileId: string } }>("/api/v1/care-profiles/:careProfileId/grants", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const profile = await loadProfile(database, ctx.familyId, request.params.careProfileId);
    if (profile === null) return reply.code(404).send(errorBody("NOT_FOUND", "照护对象不存在"));
    const access = await accessFor(database, profile, ctx.userId);
    if (!access.canManage) return reply.code(403).send(errorBody("FORBIDDEN", "只有该照护对象的管理者可以查看授权"));
    const rows = await database.query<{ member_user_id: string; nickname: string | null; can_view: boolean; can_manage: boolean; receive_dose_reminders: boolean }>(
      `SELECT g.member_user_id, u.nickname, g.can_view, g.can_manage, g.receive_dose_reminders
       FROM care_grants g JOIN family_members m ON m.user_id = g.member_user_id AND m.family_id = g.family_id
       LEFT JOIN users u ON u.id = g.member_user_id
       WHERE g.care_profile_id = $1 ORDER BY u.nickname NULLS LAST`,
      [profile.id],
    );
    return {
      careProfileId: profile.id,
      displayName: profile.display_name,
      grants: rows.rows.map((row) => ({
        memberUserId: row.member_user_id,
        displayName: row.nickname ?? "家人",
        canView: row.can_view,
        canManage: row.can_manage,
        receiveDoseReminders: row.receive_dose_reminders,
      })),
    };
  });

  app.delete<{ Params: { careProfileId: string; memberUserId: string } }>("/api/v1/care-profiles/:careProfileId/grants/:memberUserId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const profile = await loadProfile(database, ctx.familyId, request.params.careProfileId);
    if (profile === null) return reply.code(404).send(errorBody("NOT_FOUND", "照护对象不存在"));
    const access = await accessFor(database, profile, ctx.userId);
    if (!access.canManage) return reply.code(403).send(errorBody("FORBIDDEN", "只有该照护对象的管理者可以撤销授权"));
    const removed = await database.query(
      "DELETE FROM care_grants WHERE care_profile_id = $1 AND member_user_id = $2 AND family_id = $3",
      [profile.id, request.params.memberUserId, ctx.familyId],
    );
    // 撤销后该成员立刻看不到该对象的计划与服药安排；已产生的记录保留在家庭内。
    if ((removed.rowCount ?? 0) > 0) {
      await cancelDoseReminders(database, "user_id = $1 AND plan_id IN (SELECT id FROM medication_plans WHERE care_profile_id = $2)", [request.params.memberUserId, profile.id]);
    }
    return { careProfileId: profile.id, memberUserId: request.params.memberUserId, removed: (removed.rowCount ?? 0) > 0 };
  });

  app.post<{ Params: { careProfileId: string } }>("/api/v1/care-profiles/:careProfileId/transfer-management", async (request, reply) => {
    const ctx = requireFamily(request, reply); if (ctx === null) return;
    const profile = await loadProfile(database, ctx.familyId, request.params.careProfileId);
    if (profile === null) return reply.code(404).send(errorBody("NOT_FOUND", "照护对象不存在"));
    if (profile.linked_user_id !== null || profile.created_by !== ctx.userId) return reply.code(403).send(errorBody("FORBIDDEN", "只有当前负责人可交接"));
    const body = request.body as Record<string, unknown> | null;
    const target = typeof body?.memberUserId === "string" ? body.memberUserId : "";
    const result = await database.withTransaction(async (tx) => {
      await tx.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [ctx.familyId]);
      const member = await tx.query(`SELECT fm.user_id FROM family_members fm JOIN care_grants g ON g.member_user_id=fm.user_id AND g.family_id=fm.family_id WHERE fm.family_id=$1 AND fm.user_id=$2 AND g.care_profile_id=$3 AND g.can_manage`, [ctx.familyId, target, profile.id]);
      if (member.rowCount === 0) return "invalid";
      const updated = await tx.query("UPDATE care_profiles SET managed_by=$1 WHERE id=$2 AND family_id=$3 AND archived_at IS NULL AND COALESCE(managed_by,created_by)=$4", [target, profile.id, ctx.familyId, ctx.userId]);
      return updated.rowCount === 0 ? "conflict" : "ok";
    });
    if (result === "invalid") return reply.code(400).send(errorBody("VALIDATION_ERROR", "接收人须为当前已获管理权限的家庭成员"));
    if (result === "conflict") return reply.code(409).send(errorBody("VERSION_CONFLICT", "负责人已变化，请刷新"));
    return { careProfileId: profile.id, transferred: true };
  });
  app.post<{ Params: { careProfileId: string } }>("/api/v1/care-profiles/:careProfileId/archive", async (request, reply) => {
    const ctx = requireFamily(request, reply); if (ctx === null) return;
    const profile = await loadProfile(database, ctx.familyId, request.params.careProfileId);
    if (profile === null) return reply.code(404).send(errorBody("NOT_FOUND", "照护对象不存在"));
    if (profile.created_by !== ctx.userId && profile.linked_user_id !== ctx.userId) return reply.code(403).send(errorBody("FORBIDDEN", "只有负责人可归档"));
    const archived = await database.withTransaction(async (tx) => {
      await tx.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [ctx.familyId]);
      const archived = await tx.query("UPDATE care_profiles SET archived_at=now() WHERE id=$1 AND family_id=$2 AND archived_at IS NULL AND (COALESCE(managed_by,created_by)=$3 OR linked_user_id=$3)", [profile.id, ctx.familyId, ctx.userId]);
      if (archived.rowCount === 0) return false;
      await tx.query("UPDATE medication_plans SET status='ended',version=version+1 WHERE care_profile_id=$1 AND status <> 'ended'", [profile.id]);
      await cancelDoseReminders(tx, "plan_id IN (SELECT id FROM medication_plans WHERE care_profile_id=$1)", [profile.id]);
      return true;
    });
    if (!archived) return reply.code(409).send(errorBody("VERSION_CONFLICT", "负责人已变化，请刷新"));
    return { careProfileId: profile.id, archived: true };
  });

  // —— 计划 ——

  app.post("/api/v1/medication-plans", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const body = request.body as Record<string, unknown> | null;
    const careProfileId = typeof body?.careProfileId === "string" ? body.careProfileId.trim() : "";
    const medicineName = typeof body?.medicineName === "string" ? body.medicineName.trim() : "";
    const dosageText = typeof body?.dosageText === "string" ? body.dosageText.trim() : "";
    const startDate = typeof body?.startDate === "string" ? body.startDate.trim() : "";
    const rawEndDate = typeof body?.endDate === "string" ? body.endDate.trim() : "";
    const rawSlots = Array.isArray(body?.timeSlots) ? (body?.timeSlots as unknown[]) : [];
    const timeSlots = rawSlots.filter((slot): slot is string => typeof slot === "string" && TIME_PATTERN.test(slot));
    const rawWeekdays = Array.isArray(body?.weekdays) ? (body?.weekdays as unknown[]) : [];
    const weekdays = rawWeekdays.filter((day): day is Weekday => (WEEKDAYS as readonly string[]).includes(day as string));

    if (careProfileId === "") return reply.code(400).send(errorBody("VALIDATION_ERROR", "careProfileId 必填"));
    if (medicineName === "" || medicineName.length > 80) return reply.code(400).send(errorBody("VALIDATION_ERROR", "药名必填（可手填或从药箱选择）"));
    if (dosageText === "" || dosageText.length > 80) return reply.code(400).send(errorBody("VALIDATION_ERROR", "剂量说明必填（例如每次 5ml）"));
    if (!isValidCalendarDate(startDate)) return reply.code(400).send(errorBody("VALIDATION_ERROR", "startDate 需为真实日期 YYYY-MM-DD"));
    if (rawEndDate !== "" && !isValidCalendarDate(rawEndDate)) return reply.code(400).send(errorBody("VALIDATION_ERROR", "endDate 需为真实日期 YYYY-MM-DD"));
    if (rawEndDate !== "" && rawEndDate < startDate) return reply.code(400).send(errorBody("VALIDATION_ERROR", "结束日期不能早于开始日期"));
    if (timeSlots.length === 0 || timeSlots.length > 6) return reply.code(400).send(errorBody("VALIDATION_ERROR", "每日时间点需 1-6 个，格式 HH:MM"));
    if (new Set(timeSlots).size !== timeSlots.length) return reply.code(400).send(errorBody("VALIDATION_ERROR", "时间点不能重复"));
    // 不传 weekdays = 每天（方案默认）。
    const medicineId = typeof body?.medicineId === "string" && body.medicineId.trim() !== "" ? body.medicineId.trim() : null;

    const profile = await loadProfile(database, ctx.familyId, careProfileId);
    if (profile === null) return reply.code(404).send(errorBody("NOT_FOUND", "照护对象不存在"));
    const access = await accessFor(database, profile, ctx.userId);
    if (!access.canManage) return reply.code(403).send(errorBody("FORBIDDEN", "没有为该照护对象创建计划的权限"));

    if (medicineId !== null) {
      const medicine = await database.query<{ id: string }>(
        "SELECT id FROM medicines WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL",
        [medicineId, ctx.familyId],
      );
      if (medicine.rowCount === 0) return reply.code(404).send(errorBody("NOT_FOUND", "药品不存在或不属于当前家庭"));
    }

    const planId = await database.withTransaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO medication_plans
         (family_id, care_profile_id, medicine_id, medicine_name, dosage_text, weekdays, start_date, end_date, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
        [ctx.familyId, profile.id, medicineId, medicineName, dosageText, weekdays.length > 0 ? weekdays : [...WEEKDAYS], startDate, rawEndDate === "" ? null : rawEndDate, ctx.userId],
      );
      const planId = inserted.rows[0].id;
      for (const slot of timeSlots) {
        await tx.query("INSERT INTO plan_time_slots (id, plan_id, time_of_day) VALUES ($1, $2, $3)", [randomUUID(), planId, slot]);
      }
      return planId;
    });
    return reply.code(201).send({ planId, careProfileId: profile.id, status: "active", version: 1 });
  });

  // status 缺省只看未结束；status=all 或 ended 可显式查看已结束的计划（保留历史入口）。
  app.get<{ Querystring: { status?: string } }>("/api/v1/medication-plans", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const rawStatus = typeof request.query.status === "string" ? request.query.status : "";
    const statusFilter = rawStatus === "all" ? "" : rawStatus === "ended" ? "AND p.status = 'ended'" : "AND p.status <> 'ended'";
    const plans = await database.query<PlanRow & { display_name: string; linked_user_id: string | null; created_by: string }>(
      `SELECT p.id, p.care_profile_id, p.medicine_id, p.medicine_name, p.dosage_text, p.weekdays,
              p.start_date::text AS start_date, p.end_date::text AS end_date, p.status, p.version,
              c.display_name, c.linked_user_id, COALESCE(c.managed_by,c.created_by) AS created_by
       FROM medication_plans p JOIN care_profiles c ON c.id = p.care_profile_id
       WHERE p.family_id = $1 AND c.archived_at IS NULL ${statusFilter}
       ORDER BY p.created_at`,
      [ctx.familyId],
    );
    const visible = [];
    for (const plan of plans.rows) {
      const profile: CareProfileRow = { id: plan.care_profile_id, display_name: plan.display_name, linked_user_id: plan.linked_user_id, created_by: plan.created_by };
      const access = await accessFor(database, profile, ctx.userId);
      if (!access.canView) continue;
      const slots = await loadSlots(database, plan.id);
      visible.push({
        id: plan.id,
        careProfileId: plan.care_profile_id,
        careProfileName: plan.display_name,
        medicineId: plan.medicine_id,
        medicineName: plan.medicine_name,
        dosageText: plan.dosage_text,
        weekdays: plan.weekdays ?? [],
        startDate: plan.start_date,
        endDate: plan.end_date,
        status: plan.status,
        version: plan.version,
        timeSlots: slots.map((slot) => slot.time),
      });
    }
    return { plans: visible };
  });

  app.post<{ Params: { planId: string } }>("/api/v1/medication-plans/:planId/pause", async (request, reply) => {
    return changePlanStatus(request, reply, "pause");
  });
  app.post<{ Params: { planId: string } }>("/api/v1/medication-plans/:planId/resume", async (request, reply) => {
    return changePlanStatus(request, reply, "resume");
  });
  app.post<{ Params: { planId: string } }>("/api/v1/medication-plans/:planId/end", async (request, reply) => {
    return changePlanStatus(request, reply, "end");
  });

  async function changePlanStatus(
    request: FastifyRequest<{ Params: { planId: string } }>,
    reply: FastifyReply,
    action: "pause" | "resume" | "end",
  ): Promise<unknown> {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const body = request.body as Record<string, unknown> | null;
    const expectedVersion = typeof body?.version === "number" ? body.version : null;
    if (expectedVersion === null) return reply.code(400).send(errorBody("VALIDATION_ERROR", "version 必填"));
    const plan = (await database.query<PlanRow & { display_name: string; linked_user_id: string | null; created_by: string }>(
      `SELECT p.id, p.care_profile_id, p.medicine_id, p.medicine_name, p.dosage_text, p.weekdays,
              p.start_date::text AS start_date, p.end_date::text AS end_date, p.status, p.version,
              c.display_name, c.linked_user_id, COALESCE(c.managed_by,c.created_by) AS created_by
       FROM medication_plans p JOIN care_profiles c ON c.id = p.care_profile_id
       WHERE p.id = $1 AND p.family_id = $2 AND c.archived_at IS NULL`,
      [request.params.planId, ctx.familyId],
    )).rows[0];
    if (plan === undefined) return reply.code(404).send(errorBody("NOT_FOUND", "计划不存在"));
    const profile: CareProfileRow = { id: plan.care_profile_id, display_name: plan.display_name, linked_user_id: plan.linked_user_id, created_by: plan.created_by };
    const access = await accessFor(database, profile, ctx.userId);
    if (!access.canManage) return reply.code(403).send(errorBody("FORBIDDEN", "没有管理该计划的权限"));
    const nextStatus = action === "pause" ? "paused" : action === "resume" ? "active" : "ended";
    if (plan.status === nextStatus) return { planId: plan.id, status: plan.status, version: plan.version };
    const updated = await database.query<{ version: number }>(
      `UPDATE medication_plans SET status = $3, updated_by = $4, updated_at = now(), version = version + 1
       WHERE id = $1 AND family_id = $2 AND version = $5 RETURNING version`,
      [plan.id, ctx.familyId, nextStatus, ctx.userId, expectedVersion],
    );
    if (updated.rowCount === 0) return reply.code(409).send(errorBody("VERSION_CONFLICT", "计划已被他人修改，请刷新后重试"));
    // 暂停或结束后，尚未发出的服药提醒立即取消（一次性授权退还给用户）。
    if (nextStatus !== "active") {
      await cancelDoseRemindersForPlan(database, plan.id);
    }
    return { planId: plan.id, status: nextStatus, version: updated.rows[0].version };
  }

  // —— 计划详情、编辑与历史 ——

  interface PlanContext {
    ctx: { userId: string; familyId: string };
    plan: PlanRow & { display_name: string; linked_user_id: string | null; created_by: string };
    profile: CareProfileRow;
    access: AccessContext;
  }

  async function loadPlanContext(
    request: FastifyRequest<{ Params: { planId: string } }>,
    reply: FastifyReply,
  ): Promise<PlanContext | null> {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return null;
    const plan = (await database.query<PlanRow & { display_name: string; linked_user_id: string | null; created_by: string }>(
      `SELECT p.id, p.care_profile_id, p.medicine_id, p.medicine_name, p.dosage_text, p.weekdays,
              p.start_date::text AS start_date, p.end_date::text AS end_date, p.status, p.version,
              c.display_name, c.linked_user_id, COALESCE(c.managed_by,c.created_by) AS created_by
       FROM medication_plans p JOIN care_profiles c ON c.id = p.care_profile_id
       WHERE p.id = $1 AND p.family_id = $2 AND c.archived_at IS NULL`,
      [request.params.planId, ctx.familyId],
    )).rows[0];
    if (plan === undefined) {
      reply.code(404).send(errorBody("NOT_FOUND", "计划不存在"));
      return null;
    }
    const profile: CareProfileRow = {
      id: plan.care_profile_id,
      display_name: plan.display_name,
      linked_user_id: plan.linked_user_id,
      created_by: plan.created_by,
    };
    const access = await accessFor(database, profile, ctx.userId);
    return { ctx, plan, profile, access };
  }

  app.get<{ Params: { planId: string } }>("/api/v1/medication-plans/:planId", async (request, reply) => {
    const loaded = await loadPlanContext(request, reply);
    if (loaded === null) return;
    if (!loaded.access.canView) return reply.code(403).send(errorBody("FORBIDDEN", "没有查看该计划的权限"));
    const slots = await loadSlots(database, loaded.plan.id);
    return {
      plan: {
        id: loaded.plan.id,
        careProfileId: loaded.plan.care_profile_id,
        careProfileName: loaded.plan.display_name,
        medicineId: loaded.plan.medicine_id,
        medicineName: loaded.plan.medicine_name,
        dosageText: loaded.plan.dosage_text,
        weekdays: loaded.plan.weekdays ?? [],
        startDate: loaded.plan.start_date,
        endDate: loaded.plan.end_date,
        status: loaded.plan.status,
        version: loaded.plan.version,
        timeSlots: slots.map((slot) => slot.time),
      },
      canManage: loaded.access.canManage,
    };
  });

  app.put<{ Params: { planId: string } }>("/api/v1/medication-plans/:planId", async (request, reply) => {
    const loaded = await loadPlanContext(request, reply);
    if (loaded === null) return;
    if (!loaded.access.canManage) return reply.code(403).send(errorBody("FORBIDDEN", "没有修改该计划的权限"));
    const body = request.body as Record<string, unknown> | null;
    const expectedVersion = typeof body?.version === "number" ? body.version : null;
    if (expectedVersion === null) return reply.code(400).send(errorBody("VALIDATION_ERROR", "version 必填"));
    if (loaded.plan.status === "ended") return reply.code(409).send(errorBody("PLAN_ENDED", "已结束的计划不能再修改"));

    const next = {
      medicineName: loaded.plan.medicine_name,
      dosageText: loaded.plan.dosage_text,
      weekdays: loaded.plan.weekdays ?? [...WEEKDAYS],
      startDate: loaded.plan.start_date,
      endDate: loaded.plan.end_date,
      timeSlots: (await loadSlots(database, loaded.plan.id)).map((slot) => slot.time),
    };

    if (body?.medicineName !== undefined) {
      const value = String(body.medicineName).trim();
      if (value === "" || value.length > 80) return reply.code(400).send(errorBody("VALIDATION_ERROR", "药名必填（可手填或从药箱选择）"));
      next.medicineName = value;
    }
    if (body?.dosageText !== undefined) {
      const value = String(body.dosageText).trim();
      if (value === "" || value.length > 80) return reply.code(400).send(errorBody("VALIDATION_ERROR", "剂量说明必填（例如每次 5ml）"));
      next.dosageText = value;
    }
    if (body?.startDate !== undefined) {
      const value = String(body.startDate).trim();
      if (!isValidCalendarDate(value)) return reply.code(400).send(errorBody("VALIDATION_ERROR", "startDate 需为真实日期 YYYY-MM-DD"));
      next.startDate = value;
    }
    // B16：endDate 省略 = 保留；显式 null 或空串 = 清空（转为长期）；字符串 = 更新。
    if (body?.endDate !== undefined) {
      if (body.endDate === null) {
        next.endDate = null;
      } else {
        const value = String(body.endDate).trim();
        if (value !== "" && !isValidCalendarDate(value)) return reply.code(400).send(errorBody("VALIDATION_ERROR", "endDate 需为真实日期 YYYY-MM-DD"));
        next.endDate = value === "" ? null : value;
      }
    }
    if (next.endDate !== null && next.endDate < next.startDate) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "结束日期不能早于开始日期"));
    }
    if (body?.weekdays !== undefined) {
      const raw = Array.isArray(body.weekdays) ? (body.weekdays as unknown[]) : null;
      if (raw === null) return reply.code(400).send(errorBody("VALIDATION_ERROR", "weekdays 需为数组"));
      const list = raw.filter((day): day is Weekday => (WEEKDAYS as readonly string[]).includes(day as string));
      if (list.length === 0) return reply.code(400).send(errorBody("VALIDATION_ERROR", "至少需要选择一天"));
      next.weekdays = list;
    }
    if (body?.timeSlots !== undefined) {
      const raw = Array.isArray(body.timeSlots) ? (body.timeSlots as unknown[]) : null;
      if (raw === null) return reply.code(400).send(errorBody("VALIDATION_ERROR", "timeSlots 需为数组"));
      const list = raw.map((slot) => String(slot)).filter((slot) => TIME_PATTERN.test(slot));
      if (list.length === 0 || list.length > 6) return reply.code(400).send(errorBody("VALIDATION_ERROR", "每日时间点需 1-6 个，格式 HH:MM"));
      if (new Set(list).size !== list.length) return reply.code(400).send(errorBody("VALIDATION_ERROR", "时间点不能重复"));
      next.timeSlots = list;
    }

    const result = await database.withTransaction(async (tx: Pick<Database, "query">) => {
      const updated = await tx.query<{ version: number }>(
        `UPDATE medication_plans SET medicine_name = $3, dosage_text = $4, weekdays = $5,
                start_date = $6, end_date = $7, updated_by = $8, updated_at = now(), version = version + 1
         WHERE id = $1 AND family_id = $2 AND version = $9 RETURNING version`,
        [loaded.plan.id, loaded.ctx.familyId, next.medicineName, next.dosageText, next.weekdays,
          next.startDate, next.endDate, loaded.ctx.userId, expectedVersion],
      );
      if (updated.rowCount === 0) return { conflict: true as const };
      const desired = new Set(next.timeSlots);
      // 归档被移除的时间点：已生成的服药实例与确认事件保留，只是不再产生新的安排。
      // 捕获被归档的 slot_id，用于下面区分作废边界（R01/B06）。
      const archived = await tx.query<{ id: string }>(
        "UPDATE plan_time_slots SET archived_at = now() WHERE plan_id = $1 AND archived_at IS NULL AND time_of_day::text NOT IN (SELECT unnest($2::text[])) RETURNING id",
        [loaded.plan.id, [...desired].map((slot) => `${slot}:00`)],
      );
      const archivedSlotIds = archived.rows.map((row) => row.id);
      for (const slot of desired) {
        await tx.query(
          `INSERT INTO plan_time_slots (plan_id, time_of_day) VALUES ($1, $2::time)
           ON CONFLICT (plan_id, time_of_day) DO UPDATE SET archived_at = NULL`,
          [loaded.plan.id, `${slot}:00`],
        );
      }
      // B06/B08/R01：计划内容或排程变更后作废受影响的 pending 实例（与用户"跳过"区分，
      // 保留 superseded_at 标记），并同事务取消其投递、退还授权；已确认实例不删不改。
      // 作废边界区分两种语义：
      //   - 被移除（归档）的时间点：其今天及未来的 pending 全部作废——该服药时间已不存在，
      //     即便今天已到点也应取消（旧投递不再发送）；
      //   - 保留的时间点：只作废"尚未发生"的严格未来 pending，今天已到点/已确认的记录保留，
      //     不能用 dose_date >= today 把当天早已到点的安排一并清掉。
      // 之后由日程按新快照重新物化（活动实例部分唯一索引让位作废行）。
      const today = shanghaiToday();
      const nowTime = shanghaiCurrentTime();
      const superseded = await tx.query<{ id: string }>(
        `UPDATE dose_occurrences SET superseded_at = now()
         WHERE plan_id = $1 AND status = 'pending' AND superseded_at IS NULL
           AND (
             (slot_id = ANY($4::uuid[]) AND dose_date >= $2::date)
             OR dose_date > $2::date
             OR (dose_date = $2::date AND time_of_day > $3::time)
           )
         RETURNING id`,
        [loaded.plan.id, today, nowTime, archivedSlotIds],
      );
      const supersededIds = superseded.rows.map((row) => row.id);
      if (supersededIds.length > 0) {
        // R05：统一走共享取消入口，由它区分"确定未发送"（退还授权）与
        // "在途/结果不确定"（仅标 cancel_requested，不退授权、不改终态）。
        await cancelDoseReminders(tx, "occurrence_id = ANY($1::uuid[])", [supersededIds]);
      }
      return { conflict: false as const, version: updated.rows[0].version };
    });
    if (result.conflict) return reply.code(409).send(errorBody("VERSION_CONFLICT", "计划已被他人修改，请刷新后重试"));
    return {
      planId: loaded.plan.id,
      version: result.version,
      timeSlots: [...next.timeSlots].sort(),
      note: "修改只影响之后的安排，已有服药记录保持不变",
    };
  });

  app.get<{ Params: { planId: string }; Querystring: { limit?: string } }>("/api/v1/medication-plans/:planId/history", async (request, reply) => {
    const loaded = await loadPlanContext(request, reply);
    if (loaded === null) return;
    if (!loaded.access.canView) return reply.code(403).send(errorBody("FORBIDDEN", "没有查看该计划记录的权限"));
    const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 200);
    const occurrences = await database.query<{ id: string; dose_date: string; time_of_day: string; status: string; medicine_name_snapshot: string | null; dosage_text_snapshot: string | null; time_snapshot: string | null; superseded_at: string | null }>(
      `SELECT id, dose_date::text AS dose_date, time_of_day::text AS time_of_day, status,
              medicine_name_snapshot, dosage_text_snapshot, superseded_at::text AS superseded_at
       FROM dose_occurrences WHERE plan_id = $1 ORDER BY dose_date DESC, time_of_day DESC LIMIT $2`,
      [loaded.plan.id, limit],
    );
    const history = [];
    for (const occurrence of occurrences.rows) {
      const events = await database.query<{ action: "taken" | "skipped"; actor: string | null; created_at: string }>(
        `SELECT c.action, u.nickname AS actor, to_char(c.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') AS created_at
         FROM dose_confirmations c LEFT JOIN users u ON u.id = c.acted_by
         WHERE c.occurrence_id = $1 ORDER BY c.created_at`,
        [occurrence.id],
      );
      history.push({
        occurrenceId: occurrence.id,
        date: occurrence.dose_date,
        time: occurrence.time_of_day.slice(0, 5),
        status: occurrence.status,
        // B08：有快照用快照；无快照的旧历史标注信息不完整。
        medicineName: occurrence.medicine_name_snapshot ?? loaded.plan.medicine_name,
        dosageText: occurrence.dosage_text_snapshot ?? loaded.plan.dosage_text,
        snapshotComplete: occurrence.medicine_name_snapshot !== null,
        // B06：被系统改期作废的实例与用户主动"跳过"区分展示。
        superseded: occurrence.superseded_at !== null,
        // 纠正以新事件追加：events 长度大于 1 说明这条记录被改过。
        corrected: events.rows.length > 1,
        events: events.rows.map((event) => ({ action: event.action, actor: event.actor, at: event.created_at })),
      });
    }
    return { planId: loaded.plan.id, medicineName: loaded.plan.medicine_name, history };
  });

  // —— 今日安排（按需物化） ——

  app.get<{ Querystring: { date?: string } }>("/api/v1/medication-plans/schedule", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    if (request.query.date !== undefined && !isValidCalendarDate(request.query.date)) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "date 需为真实日期 YYYY-MM-DD"));
    }
    const date = typeof request.query.date === "string" && DATE_PATTERN.test(request.query.date) ? request.query.date : shanghaiToday();
    const weekday = weekdayOf(date);
    const isPast = date < shanghaiToday();
    const entries: Array<Record<string, unknown>> = [];

    {
      // R03/B08：过去日期只读历史——直接按已物化实例投影，不重新物化，
      // 且不受当前计划状态/星期/起止影响（暂停、结束、改范围都不会抹掉历史入口）。
      // 仍按当前照护权限鉴权；显示实例快照（旧数据无快照时回退当前计划并标注不完整）。
      const past = await database.query<{
        id: string; plan_id: string; care_profile_id: string; time_of_day: string;
        status: "pending" | "taken" | "skipped";
        medicine_name_snapshot: string | null; dosage_text_snapshot: string | null; care_profile_name_snapshot: string | null;
        medicine_name: string; dosage_text: string;
        display_name: string; linked_user_id: string | null; created_by: string;
      }>(
        `SELECT o.id, o.plan_id, o.care_profile_id, o.time_of_day::text AS time_of_day, o.status,
                o.medicine_name_snapshot, o.dosage_text_snapshot, o.care_profile_name_snapshot,
                p.medicine_name, p.dosage_text,
                c.display_name, c.linked_user_id, COALESCE(c.managed_by,c.created_by) AS created_by
         FROM dose_occurrences o
         JOIN medication_plans p ON p.id = o.plan_id
         JOIN care_profiles c ON c.id = o.care_profile_id
         WHERE o.family_id = $1 AND o.dose_date = $2 AND o.superseded_at IS NULL AND c.archived_at IS NULL
           AND ($3 OR o.status IN ('taken', 'skipped'))
         ORDER BY o.time_of_day`,
        [ctx.familyId, date, isPast],
      );
      for (const row of past.rows) {
        const profile: CareProfileRow = { id: row.care_profile_id, display_name: row.display_name, linked_user_id: row.linked_user_id, created_by: row.created_by };
        const access = await accessFor(database, profile, ctx.userId);
        if (!access.canView) continue;
        const complete = row.medicine_name_snapshot !== null;
        entries.push({
          occurrenceId: row.id,
          planId: row.plan_id,
          careProfileId: row.care_profile_id,
          careProfileName: row.care_profile_name_snapshot ?? row.display_name,
          medicineName: row.medicine_name_snapshot ?? row.medicine_name,
          dosageText: row.dosage_text_snapshot ?? row.dosage_text,
          time: row.time_of_day.slice(0, 5),
          status: row.status,
          snapshotComplete: complete,
          receiveDoseReminders: await receivesAndroidDose(database, profile, ctx.userId),
        });
      }
      entries.sort((left, right) => String(left.time).localeCompare(String(right.time)));
      if (isPast) return { date, entries };
    }

    const candidates = await database.query<PlanRow & { display_name: string; linked_user_id: string | null; created_by: string }>(
      `SELECT p.id, p.care_profile_id, p.medicine_id, p.medicine_name, p.dosage_text, p.weekdays,
              p.start_date::text AS start_date, p.end_date::text AS end_date, p.status, p.version,
              c.display_name, c.linked_user_id, COALESCE(c.managed_by,c.created_by) AS created_by
       FROM medication_plans p JOIN care_profiles c ON c.id = p.care_profile_id
       WHERE p.family_id = $1 AND p.status = 'active' AND c.archived_at IS NULL
         AND p.start_date <= $2 AND (p.end_date IS NULL OR p.end_date >= $2)`,
      [ctx.familyId, date],
    );

    for (const plan of candidates.rows) {
      const weekdays = plan.weekdays ?? [];
      if (!weekdays.includes(weekday)) continue;
      const profile: CareProfileRow = { id: plan.care_profile_id, display_name: plan.display_name, linked_user_id: plan.linked_user_id, created_by: plan.created_by };
      const access = await accessFor(database, profile, ctx.userId);
      if (!access.canView) continue;
      const slots = await loadSlots(database, plan.id);
      for (const slot of slots) {
        // B09/R01：懒物化与调度器共用同一并发安全入口——冲突目标为"活动实例"部分唯一索引，
        // 作废行让位，改期后同一时间点可重新物化；冲突后回读实例快照（R04：今日 taken 显示原快照）。
        const materialized = await database.query<{ id: string; status: "pending" | "taken" | "skipped"; medicine_name_snapshot: string | null; dosage_text_snapshot: string | null; care_profile_name_snapshot: string | null }>(
          `INSERT INTO dose_occurrences (family_id, plan_id, slot_id, care_profile_id, dose_date, time_of_day,
                                         medicine_name_snapshot, dosage_text_snapshot, care_profile_name_snapshot, plan_version_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6::time, $7, $8, $9, $10)
           ON CONFLICT (slot_id, dose_date) WHERE superseded_at IS NULL DO NOTHING
           RETURNING id, status, medicine_name_snapshot, dosage_text_snapshot, care_profile_name_snapshot`,
          [ctx.familyId, plan.id, slot.id, plan.care_profile_id, date, slot.time,
            plan.medicine_name, plan.dosage_text, plan.display_name, plan.version],
        );
        const existing = materialized.rows[0] ??
          (await database.query<{ id: string; status: "pending" | "taken" | "skipped"; medicine_name_snapshot: string | null; dosage_text_snapshot: string | null; care_profile_name_snapshot: string | null }>(
            `SELECT id, status, medicine_name_snapshot, dosage_text_snapshot, care_profile_name_snapshot
             FROM dose_occurrences WHERE slot_id = $1 AND dose_date = $2 AND superseded_at IS NULL`,
            [slot.id, date],
          )).rows[0];
        if (existing === undefined || entries.some((entry) => entry.occurrenceId === existing.id)) continue;
        const complete = existing.medicine_name_snapshot !== null;
        entries.push({
          occurrenceId: existing.id,
          planId: plan.id,
          careProfileId: plan.care_profile_id,
          careProfileName: existing.care_profile_name_snapshot ?? plan.display_name,
          medicineName: existing.medicine_name_snapshot ?? plan.medicine_name,
          dosageText: existing.dosage_text_snapshot ?? plan.dosage_text,
          time: slot.time,
          status: existing.status,
          snapshotComplete: complete,
          receiveDoseReminders: await receivesAndroidDose(database, profile, ctx.userId),
        });
      }
    }
    entries.sort((left, right) => String(left.time).localeCompare(String(right.time)));
    return { date, entries };
  });

  // —— 确认（幂等 + 纠正留痕） ——

  app.post<{ Params: { occurrenceId: string } }>("/api/v1/dose-occurrences/:occurrenceId/confirm", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const body = request.body as Record<string, unknown> | null;
    const action = body?.action === "taken" || body?.action === "skipped" ? body.action : null;
    const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    if (action === null) return reply.code(400).send(errorBody("VALIDATION_ERROR", "action 必须是 taken 或 skipped"));
    if (idempotencyKey === "" || idempotencyKey.length > 120) return reply.code(400).send(errorBody("VALIDATION_ERROR", "idempotencyKey 必填（客户端为该次操作生成的唯一键）"));

    const result = await database.withTransaction(async (tx: Pick<Database, "query">) => {
      const occurrence = (await tx.query<{ id: string; status: "pending" | "taken" | "skipped"; care_profile_id: string; superseded_at: string | null }>(
        `SELECT o.id, o.status, o.care_profile_id, o.superseded_at::text AS superseded_at FROM dose_occurrences o
         WHERE o.id = $1 AND o.family_id = $2 FOR UPDATE`,
        [request.params.occurrenceId, ctx.familyId],
      )).rows[0];
      if (occurrence === undefined) return { error: "not_found" as const };
      const profile = await loadProfile(tx, ctx.familyId, occurrence.care_profile_id);
      if (profile === null) return { error: "not_found" as const };
      const access = await accessFor(tx, profile, ctx.userId);
      if (!access.canView) return { error: "forbidden" as const };

      // 幂等：同一键重试直接返回既有结果，不追加事件（作废实例的历史重放同样允许）。
      const replay = (await tx.query<{ status: "pending" | "taken" | "skipped" }>(
        "SELECT 1 AS hit FROM dose_confirmations WHERE occurrence_id = $1 AND idempotency_key = $2",
        [occurrence.id, idempotencyKey],
      ));
      if ((replay.rowCount ?? 0) > 0) return { status: occurrence.status, replayed: true };
      // R02：被系统改期作废的实例不能再产生新确认；旧列表/乱序响应撞到这里应刷新。
      if (occurrence.superseded_at !== null) return { error: "superseded" as const };
      await tx.query(
        "INSERT INTO dose_confirmations (family_id, occurrence_id, action, acted_by, idempotency_key) VALUES ($1, $2, $3, $4, $5)",
        [ctx.familyId, occurrence.id, action, ctx.userId, idempotencyKey],
      );
      await tx.query("UPDATE dose_occurrences SET status = $2 WHERE id = $1", [occurrence.id, action]);
      return { status: action, replayed: false };
    });

    if (result.error === "not_found") return reply.code(404).send(errorBody("NOT_FOUND", "服药安排不存在"));
    if (result.error === "forbidden") return reply.code(403).send(errorBody("FORBIDDEN", "没有确认该服药安排的权限"));
    if (result.error === "superseded") return reply.code(409).send(errorBody("OCCURRENCE_SUPERSEDED", "该安排已因计划调整失效，请刷新后按最新安排确认"));
    // 已确认就不需要再提醒：取消排队中的消息，避免"确认后仍收到提醒"。
    if (!result.replayed) {
      await cancelDoseRemindersForOccurrence(database, request.params.occurrenceId);
    }
    return { occurrenceId: request.params.occurrenceId, status: result.status, replayed: result.replayed };
  });

  // —— 服药提醒状态（R4）：页面如实展示模板可用性与最近发送结果 ——

  app.get("/api/v1/medication-plans/reminders/status", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const available = templateConfig?.doseAvailable ?? false;
    const rows = await database.query<{ dose_date: string; time_of_day: string; status: string; sent_at: string | null }>(
      `SELECT dose_date::text AS dose_date, time_of_day::text AS time_of_day, status,
              to_char(sent_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') AS sent_at
       FROM dose_reminder_deliveries
       WHERE family_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT 20`,
      [ctx.familyId, ctx.userId],
    );
    const labels: Record<string, string> = {
      queued: "等待发送", sending: "发送中", sent: "已发送",
      failed: "发送失败", blocked: "已拦截", cancelled: "已取消",
    };
    return {
      available,
      reason: available ? null : "服药提醒模板尚未在药箱专用账号下配置；计划与今日安排仍可正常使用",
      templateId: templateConfig?.doseTemplateId ?? "",
      deliveries: rows.rows.map((row) => ({
        date: row.dose_date,
        time: row.time_of_day.slice(0, 5),
        status: row.status,
        statusLabel: labels[row.status] ?? row.status,
        sentAt: row.sent_at,
      })),
    };
  });
}
