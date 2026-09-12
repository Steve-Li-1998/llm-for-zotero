import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { createWriteNotesBatchTool } from "../src/agent/tools/write/writeNotesBatch";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import {
  initPlanDocumentStore,
  loadLatestDocumentForRun,
  loadPlanDocument,
} from "../src/agent/documents/store";
import {
  initAgentBatchItemStore,
  listBatchItems,
} from "../src/agent/store/batchItemStore";
import {
  getBatchJob,
  initAgentBatchJobStore,
} from "../src/agent/store/batchJobStore";
import { describeLibraryMutationActions } from "../src/agent/contracts/actionOperationEvidence";
import { canonicalJsonEqual } from "../src/agent/services/libraryMutation/canonicalJson";
import type { AgentToolContext } from "../src/agent/types";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

/**
 * A batch of notes is N pieces of authored material, not one.
 *
 * Nothing froze the bodies the model wrote, so a retry after a crash could
 * write different text than the user approved, and nothing recorded which of
 * the fifty notes had already landed. Finalizing each body as its own durable
 * document before the first write is what makes both answerable.
 */
describe("note batch material", function () {
  let db: DatabaseSync;
  let native: ReturnType<typeof installNativeNoteStore>;
  let originalZotero: unknown;
  let failOnParent: number | undefined;

  function libraryItem(id: number) {
    return {
      id,
      libraryID: 1,
      parentID: false,
      deleted: false,
      version: 1,
      dateModified: "2026-09-11 10:00:00",
      getDisplayTitle: () => `Paper ${id}`,
      getField: () => "",
      getTags: () => [],
      getCollections: () => [],
      isNote: () => false,
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => [],
      getNotes: () => [],
      async reload() {},
    };
  }

  const targets = new Map([1, 2, 3].map((id) => [id, libraryItem(id)]));

  const gateway = {
    resolveLibraryID: () => 1,
    getItem: (id: number) => targets.get(id) || native.notes.get(id) || null,
    trashItems: async ({ itemIds }: { itemIds: number[] }) => ({
      trashedCount: itemIds.length,
      items: itemIds.map((itemId) => ({ itemId, status: "trashed" })),
    }),
    formatStructuredCitations: () => ({
      styleId: "apa",
      styleTitle: "APA",
      locale: "en-US",
      clusters: [],
      bibliographyEntries: [],
    }),
  } as never;

  function context(runId = "run-batch-1"): AgentToolContext {
    return {
      request: {
        conversationKey: 8801,
        libraryID: 1,
        metadata: { sourceMessageTimestamp: 100 },
      },
      runId,
      item: null,
      currentAnswerText: "",
      modelName: "test-model",
    } as unknown as AgentToolContext;
  }

  function notes() {
    return [
      { targetItemId: 1, content: "Summary of paper one." },
      { targetItemId: 2, content: "## Findings\n\nSummary of paper two." },
      { targetItemId: 3, content: "Summary of paper three." },
    ];
  }

  beforeEach(async function () {
    originalZotero = globalScope.Zotero;
    failOnParent = undefined;
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
        executeTransaction: async (task: () => Promise<unknown>) => task(),
      },
      debug: () => undefined,
    } as unknown as typeof Zotero;
    native = installNativeNoteStore({
      startId: 500,
      onSave: (note: { parentID?: number }) => {
        if (failOnParent !== undefined && note.parentID === failOnParent)
          throw new Error("Zotero refused the note write");
      },
    });
    await initPlanDocumentStore();
    await initAgentBatchJobStore();
    await initAgentBatchItemStore();
    await initAgentChangeJournal();
  });

  afterEach(function () {
    native.restore();
    globalScope.Zotero = originalZotero as typeof Zotero;
    db.close();
  });

  function validated(tool: ReturnType<typeof createWriteNotesBatchTool>) {
    const result = tool.validate({ notes: notes() });
    assert.isTrue(result.ok);
    if (!result.ok) throw new Error("validation failed");
    return result.value;
  }

  function documentCount(): number {
    const rows = db
      .prepare(`SELECT COUNT(*) AS total FROM llm_for_zotero_plan_documents`)
      .all() as Array<{ total: number }>;
    return Number(rows[0].total);
  }

  it("finalizes one document per item before any note is written", async function () {
    const tool = createWriteNotesBatchTool(gateway);
    const output = await tool.execute(validated(tool), context());

    assert.equal(documentCount(), 3, "one finalized document per note body");
    assert.lengthOf(output.batchItems || [], 3);
    const batchId = output.batchItems![0].batchId;
    const rows = await listBatchItems(batchId);
    assert.lengthOf(rows, 3);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["saved", "saved", "saved"],
    );
    assert.deepEqual(
      rows.map((row) => row.itemKey),
      ["item:1", "item:2", "item:3"],
    );
    // Each item's material is a distinct durable identity, not one shared ref.
    assert.lengthOf(new Set(rows.map((row) => row.materialRef.documentId)), 3);
    for (const row of rows) {
      assert.isString(row.actionId);
      assert.isNumber(row.stepSequence);
      assert.isNumber(row.noteId);
    }
    // One journal action owns every step, as Task 1 established.
    assert.lengthOf(new Set(rows.map((row) => row.actionId)), 1);

    const job = await getBatchJob(batchId);
    assert.equal(job?.action, "note_write_batch");
    assert.equal(job?.totalCount, 3);
    assert.equal(job?.appliedCount, 3);
    assert.equal(job?.cursor, 3);
    assert.equal(job?.status, "completed");
  });

  it("writes the stored document's HTML, not the model-supplied body", async function () {
    const tool = createWriteNotesBatchTool(gateway);
    const output = await tool.execute(validated(tool), context());

    const rows = await listBatchItems(output.batchItems![0].batchId);
    for (const row of rows) {
      const document = await loadPlanDocument(row.materialRef.documentId);
      assert.exists(document, "the item's material must still be stored");
      assert.equal(document!.contentHash, row.materialRef.contentHash);
      const note = native.notes.get(row.noteId!);
      assert.exists(note, "every saved row names a real note");
      assert.equal(
        note.stored,
        document!.visibleHtml,
        "the note carries exactly the finalized material",
      );
    }
  });

  it("reuses the run's documents when the same bodies are written again", async function () {
    const tool = createWriteNotesBatchTool(gateway);
    const first = await tool.execute(validated(tool), context());
    const second = await tool.execute(validated(tool), context());

    assert.equal(documentCount(), 3, "a retry mints no new documents");
    assert.deepEqual(
      (second.batchItems || []).map((entry) => entry.materialRef),
      (first.batchItems || []).map((entry) => entry.materialRef),
    );
  });

  it("marks only the item that failed, keeping the others written", async function () {
    failOnParent = 2;
    const tool = createWriteNotesBatchTool(gateway);
    const output = await tool.execute(validated(tool), context());

    const batchId = output.batchItems![0].batchId;
    const rows = await listBatchItems(batchId);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["saved", "failed", "saved"],
    );
    const failed = rows[1];
    assert.include(failed.error || "", "Zotero refused the note write");
    assert.isUndefined(failed.noteId);
    // Its material survives the failure, so a resume never regenerates it.
    assert.exists(await loadPlanDocument(failed.materialRef.documentId));

    const job = await getBatchJob(batchId);
    assert.equal(job?.appliedCount, 2);
    assert.equal(job?.status, "failed");

    assert.deepEqual(
      (output.batchItems || []).map((entry) => entry.status),
      ["saved", "failed", "saved"],
    );
  });

  it("executes the very operation the action contract proposed", async function () {
    const tool = createWriteNotesBatchTool(gateway);
    const input = validated(tool);
    const proposed = describeLibraryMutationActions(input);
    const output = await tool.execute(input, context());

    // A receipt counts as verified only when the recorded evidence names the
    // same operation the user approved, so host bookkeeping must not ride
    // inside the operation value.
    assert.lengthOf(output.actionEvidence || [], 1);
    assert.isTrue(
      canonicalJsonEqual(
        output.actionEvidence![0].operationValue,
        proposed[0].operationValue,
      ),
      "the executed operation must still equal the proposed one",
    );
  });

  it("refuses a batch whose rows do not describe its notes", async function () {
    const service = new LibraryMutationService(gateway);
    let failure: unknown;
    try {
      await service.executeOperation(
        { type: "save_notes_batch", notes: notes() },
        {
          ...context(),
          // Misaligned rows would write paper 1's approved material onto
          // paper 2, durably, so nothing may be written at all.
          batchBinding: {
            batchId: "batch-wrong",
            items: [
              {
                itemKey: "item:3",
                targetItemId: 3,
                material: {
                  documentId: "run-batch-1:document:1",
                  documentVersion: 1,
                  contentHash: "sha256:whatever",
                },
              },
            ],
          },
        } as never,
      );
    } catch (error) {
      failure = error;
    }
    assert.instanceOf(failure, Error);
    assert.include(
      (failure as Error).message,
      "The batch rows do not describe these notes",
    );
    assert.equal(native.notes.size, 0, "no note may be written");
  });

  it("is never mistaken for the run's finalized document", async function () {
    const tool = createWriteNotesBatchTool(gateway);
    await tool.execute(validated(tool), context());

    // External backends replace the turn's answer with the run's finalized
    // document, so a note body picked up here would be spoken as the answer.
    assert.isNull(await loadLatestDocumentForRun("run-batch-1"));
  });

  it("never announces a batch item as the turn's finalized material", async function () {
    const tool = createWriteNotesBatchTool(gateway);
    const output = await tool.execute(validated(tool), context());
    assert.isUndefined(
      (output as { materialRef?: unknown }).materialRef,
      "batch material is announced per item, never as one turn material",
    );
  });
});
