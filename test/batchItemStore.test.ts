import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  createBatchItems,
  initAgentBatchItemStore,
  listBatchItems,
  listResumableBatches,
  markBatchItemFailed,
  markBatchItemSaved,
  BATCH_ITEMS_TABLE,
} from "../src/agent/store/batchItemStore";
import {
  createBatchJob,
  initAgentBatchJobStore,
} from "../src/agent/store/batchJobStore";
import type { MaterialRef } from "../src/agent/documents/materialRef";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

function materialRef(suffix: string): MaterialRef {
  return {
    documentId: `run-1:document:${suffix}`,
    documentVersion: 1,
    contentHash: `sha256:${suffix}`,
  };
}

/**
 * One durable row per note of a batch.
 *
 * Without it a crash halfway through fifty notes left nothing that said which
 * notes were already written, so the only safe resume was to write them all
 * again.
 */
describe("batch item store", function () {
  let originalZotero: unknown;
  let db: DatabaseSync;

  before(function () {
    originalZotero = globalScope.Zotero;
  });

  beforeEach(async function () {
    db = new DatabaseSync(":memory:");
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const statement = db.prepare(sql);
          const values = (params || []).map((value) =>
            value === undefined ? null : value,
          ) as never[];
          if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
            return statement.all(...values);
          statement.run(...values);
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => {
          db.exec("BEGIN");
          try {
            const result = await task();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      },
    } as unknown as typeof Zotero;
    await initAgentBatchJobStore();
    await initAgentBatchItemStore();
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero as typeof Zotero;
    db.close();
  });

  async function batch(jobId: string, conversationKey = 42) {
    await createBatchJob({
      jobId,
      conversationKey,
      action: "note_write_batch",
      input: { target: "item" },
      totalCount: 3,
      now: 1000,
    });
  }

  it("creates the table and runs its migration again without failing", async function () {
    await initAgentBatchItemStore();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>;
    assert.include(
      tables.map((row) => row.name),
      BATCH_ITEMS_TABLE,
    );
    const columns = db
      .prepare(`PRAGMA table_info(${BATCH_ITEMS_TABLE})`)
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        "batch_id",
        "item_key",
        "position",
        "material_document_id",
        "material_version",
        "material_content_hash",
        "action_id",
        "step_sequence",
        "note_id",
        "status",
        "error",
        "created_at",
        "updated_at",
      ],
    );
  });

  it("stores one pending row per item, in position order, with its material", async function () {
    await batch("batch-1");
    await createBatchItems(
      "batch-1",
      [
        { itemKey: "item:2", position: 2, materialRef: materialRef("2") },
        { itemKey: "item:1", position: 1, materialRef: materialRef("1") },
      ],
      1000,
    );

    const rows = await listBatchItems("batch-1");
    assert.deepEqual(
      rows.map((row) => row.itemKey),
      ["item:1", "item:2"],
    );
    assert.deepEqual(rows[0].materialRef, materialRef("1"));
    assert.equal(rows[0].status, "pending");
    assert.isUndefined(rows[0].actionId);
    assert.isUndefined(rows[0].noteId);
    assert.equal(rows[0].createdAt, 1000);
  });

  it("keeps the durable row when the same item is created twice", async function () {
    await batch("batch-1");
    await createBatchItems(
      "batch-1",
      [{ itemKey: "item:1", position: 1, materialRef: materialRef("1") }],
      1000,
    );
    await markBatchItemSaved("batch-1", "item:1", {
      actionId: "action-a",
      stepSequence: 1,
      noteId: 500,
      now: 1100,
    });
    await createBatchItems(
      "batch-1",
      [{ itemKey: "item:1", position: 1, materialRef: materialRef("1") }],
      1200,
    );

    const rows = await listBatchItems("batch-1");
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].status, "saved", "a written note stays written");
    assert.equal(rows[0].noteId, 500);
  });

  it("opens a row with no material as failed, not as pending work", async function () {
    await batch("batch-1");
    await createBatchItems(
      "batch-1",
      [
        { itemKey: "item:1", position: 1, materialRef: materialRef("1") },
        {
          itemKey: "item:2",
          position: 2,
          status: "failed",
          error: "The body could not be finalized",
        },
      ],
      1000,
    );

    const rows = await listBatchItems("batch-1");
    assert.deepEqual(
      rows.map((row) => row.status),
      ["pending", "failed"],
    );
    // A pending row promises a resume material it does not have.
    assert.isUndefined(rows[1].materialRef);
    assert.equal(rows[1].error, "The body could not be finalized");
    const [resumable] = await listResumableBatches(42);
    assert.deepEqual(
      { pending: resumable.pending, failed: resumable.failed },
      { pending: 1, failed: 1 },
    );
  });

  it("records the journal step that wrote a saved note", async function () {
    await batch("batch-1");
    await createBatchItems(
      "batch-1",
      [{ itemKey: "item:1", position: 1, materialRef: materialRef("1") }],
      1000,
    );
    await markBatchItemSaved("batch-1", "item:1", {
      actionId: "action-a",
      stepSequence: 2,
      noteId: 501,
      now: 1100,
    });

    const [row] = await listBatchItems("batch-1");
    assert.equal(row.status, "saved");
    assert.equal(row.actionId, "action-a");
    assert.equal(row.stepSequence, 2);
    assert.equal(row.noteId, 501);
    assert.equal(row.updatedAt, 1100);
    assert.isUndefined(row.error);
  });

  it("keeps the failure reason of an item that did not land", async function () {
    await batch("batch-1");
    await createBatchItems(
      "batch-1",
      [{ itemKey: "item:1", position: 1, materialRef: materialRef("1") }],
      1000,
    );
    await markBatchItemFailed("batch-1", "item:1", {
      actionId: "action-a",
      stepSequence: 1,
      error: "The parent item is in the trash",
      now: 1100,
    });

    const [row] = await listBatchItems("batch-1");
    assert.equal(row.status, "failed");
    assert.equal(row.error, "The parent item is in the trash");
    assert.equal(row.actionId, "action-a");
    assert.equal(row.stepSequence, 1);
    assert.isUndefined(row.noteId);
  });

  it("offers a batch with unwritten items and forgets a completed one", async function () {
    await batch("batch-open");
    await batch("batch-done");
    await batch("batch-other", 99);
    await createBatchItems(
      "batch-open",
      [
        { itemKey: "item:1", position: 1, materialRef: materialRef("1") },
        { itemKey: "item:2", position: 2, materialRef: materialRef("2") },
        { itemKey: "item:3", position: 3, materialRef: materialRef("3") },
      ],
      1000,
    );
    await createBatchItems(
      "batch-done",
      [{ itemKey: "item:9", position: 1, materialRef: materialRef("9") }],
      1000,
    );
    await createBatchItems(
      "batch-other",
      [{ itemKey: "item:7", position: 1, materialRef: materialRef("7") }],
      1000,
    );
    await markBatchItemSaved("batch-open", "item:1", {
      actionId: "action-a",
      stepSequence: 1,
      noteId: 500,
      now: 1100,
    });
    await markBatchItemFailed("batch-open", "item:2", {
      error: "no such item",
      now: 1100,
    });
    await markBatchItemSaved("batch-done", "item:9", {
      actionId: "action-b",
      stepSequence: 1,
      noteId: 600,
      now: 1100,
    });

    const resumable = await listResumableBatches(42);
    assert.deepEqual(
      resumable.map((entry) => entry.batchId),
      ["batch-open"],
    );
    assert.deepEqual(
      {
        total: resumable[0].total,
        saved: resumable[0].saved,
        failed: resumable[0].failed,
        pending: resumable[0].pending,
      },
      { total: 3, saved: 1, failed: 1, pending: 1 },
    );
    // Another conversation's interrupted batch is never offered here.
    assert.deepEqual(
      (await listResumableBatches(99)).map((entry) => entry.batchId),
      ["batch-other"],
    );
  });
});
