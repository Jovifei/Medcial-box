import type { Database } from "../types.js";
import { PrivatePhotoStore } from "../services/private-photo-store.js";

const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;

interface CandidateRow {
  id: string;
  family_id: string;
  medicine_id: string;
  storage_key: string;
}

/** Remove private leaflet files only after their parent medicine has left its 30-day recovery window. */
export async function cleanupExpiredTrashedMedicinePhotos(
  database: Database,
  store: PrivatePhotoStore,
  now = new Date(),
): Promise<number> {
  const expiredBefore = new Date(now.getTime() - RECOVERY_WINDOW_MS);
  const candidates = await database.query<CandidateRow>(
    `SELECT p.id, p.family_id, p.medicine_id, p.storage_key
     FROM medicine_leaflet_photos p
     JOIN medicines m ON m.id = p.medicine_id AND m.family_id = p.family_id
     WHERE p.storage_removed_at IS NULL AND m.deleted_at <= $1
     ORDER BY m.deleted_at, p.id
     LIMIT $2`,
    [expiredBefore, CLEANUP_BATCH_SIZE],
  );

  let cleaned = 0;
  for (const candidate of candidates.rows) {
    const eligible = await database.withTransaction(async (tx) => {
      const family = await tx.query<{ id: string }>(
        "SELECT id FROM families WHERE id = $1 FOR UPDATE",
        [candidate.family_id],
      );
      if (family.rowCount === 0) return false;
      const medicine = await tx.query<{ id: string; deleted_at: Date | string | null }>(
        "SELECT id, deleted_at FROM medicines WHERE id = $1 AND family_id = $2 FOR UPDATE",
        [candidate.medicine_id, candidate.family_id],
      );
      const row = medicine.rows[0];
      if (row?.deleted_at == null || new Date(row.deleted_at).getTime() > expiredBefore.getTime()) return false;
      const marked = await tx.query<{ id: string }>(
        `UPDATE medicine_leaflet_photos SET deleted_at = COALESCE(deleted_at, now())
         WHERE id = $1 AND family_id = $2 AND medicine_id = $3 AND storage_removed_at IS NULL
         RETURNING id`,
        [candidate.id, candidate.family_id, candidate.medicine_id],
      );
      return marked.rowCount !== 0;
    });
    if (!eligible) continue;

    // The DB row is already hidden. If file removal or quota-marker commit fails,
    // storage_removed_at stays null and the normal pending-cleanup path can retry.
    try {
      await store.remove(candidate.storage_key);
      await database.withTransaction(async (tx) => {
        await tx.query("SELECT id FROM families WHERE id = $1 FOR UPDATE", [candidate.family_id]);
        await tx.query(
          `UPDATE medicine_leaflet_photos SET storage_removed_at = now()
           WHERE id = $1 AND family_id = $2 AND storage_removed_at IS NULL AND deleted_at IS NOT NULL`,
          [candidate.id, candidate.family_id],
        );
      });
      cleaned += 1;
    } catch {
      // Keep quota charged; a future sweep or upload retries the idempotent removal.
    }
  }
  return cleaned;
}

export function startLeafletPhotoCleanup(
  database: Database,
  store: PrivatePhotoStore,
  onError: (message: string) => void = () => undefined,
  intervalMs = 6 * 60 * 60 * 1000,
): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupExpiredTrashedMedicinePhotos(database, store);
    } catch {
      onError("Expired private leaflet photo cleanup failed; quota remains reserved.");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
