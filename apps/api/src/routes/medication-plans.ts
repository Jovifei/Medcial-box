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

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

async function loadProfile(database: Pick<Database, "query">, familyId: string, profileId: string): Promise<CareProfileRow | null> {
  const rows = await database.query<CareProfileRow>(
    "SELECT id, display_name, linked_user_id, created_by FROM care_profiles WHERE id = $1 AND family_id = $2",
    [profileId, familyId],
  );
  return rows.rows[0] ?? null;
}

/** 上海时区的"今天"（与提醒调度同一时区语义）。 */
function shanghaiToday(): string {
  const shanghai = new Date(Date.now() + 8 * 3600 * 1000);
  return shanghai.toISOString().slice(0, 10);
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

  app.get("/api/v1/care-profiles", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const rows = await database.query<CareProfileRow>(
      "SELECT id, display_name, linked_user_id, created_by FROM care_profiles WHERE family_id = $1 ORDER BY created_at",
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
    if (memberUserId === "") return reply.code(400).send(errorBody("VALIDATION_ERROR", "memberUserId 必填"));
    if (memberUserId === ctx.userId) return reply.code(400).send(errorBody("VALIDATION_ERROR", "不需要给自己授权"));
    const member = await database.query<{ id: string }>(
      "SELECT id FROM family_members WHERE user_id = $1 AND family_id = $2",
      [memberUserId, ctx.familyId],
    );
    if (member.rowCount === 0) return reply.code(404).send(errorBody("NOT_FOUND", "成员不存在或不在当前家庭"));
    // 授权他人查看/管理：can_view 恒为 true（canManage 蕴含查看）。
    await database.query(
      `INSERT INTO care_grants (family_id, care_profile_id, member_user_id, can_view, can_manage, created_by)
       VALUES ($1, $2, $3, true, $4, $5)
       ON CONFLICT (care_profile_id, member_user_id)
       DO UPDATE SET can_view = true, can_manage = EXCLUDED.can_manage, created_by = EXCLUDED.created_by`,
      [ctx.familyId, profile.id, memberUserId, canManage, ctx.userId],
    );
    return { careProfileId: profile.id, memberUserId, canManage };
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
    if (!DATE_PATTERN.test(startDate)) return reply.code(400).send(errorBody("VALIDATION_ERROR", "startDate 需为 YYYY-MM-DD"));
    if (rawEndDate !== "" && !DATE_PATTERN.test(rawEndDate)) return reply.code(400).send(errorBody("VALIDATION_ERROR", "endDate 需为 YYYY-MM-DD"));
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

  app.get("/api/v1/medication-plans", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const plans = await database.query<PlanRow & { display_name: string; linked_user_id: string | null; created_by: string }>(
      `SELECT p.id, p.care_profile_id, p.medicine_id, p.medicine_name, p.dosage_text, p.weekdays,
              p.start_date::text AS start_date, p.end_date::text AS end_date, p.status, p.version,
              c.display_name, c.linked_user_id, c.created_by
       FROM medication_plans p JOIN care_profiles c ON c.id = p.care_profile_id
       WHERE p.family_id = $1 AND p.status <> 'ended'
       ORDER BY p.created_at`,
      [ctx.familyId],
    );
    const visible = [];
    for (const plan of plans.rows) {
      const profile: CareProfileRow = { id: plan.care_profile_id, display_name: plan.display_name, linked_user_id: plan.linked_user_id, created_by: plan.created_by };
      const access = await accessFor(database, profile, ctx.userId);
      if (!access.canView) continue;
      const slots = await database.query<{ time_of_day: string }>(
        "SELECT time_of_day::text AS time_of_day FROM plan_time_slots WHERE plan_id = $1 ORDER BY time_of_day",
        [plan.id],
      );
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
        timeSlots: slots.rows.map((row) => row.time_of_day.slice(0, 5)),
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
              c.display_name, c.linked_user_id, c.created_by
       FROM medication_plans p JOIN care_profiles c ON c.id = p.care_profile_id
       WHERE p.id = $1 AND p.family_id = $2`,
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
    return { planId: plan.id, status: nextStatus, version: updated.rows[0].version };
  }

  // —— 今日安排（按需物化） ——

  app.get<{ Querystring: { date?: string } }>("/api/v1/medication-plans/schedule", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const date = typeof request.query.date === "string" && DATE_PATTERN.test(request.query.date) ? request.query.date : shanghaiToday();
    const weekday = weekdayOf(date);

    const candidates = await database.query<PlanRow & { display_name: string; linked_user_id: string | null; created_by: string }>(
      `SELECT p.id, p.care_profile_id, p.medicine_id, p.medicine_name, p.dosage_text, p.weekdays,
              p.start_date::text AS start_date, p.end_date::text AS end_date, p.status, p.version,
              c.display_name, c.linked_user_id, c.created_by
       FROM medication_plans p JOIN care_profiles c ON c.id = p.care_profile_id
       WHERE p.family_id = $1 AND p.status = 'active'
         AND p.start_date <= $2 AND (p.end_date IS NULL OR p.end_date >= $2)`,
      [ctx.familyId, date],
    );

    const entries: Array<Record<string, unknown>> = [];
    for (const plan of candidates.rows) {
      const weekdays = plan.weekdays ?? [];
      if (!weekdays.includes(weekday)) continue;
      const profile: CareProfileRow = { id: plan.care_profile_id, display_name: plan.display_name, linked_user_id: plan.linked_user_id, created_by: plan.created_by };
      const access = await accessFor(database, profile, ctx.userId);
      if (!access.canView) continue;
      const slots = await database.query<{ id: string; time_of_day: string }>(
        "SELECT id, time_of_day::text AS time_of_day FROM plan_time_slots WHERE plan_id = $1 ORDER BY time_of_day",
        [plan.id],
      );
      for (const slot of slots.rows) {
        // 懒物化：该计划×时间点在当天首次被查看时生成 pending 实例。
        const materialized = await database.query<{ id: string; status: "pending" | "taken" | "skipped" }>(
          `INSERT INTO dose_occurrences (family_id, plan_id, slot_id, care_profile_id, dose_date, time_of_day)
           SELECT $1, $2, $3, $4, $5, $6::time
           WHERE NOT EXISTS (SELECT 1 FROM dose_occurrences WHERE slot_id = $3 AND dose_date = $5)
           RETURNING id, status`,
          [ctx.familyId, plan.id, slot.id, plan.care_profile_id, date, slot.time_of_day],
        );
        const existing = materialized.rows[0] ??
          (await database.query<{ id: string; status: "pending" | "taken" | "skipped" }>(
            "SELECT id, status FROM dose_occurrences WHERE slot_id = $1 AND dose_date = $2",
            [slot.id, date],
          )).rows[0];
        entries.push({
          occurrenceId: existing.id,
          planId: plan.id,
          careProfileId: plan.care_profile_id,
          careProfileName: plan.display_name,
          medicineName: plan.medicine_name,
          dosageText: plan.dosage_text,
          time: slot.time_of_day.slice(0, 5),
          status: existing.status,
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
      const occurrence = (await tx.query<{ id: string; status: "pending" | "taken" | "skipped"; care_profile_id: string }>(
        `SELECT o.id, o.status, o.care_profile_id FROM dose_occurrences o
         WHERE o.id = $1 AND o.family_id = $2 FOR UPDATE`,
        [request.params.occurrenceId, ctx.familyId],
      )).rows[0];
      if (occurrence === undefined) return { error: "not_found" as const };
      const profile = await loadProfile(tx, ctx.familyId, occurrence.care_profile_id);
      if (profile === null) return { error: "not_found" as const };
      const access = await accessFor(tx, profile, ctx.userId);
      if (!access.canView) return { error: "forbidden" as const };

      // 幂等：同一键重试直接返回既有结果，不追加事件。
      const replay = (await tx.query<{ status: "pending" | "taken" | "skipped" }>(
        "SELECT 1 AS hit FROM dose_confirmations WHERE occurrence_id = $1 AND idempotency_key = $2",
        [occurrence.id, idempotencyKey],
      ));
      if ((replay.rowCount ?? 0) > 0) return { status: occurrence.status, replayed: true };
      await tx.query(
        "INSERT INTO dose_confirmations (family_id, occurrence_id, action, acted_by, idempotency_key) VALUES ($1, $2, $3, $4, $5)",
        [ctx.familyId, occurrence.id, action, ctx.userId, idempotencyKey],
      );
      await tx.query("UPDATE dose_occurrences SET status = $2 WHERE id = $1", [occurrence.id, action]);
      return { status: action, replayed: false };
    });

    if (result.error === "not_found") return reply.code(404).send(errorBody("NOT_FOUND", "服药安排不存在"));
    if (result.error === "forbidden") return reply.code(403).send(errorBody("FORBIDDEN", "没有确认该服药安排的权限"));
    return { occurrenceId: request.params.occurrenceId, status: result.status, replayed: result.replayed };
  });
}
