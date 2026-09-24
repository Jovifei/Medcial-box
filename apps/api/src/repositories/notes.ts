// dosage_notes 表仓储：
// - 列表可见性：本人全部 + 他人 visibility='family'；
// - 编辑/删除仅限备注所属成员（SQL 绑定 user_id），他人的备注查不到 → 404。
import type {
  DosageNoteSummary,
  NoteVisibility,
} from "@home-medicine/contracts";
import type { Database } from "../types.js";

export interface DosageNoteRow {
  id: string;
  medicine_id: string;
  user_id: string;
  content: string;
  visibility: string;
  version: number;
}

const NOTE_COLUMNS = "id, medicine_id, user_id, content, visibility, version";

export function toNoteSummary(
  row: DosageNoteRow,
  viewerId: string,
): DosageNoteSummary {
  return {
    id: row.id,
    medicineId: row.medicine_id,
    userId: row.user_id,
    isMine: row.user_id === viewerId,
    content: row.content,
    visibility: row.visibility as NoteVisibility,
    version: row.version,
  };
}

export async function listVisibleNotes(
  database: Database,
  medicineId: string,
  familyId: string,
  viewerId: string,
): Promise<DosageNoteRow[]> {
  const result = await database.query<DosageNoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM dosage_notes WHERE medicine_id = $1 AND family_id = $2 AND (user_id = $3 OR visibility = 'family') ORDER BY created_at, id`,
    [medicineId, familyId, viewerId],
  );
  return result.rows;
}

/** Owned lookup only: another member's note (even family-visible) misses → 404. */
export async function findNoteOwned(
  database: Database,
  noteId: string,
  medicineId: string,
  familyId: string,
  userId: string,
): Promise<DosageNoteRow | null> {
  const result = await database.query<DosageNoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM dosage_notes WHERE id = $1 AND medicine_id = $2 AND family_id = $3 AND user_id = $4`,
    [noteId, medicineId, familyId, userId],
  );
  return result.rows[0] ?? null;
}

export async function insertNote(
  database: Database,
  familyId: string,
  medicineId: string,
  userId: string,
  content: string,
  visibility: NoteVisibility,
): Promise<DosageNoteRow> {
  const result = await database.query<DosageNoteRow>(
    `INSERT INTO dosage_notes (family_id, medicine_id, user_id, content, visibility, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${NOTE_COLUMNS}`,
    [familyId, medicineId, userId, content, visibility, userId, userId],
  );
  return result.rows[0];
}

/**
 * Version-guarded update, bound to the note owner. rowCount = 0 means version
 * conflict (existence + ownership confirmed by the caller) → 409.
 */
export async function updateNote(
  database: Database,
  noteId: string,
  medicineId: string,
  familyId: string,
  userId: string,
  content: string,
  visibility: NoteVisibility,
  expectedVersion: number,
): Promise<DosageNoteRow | null> {
  const result = await database.query<DosageNoteRow>(
    `UPDATE dosage_notes SET content = $5, visibility = $6, updated_by = $7, version = version + 1, updated_at = now()
     WHERE id = $1 AND medicine_id = $2 AND family_id = $3 AND user_id = $4 AND version = $8
     RETURNING ${NOTE_COLUMNS}`,
    [noteId, medicineId, familyId, userId, content, visibility, userId, expectedVersion],
  );
  return result.rows[0] ?? null;
}

export async function deleteNote(
  database: Database,
  noteId: string,
  medicineId: string,
  familyId: string,
  userId: string,
): Promise<boolean> {
  const result = await database.query<{ id: string }>(
    "DELETE FROM dosage_notes WHERE id = $1 AND medicine_id = $2 AND family_id = $3 AND user_id = $4 RETURNING id",
    [noteId, medicineId, familyId, userId],
  );
  return result.rowCount !== 0;
}
