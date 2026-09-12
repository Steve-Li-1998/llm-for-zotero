/**
 * Durable per-item state for a batch of notes.
 *
 * `batch_jobs` remembers how far a paged job got; it cannot say which of
 * fifty notes were written, because a page is not an item. A note batch needs
 * the finer record: each note has its own finalized material, its own journal
 * step, its own note ID and its own failure. Without a row per item, a crash
 * halfway through left nothing that distinguished a written note from an
 * unwritten one, so the only safe resume was to regenerate and rewrite all
 * fifty.
 *
 * One row per item, written as each note lands, is what makes "continue where
 * it stopped" answerable from storage instead of from the model's memory.
 */
import type { MaterialRef } from "../documents/materialRef";
import { BATCH_JOBS_TABLE } from "./batchJobStore";

export const BATCH_ITEMS_TABLE = "llm_for_zotero_agent_batch_items";

export type BatchItemStatus = "pending" | "saved" | "failed";

export type BatchItemRecord = {
  batchId: string;
  itemKey: string;
  position: number;
  /**
   * The finalized note body this item writes, frozen before the first write.
   * Absent only when that body could not be finalized, which is exactly what
   * makes the row `failed`.
   */
  materialRef?: MaterialRef;
  /** The journal action and step that wrote the note, once one did. */
  actionId?: string;
  stepSequence?: number;
  noteId?: number;
  status: BatchItemStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type NewBatchItem = {
  itemKey: string;
  position: number;
  materialRef?: MaterialRef;
  /**
   * State to open the row in. An item whose body could not be finalized is
   * seeded `failed`: a `pending` row promises a resume material it does not
   * have, and a crash before the write would leave that promise standing.
   */
  status?: BatchItemStatus;
  error?: string;
};

/** A batch with at least one item still unwritten. */
export type ResumableBatch = {
  batchId: string;
  conversationKey: number;
  total: number;
  saved: number;
  failed: number;
  pending: number;
  updatedAt: number;
};

type ItemRow = {
  batch_id: string;
  item_key: string;
  position: number;
  material_document_id: string | null;
  material_version: number | null;
  material_content_hash: string | null;
  action_id: string | null;
  step_sequence: number | null;
  note_id: number | null;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

function hasDb(): boolean {
  try {
    return Boolean(
      (Zotero as unknown as { DB?: { queryAsync?: unknown } }).DB?.queryAsync,
    );
  } catch {
    return false;
  }
}

function normalizeStatus(value: unknown): BatchItemStatus {
  return value === "saved" || value === "failed" ? value : "pending";
}

function optionalNumber(value: number | null): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function toRecord(row: ItemRow): BatchItemRecord {
  return {
    batchId: row.batch_id,
    itemKey: row.item_key,
    position: Number(row.position) || 0,
    materialRef: row.material_document_id
      ? {
          documentId: row.material_document_id,
          documentVersion: Number(row.material_version) || 1,
          contentHash: String(row.material_content_hash || ""),
        }
      : undefined,
    actionId: row.action_id ?? undefined,
    stepSequence: optionalNumber(row.step_sequence),
    noteId: optionalNumber(row.note_id),
    status: normalizeStatus(row.status),
    error: row.error ?? undefined,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export async function initAgentBatchItemStore(): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${BATCH_ITEMS_TABLE} (
        batch_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        position INTEGER NOT NULL,
        material_document_id TEXT,
        material_version INTEGER,
        material_content_hash TEXT,
        action_id TEXT,
        step_sequence INTEGER,
        note_id INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending','saved','failed')),
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(batch_id, item_key)
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${BATCH_ITEMS_TABLE}_position_idx
       ON ${BATCH_ITEMS_TABLE} (batch_id, position)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${BATCH_ITEMS_TABLE}_status_idx
       ON ${BATCH_ITEMS_TABLE} (status, batch_id)`,
    );
  });
}

/**
 * Seeds the batch before its first write.
 *
 * An item that already has a row keeps it: the stored row is the record of
 * what happened to that note, and a repeated call — a retry of the same tool
 * call — must never reset a written note back to `pending`.
 */
export async function createBatchItems(
  batchId: string,
  rows: readonly NewBatchItem[],
  now: number = Date.now(),
): Promise<void> {
  if (!hasDb() || !rows.length) return;
  await Zotero.DB.executeTransaction(async () => {
    for (const row of rows) {
      await Zotero.DB.queryAsync(
        `INSERT OR IGNORE INTO ${BATCH_ITEMS_TABLE}
         (batch_id, item_key, position, material_document_id, material_version,
          material_content_hash, action_id, step_sequence, note_id, status,
          error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
        [
          batchId,
          row.itemKey,
          row.position,
          row.materialRef?.documentId ?? null,
          row.materialRef?.documentVersion ?? null,
          row.materialRef?.contentHash ?? null,
          row.status ?? "pending",
          row.error ?? null,
          now,
          now,
        ],
      );
    }
  });
}

/** Records the note a step actually wrote, after the native write landed. */
export async function markBatchItemSaved(
  batchId: string,
  itemKey: string,
  params: {
    actionId?: string;
    stepSequence?: number;
    noteId: number;
    now?: number;
  },
): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${BATCH_ITEMS_TABLE}
     SET status = 'saved', action_id = ?, step_sequence = ?, note_id = ?,
         error = NULL, updated_at = ?
     WHERE batch_id = ? AND item_key = ?`,
    [
      params.actionId ?? null,
      params.stepSequence ?? null,
      params.noteId,
      params.now ?? Date.now(),
      batchId,
      itemKey,
    ],
  );
}

/** Records why one item did not land, leaving its material available to retry. */
export async function markBatchItemFailed(
  batchId: string,
  itemKey: string,
  params: {
    actionId?: string;
    stepSequence?: number;
    error: string;
    now?: number;
  },
): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${BATCH_ITEMS_TABLE}
     SET status = 'failed', action_id = ?, step_sequence = ?, error = ?,
         updated_at = ?
     WHERE batch_id = ? AND item_key = ?`,
    [
      params.actionId ?? null,
      params.stepSequence ?? null,
      params.error,
      params.now ?? Date.now(),
      batchId,
      itemKey,
    ],
  );
}

export async function listBatchItems(
  batchId: string,
): Promise<BatchItemRecord[]> {
  if (!hasDb()) return [];
  const rows = (await Zotero.DB.queryAsync(
    `SELECT * FROM ${BATCH_ITEMS_TABLE}
     WHERE batch_id = ? ORDER BY position ASC`,
    [batchId],
  )) as unknown as ItemRow[] | null;
  return Array.isArray(rows) ? rows.map(toRecord) : [];
}

/**
 * Batches of this conversation that still have an item to write.
 *
 * The rows are the authority, not the job status: a batch whose items are all
 * `saved` has nothing to continue even while its job row is still open, and a
 * batch with one failed item is resumable even after the process restarted.
 */
export async function listResumableBatches(
  conversationKey: number,
): Promise<ResumableBatch[]> {
  if (!hasDb()) return [];
  const rows = (await Zotero.DB.queryAsync(
    `SELECT items.batch_id AS batchId,
            jobs.conversation_key AS conversationKey,
            COUNT(*) AS total,
            SUM(CASE WHEN items.status = 'saved' THEN 1 ELSE 0 END) AS saved,
            SUM(CASE WHEN items.status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN items.status = 'pending' THEN 1 ELSE 0 END) AS pending,
            MAX(items.updated_at) AS updatedAt
     FROM ${BATCH_ITEMS_TABLE} items
     JOIN ${BATCH_JOBS_TABLE} jobs ON jobs.job_id = items.batch_id
     WHERE jobs.conversation_key = ?
     GROUP BY items.batch_id, jobs.conversation_key
     HAVING SUM(CASE WHEN items.status IN ('pending','failed') THEN 1 ELSE 0 END) > 0
     ORDER BY MAX(items.updated_at) DESC`,
    [conversationKey],
  )) as unknown as Array<Record<string, unknown>> | null;
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    batchId: String(row.batchId),
    conversationKey: Number(row.conversationKey) || 0,
    total: Number(row.total) || 0,
    saved: Number(row.saved) || 0,
    failed: Number(row.failed) || 0,
    pending: Number(row.pending) || 0,
    updatedAt: Number(row.updatedAt) || 0,
  }));
}

export async function clearAgentBatchItems(): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(`DELETE FROM ${BATCH_ITEMS_TABLE}`);
}
