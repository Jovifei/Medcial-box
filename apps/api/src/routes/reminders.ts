import type { FastifyInstance } from "fastify";
import type {
  PendingReminderItem,
  WechatReminderSubscribeRequest,
  WechatReminderSubscribeResponse,
  WechatReminderTemplatesResponse,
} from "@home-medicine/contracts";
import { requireFamily } from "../auth/session.js";
import { cancelDoseReminders } from "../jobs/dose-reminder-scheduler.js";
import { createRateLimiter } from "../rate-limit.js";
import { listMedicines } from "../repositories/medicines.js";
import type { Database } from "../types.js";
import { errorBody } from "../types.js";
import { buildFamilyMedicineSummaries } from "./medicines.js";
import type { ReminderTemplateConfig } from "../services/subscribe-messages.js";

function priority(item: PendingReminderItem): number {
  switch (item.type) {
    case "expired": return 0;
    case "expiry_due": return 1;
    case "low_stock": return 2;
    case "stocktake_due": return 3;
    case "needs_check": return 4;
    case "leaflet_missing": return 5;
  }
}

function addCalendarMonth(dateValue: string | Date): Date {
  const date = new Date(dateValue);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date;
}

export async function registerReminderRoutes(
  app: FastifyInstance,
  database: Database,
  templateConfig: ReminderTemplateConfig,
): Promise<void> {
  const limitByUser = createRateLimiter({ windowMs: 60_000, maxRequests: 12 });

  app.get("/api/v1/notification-preferences", async (request, reply) => {
    const context = requireFamily(request, reply);
    if (context === null) return;
    const row = (await database.query<{ stock_reminder_time: string; channels: Array<"wechat" | "android"> }>(
      "SELECT stock_reminder_time::text, channels FROM notification_preferences WHERE user_id = $1", [context.userId],
    )).rows[0];
    return { preferences: { stockReminderTime: row?.stock_reminder_time.slice(0, 5) ?? "09:00", timezone: "Asia/Shanghai", channels: row?.channels ?? [] } };
  });
  app.put("/api/v1/notification-preferences", async (request, reply) => {
    const context = requireFamily(request, reply);
    if (context === null) return;
    const body = request.body as Record<string, unknown> | null;
    const time = body?.stockReminderTime;
    const channels = body?.channels;
    if ((body?.timezone !== undefined && body.timezone !== "Asia/Shanghai") || typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !Array.isArray(channels) || channels.some((channel) => channel !== "wechat" && channel !== "android")) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "提醒时间或渠道不合法"));
    }
    const unique = [...new Set(channels)];
    await database.withTransaction(async (tx) => {
      await tx.query(`INSERT INTO notification_preferences (user_id, stock_reminder_time, channels)
        VALUES ($1, $2::time, $3::text[]) ON CONFLICT (user_id) DO UPDATE SET stock_reminder_time=EXCLUDED.stock_reminder_time, channels=EXCLUDED.channels`, [context.userId, time, unique]);
      if (!unique.includes("wechat")) {
        // Stop queued dose jobs atomically with opting out. A job queued by an
        // overlapping scheduler is also checked at the guarded send boundary.
        await cancelDoseReminders(tx, "user_id = $1", [context.userId]);
      }
    });
    return { preferences: { stockReminderTime: time, timezone: "Asia/Shanghai", channels: unique } };
  });

  app.get("/api/v1/notifications/templates", async (request, reply) => {
    const context = requireFamily(request, reply);
    if (context === null) return;
    const response: WechatReminderTemplatesResponse = {
      available: templateConfig.available,
      templates: templateConfig.templates,
      ...(!templateConfig.available ? { reason: templateConfig.reason ?? "微信订阅模板尚未配置" } : {}),
    };
    return response;
  });

  app.post("/api/v1/notifications/subscribe", async (request, reply) => {
    const context = requireFamily(request, reply);
    if (context === null) return;
    if (!limitByUser(context.userId)) {
      return reply.code(429).send(errorBody("RATE_LIMITED", "订阅请求过于频繁，请稍后重试"));
    }
    if (!templateConfig.available) {
      return reply.code(503).send(errorBody("NOTIFICATION_UNAVAILABLE", templateConfig.reason ?? "微信订阅模板尚未配置"));
    }
    const body = request.body as Partial<WechatReminderSubscribeRequest> | null;
    const acceptedTemplateIds: unknown = body?.acceptedTemplateIds;
    if (!Array.isArray(acceptedTemplateIds) || acceptedTemplateIds.length > 3 ||
        acceptedTemplateIds.some((id: unknown) => typeof id !== "string" || !templateConfig.templates.some((item) => item.templateId === id))) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "订阅结果不合法"));
    }
    const templateIds = [...new Set(acceptedTemplateIds as string[])];
    await database.withTransaction(async (tx) => {
      if (templateIds.length > 0) {
        await tx.query(`INSERT INTO notification_preferences (user_id, channels) VALUES ($1, ARRAY['wechat']::text[])
          ON CONFLICT (user_id) DO UPDATE SET channels = ARRAY(SELECT DISTINCT unnest(notification_preferences.channels || ARRAY['wechat']::text[]))`, [context.userId]);
      }
      for (const templateId of templateIds) {
        await tx.query(
          "INSERT INTO wechat_subscription_grants (family_id, user_id, template_id) VALUES ($1, $2, $3)",
          [context.familyId, context.userId, templateId],
        );
      }
    });
    const response: WechatReminderSubscribeResponse = { acceptedTemplateIds: templateIds };
    return response;
  });

  app.get("/api/v1/notifications/pending", async (request, reply) => {
    const context = requireFamily(request, reply);
    if (context === null) return;
    const now = new Date();
    const rows = await listMedicines(database, context.familyId, false);
    const medicines = await buildFamilyMedicineSummaries(database, context.familyId, rows, now);
    const items: PendingReminderItem[] = [];
    for (const medicine of medicines) {
      for (const batch of medicine.batches) {
        if (batch.dispositionStatus === "handled") continue;
        const state = batch.managementExpiryState ?? batch.expiryState;
        if (state.state === "expired") {
          items.push({
            id: `expired:${batch.id}`, type: "expired", medicineId: medicine.id, batchId: batch.id,
            medicineName: medicine.name,
            message: `批次已过期（${batch.managementExpiryDate ?? batch.expiry.value ?? "日期待核对"}），请核对并处理。`,
            dueDate: batch.managementExpiryDate ?? batch.expiry.value, action: "edit_batch",
          });
        } else if (state.state === "expiring_soon" || state.state === "due_this_month") {
          items.push({
            id: `expiry:${batch.id}`, type: "expiry_due", medicineId: medicine.id, batchId: batch.id,
            medicineName: medicine.name,
            message: `批次临近有效期（${batch.managementExpiryDate ?? batch.expiry.value ?? "日期待核对"}）。`,
            dueDate: batch.managementExpiryDate ?? batch.expiry.value, action: "edit_batch",
          });
        } else if (state.state === "unknown" || (batch.openedState === "opened" && batch.openedExpiryDate == null)) {
          items.push({
            id: `check:${batch.id}`, type: "needs_check", medicineId: medicine.id, batchId: batch.id,
            medicineName: medicine.name,
            message: batch.openedState === "opened" && batch.openedAt === null
              ? "已标记开封，但开封日期未记录。"
              : "有效期或开封期限待核对。",
            dueDate: null, action: "edit_batch",
          });
        }
      }
      if (medicine.stockStatus?.state === "low" || medicine.stockStatus?.state === "exhausted") {
        const exhausted = medicine.stockStatus.state === "exhausted";
        items.push({
          id: `stock:${medicine.id}`, type: "low_stock", medicineId: medicine.id, batchId: null,
          medicineName: medicine.name,
          message: exhausted
            ? `库存已耗尽（0${medicine.stockStatus.unit}），请补货。`
            : `库存 ${medicine.stockStatus.quantity}${medicine.stockStatus.unit} 已达到补货阈值。`,
          dueDate: null, action: "restock",
        });
      } else if (medicine.stockStatus?.state === "unknown" && medicine.lowStockThreshold != null) {
        items.push({
          id: `check-stock:${medicine.id}`, type: "needs_check", medicineId: medicine.id, batchId: null,
          medicineName: medicine.name, message: "数量未知或单位不能安全换算，请先盘点库存。",
          dueDate: null, action: "stocktake",
        });
      }
      const medicineInfoMissing =
        medicine.specification === null ||
        medicine.manufacturer === null ||
        medicine.activeIngredients.length === 0 ||
        medicine.leaflet.reviewStatus === "unverified";
      if (medicineInfoMissing) {
        items.push({
          id: `leaflet:${medicine.id}`, type: "leaflet_missing", medicineId: medicine.id, batchId: null,
          medicineName: medicine.name,
          message: medicine.leaflet.reviewStatus === "unverified"
            ? "说明书资料尚未核对。"
            : "规格、厂家或成分资料待补充。",
          dueDate: null, action: "review_leaflet",
        });
      }
    }
    const settings = await database.query<{ stocktake_interval: string; reference_at: Date | string | null }>(
      `SELECT COALESCE(s.stocktake_interval, 'monthly') AS stocktake_interval,
              COALESCE(s.last_stocktake_at, f.created_at) AS reference_at
       FROM families f LEFT JOIN family_inventory_settings s ON s.family_id = f.id
       WHERE f.id = $1`,
      [context.familyId],
    );
    const setting = settings.rows[0];
    if (setting && setting.stocktake_interval !== "disabled" && setting.reference_at !== null) {
      const next = new Date(setting.reference_at);
      if (setting.stocktake_interval === "weekly") next.setUTCDate(next.getUTCDate() + 7);
      else next.setTime(addCalendarMonth(setting.reference_at).getTime());
      if (next.getTime() <= now.getTime()) {
        items.push({
          id: "stocktake:due", type: "stocktake_due", medicineId: null, batchId: null,
          medicineName: "家庭药箱", message: "已到盘点时间。", dueDate: next.toISOString(), action: "stocktake",
        });
      }
    }
    items.sort((left, right) => priority(left) - priority(right) || (left.dueDate ?? "9999").localeCompare(right.dueDate ?? "9999"));
    return { items };
  });
}
