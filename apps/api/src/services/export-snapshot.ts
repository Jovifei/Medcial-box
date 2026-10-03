import { randomUUID } from "node:crypto";
import type { Database } from "../types.js";
import { listMedicines, toMedicineSummary } from "../repositories/medicines.js";
import { listBatchesByFamily, toBatchSummary } from "../repositories/batches.js";
import { listVisibleNotes } from "../repositories/notes.js";
import type { ExportMedicine, MarkdownExportOptions } from "./markdown-export.js";

export interface InventoryExportSnapshot {
 snapshotId: string;
 generatedAt: string;
 expiresAt: string;
 options: MarkdownExportOptions;
 medicines: ExportMedicine[];
}

function freeze<T>(value: T): T {
 if (typeof value === "object" && value !== null) {
  Object.values(value).forEach(freeze);
  Object.freeze(value);
 }
 return value;
}

/** Ephemeral private snapshots are bounded, identity-bound, and never persisted. */
export class ExportSnapshotStore {
 private readonly entries = new Map<string, { userId: string; familyId: string; snapshot: InventoryExportSnapshot }>();
 constructor(private readonly clock: () => number = Date.now, private readonly maximum = 128) {
  if (!Number.isInteger(maximum) || maximum < 1) throw new RangeError("Snapshot capacity must be a positive integer");
 }
 clear(): void { this.entries.clear(); }
 private prune(): void {
  for (const [id, entry] of this.entries) if (Date.parse(entry.snapshot.expiresAt) <= this.clock()) this.entries.delete(id);
 }
 put(userId: string, familyId: string, medicines: ExportMedicine[], options: MarkdownExportOptions): InventoryExportSnapshot {
  this.prune();
  while (this.entries.size >= this.maximum) this.entries.delete(this.entries.keys().next().value as string);
  const now = this.clock();
  const snapshot = freeze(structuredClone({ snapshotId: randomUUID(), generatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(), options, medicines }));
  this.entries.set(snapshot.snapshotId, { userId, familyId, snapshot });
  return snapshot;
 }
 get(id: string, userId: string, familyId: string): InventoryExportSnapshot | null {
  this.prune();
  const entry = this.entries.get(id);
  return entry?.userId === userId && entry.familyId === familyId ? entry.snapshot : null;
 }
}

export async function readInventoryExportSnapshot(database: Database, userId: string, familyId: string, options: MarkdownExportOptions, now = new Date()): Promise<ExportMedicine[] | null> {
 return database.withTransaction(async (tx) => {
  await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const membership = await tx.query("SELECT id FROM family_members WHERE user_id=$1 AND family_id=$2", [userId, familyId]);
  if (membership.rowCount === 0) return null;
  const rows = await listMedicines(tx, familyId, options.includeArchived);
  const batches = await listBatchesByFamily(tx, familyId);
  const medicines: ExportMedicine[] = [];
  for (const row of rows) {
   const summary: ExportMedicine = toMedicineSummary(row, batches.filter((batch) => batch.medicine_id === row.id).map((batch) => toBatchSummary(batch, now)), now);
   if (options.includePersonalDosage) summary.dosageNotes = (await listVisibleNotes(tx, row.id, familyId, userId)).map((note) => ({ userId: note.user_id, isMine: note.user_id === userId, content: note.content }));
   // Omitting locations is a property of the frozen data, not just rendering.
   if (!options.includeStorageLocation) summary.batches = summary.batches.map((batch) => ({ ...batch, storageLocation: null }));
   medicines.push(summary);
  }
  return medicines;
 });
}
