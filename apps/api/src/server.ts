import { buildServer } from "./app.js";
import { createDatabaseAdapter, createDatabasePool } from "./db.js";
import { applyMigrations } from "./db/migrations.js";
import { createDefaultReminderTemplateConfig, WechatSubscribeMessageSender } from "./services/subscribe-messages.js";
import { startReminderScheduler } from "./jobs/reminder-scheduler.js";
import { startDoseReminderScheduler } from "./jobs/dose-reminder-scheduler.js";
import { startLeafletPhotoCleanup } from "./jobs/leaflet-photo-cleanup.js";
import { PrivatePhotoStore } from "./services/private-photo-store.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !process.env.PGHOST) {
    throw new Error("Configure DATABASE_URL or the PGHOST/PGUSER/PGPASSWORD/PGDATABASE variables.");
  }

  const pool = createDatabasePool(databaseUrl);
  try {
    await applyMigrations(pool);
    const database = createDatabaseAdapter(pool);
    const reminderConfig = createDefaultReminderTemplateConfig();
    const reminderSender = new WechatSubscribeMessageSender(reminderConfig);
    const privatePhotoStore = new PrivatePhotoStore();
    const app = await buildServer({ database, reminderTemplateConfig: reminderConfig, privatePhotoStore });
    let stopReminderScheduler: (() => void) | null = null;
    let stopDoseReminderScheduler: (() => void) | null = null;
    let stopLeafletPhotoCleanup: (() => void) | null = null;
    app.addHook("onClose", async () => {
      stopReminderScheduler?.();
      stopDoseReminderScheduler?.();
      stopLeafletPhotoCleanup?.();
      await pool.end();
    });
    const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
    // Local development defaults to loopback; containers set API_HOST=0.0.0.0.
    const host = process.env.API_HOST ?? "127.0.0.1";
    await app.listen({ host, port });
    stopReminderScheduler = startReminderScheduler(database, reminderSender, reminderConfig, {
      warn: (message) => app.log.warn(message),
    });
    stopDoseReminderScheduler = startDoseReminderScheduler(database, reminderSender, reminderConfig, {
      warn: (message) => app.log.warn(message),
    });
    stopLeafletPhotoCleanup = startLeafletPhotoCleanup(database, privatePhotoStore, (message) => app.log.warn(message));
  } catch (error) {
    await pool.end();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error("API startup failed", error);
  process.exitCode = 1;
});
