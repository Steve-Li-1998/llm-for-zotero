import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createRenamedTool } from "../src/agent/tools/facade";
import { createWriteNotesBatchTool } from "../src/agent/tools/write/writeNotesBatch";
import { createUndoLastActionTool } from "../src/agent/tools/write/undoLastAction";
import {
  initPlanDocumentStore,
  loadPlanDocument,
} from "../src/agent/documents/store";
import { clearAgentTranscriptStore } from "../src/agent/store/transcriptStore";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import {
  initAgentBatchItemStore,
  listBatchItems,
} from "../src/agent/store/batchItemStore";
import { initAgentBatchJobStore } from "../src/agent/store/batchJobStore";
import { setOriginalAgentPermissionMode } from "../src/agent/originalAgentPermissionMode";
import {
  installMockDb,
  installAgentStoreSqlite,
} from "./helpers/agentRuntimeMockDb";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";
import { createTestActionContractService } from "./helpers/actionContractService";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type {
  AgentEvent,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
} from "../src/agent/types";
import type { AgentStepParams } from "../src/agent/model/adapter";

/**
 * The complete durable-batch journey: write a note onto three papers, have one
 * of them refused by Zotero, continue the batch in the next turn, and undo the
 * whole set in the one after that.
 *
 * The seams each have their own test. This one drives `AgentRuntime.runTurn`
 * across the two run boundaries the story creates, so the parts have to agree:
 * the material the tool froze before the user approved anything, the durable
 * rows that say which items still owe a note, the host block the next turn is
 * told about, the single journal action that owns every note, and the undo that
 * reverts it.
 */

const PAPER_IDS = [1, 2, 3] as const;
/** The paper whose note the native store refuses on the first attempt. */
const REFUSED_PAPER_ID = 2;
const BATCH_HEADER = "Resumable note batches:";
const MATERIAL_HEADER = "Finalized material available (not saved as a note):";

type JourneyLibrary = {
  notes: Map<number, any>;
  trashed: number[][];
  refuseNoteFor: (parentId: number | undefined) => void;
  restore: () => void;
};

/** The library the journey writes into: three papers and the notes it adds. */
function installJourneyLibrary(): JourneyLibrary {
  let refusedParent: number | undefined;
  const native = installNativeNoteStore({
    startId: 500,
    onSave: (note: { parentID?: number }) => {
      if (note.parentID !== undefined && note.parentID === refusedParent)
        throw new Error("Zotero refused the note write");
    },
  });
  const papers = new Map(
    PAPER_IDS.map((id) => [
      id,
      {
        id,
        key: `PAPER${id}`,
        libraryID: 1,
        parentID: false,
        deleted: false,
        version: 1,
        dateModified: "2026-09-11 10:00:00",
        isRegularItem: () => true,
        isNote: () => false,
        isAttachment: () => false,
        getDisplayTitle: () => `Paper ${id}`,
        getField: () => "",
        getTags: () => [],
        getCollections: () => [],
        getAttachments: () => [],
        getNotes: () => [],
        async reload() {},
      },
    ]),
  );
  const notes = native.notes;
  const zotero = globalThis.Zotero as unknown as Record<string, any>;
  zotero.Items = {
    get: (id: number) =>
      papers.get(id as (typeof PAPER_IDS)[number]) || notes.get(id) || null,
    getByLibraryAndKey: (libraryID: number, key: string) =>
      [...papers.values(), ...notes.values()].find(
        (entry: any) => entry.libraryID === libraryID && entry.key === key,
      ) || null,
  };
  zotero.Libraries = { userLibraryID: 1 };
  return {
    notes,
    trashed: [],
    refuseNoteFor: (parentId: number | undefined) => {
      refusedParent = parentId;
    },
    restore: native.restore,
  };
}

type JourneyTurn = {
  outcome: Awaited<ReturnType<AgentRuntime["runTurn"]>>;
  events: AgentEvent[];
  /** The messages handed to the adapter, one entry per generation step. */
  prompts: AgentModelMessage[][];
  /** The request the turn actually ran with. */
  request: AgentRuntimeRequest | undefined;
  /** Generation steps this turn consumed. */
  steps: number;
};

function toolCallStep(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): AgentModelStep {
  const call = { id: callId, name, arguments: args };
  return {
    kind: "tool_calls",
    calls: [call],
    assistantMessage: { role: "assistant", content: "", tool_calls: [call] },
  };
}

function finalStep(text: string): AgentModelStep {
  return {
    kind: "final",
    text,
    assistantMessage: { role: "assistant", content: text },
  };
}

function firstEvent<TType extends AgentEvent["type"]>(
  events: readonly AgentEvent[],
  type: TType,
): Extract<AgentEvent, { type: TType }> | undefined {
  return events.find((event) => event.type === type) as
    | Extract<AgentEvent, { type: TType }>
    | undefined;
}

function eventsOfType<TType extends AgentEvent["type"]>(
  events: readonly AgentEvent[],
  type: TType,
): Extract<AgentEvent, { type: TType }>[] {
  return events.filter((event) => event.type === type) as Extract<
    AgentEvent,
    { type: TType }
  >[];
}

function toolResultFor(
  events: readonly AgentEvent[],
  name: string,
): Extract<AgentEvent, { type: "tool_result" }> | undefined {
  return events.find(
    (event) => event.type === "tool_result" && event.name === name,
  ) as Extract<AgentEvent, { type: "tool_result" }> | undefined;
}

/** A host block as the model actually received it. */
function hostBlock(
  prompts: AgentModelMessage[][],
  header: string,
): { content: string; transient: boolean; next: string } | undefined {
  for (const messages of prompts) {
    const index = messages.findIndex((entry) =>
      String(entry.content).includes(header),
    );
    if (index < 0) continue;
    return {
      content: String(messages[index].content),
      transient: Boolean(
        (messages[index] as { transient?: boolean }).transient,
      ),
      next: String(messages[index + 1]?.content ?? ""),
    };
  }
  return undefined;
}

describe("batch material journey", function () {
  let restoreDb: () => void;
  let restoreStores: () => void;
  let library: JourneyLibrary;
  let originalToolkit: unknown;

  /** The gateway the batch and undo tools share, reading the live library. */
  function journeyGateway(): ZoteroGateway {
    return {
      resolveLibraryID: () => 1,
      getItem: (itemId: number) =>
        (globalThis.Zotero as any).Items.get(itemId) || null,
      getCollectionSummary: () => null,
      formatStructuredCitations: () => ({
        styleId: "apa",
        styleTitle: "APA",
        locale: "en-US",
        clusters: [],
        bibliographyEntries: [],
      }),
      trashItems: async ({ itemIds }: { itemIds: number[] }) => {
        library.trashed.push([...itemIds]);
        for (const itemId of itemIds) {
          const note = library.notes.get(itemId);
          if (note) note.deleted = true;
        }
        return {
          trashedCount: itemIds.length,
          items: itemIds.map((itemId) => ({ itemId, status: "trashed" })),
        };
      },
    } as unknown as ZoteroGateway;
  }

  function createJourneyRegistry(): AgentToolRegistry {
    const gateway = journeyGateway();
    const registry = new AgentToolRegistry(
      createTestActionContractService(
        (itemId) => (globalThis.Zotero as any).Items.get(itemId) || null,
      ),
    );
    registry.register(
      createRenamedTool({
        tool: createWriteNotesBatchTool(gateway),
        name: "note_write_batch",
        label: "Write Notes",
        description:
          "Write a note onto each of many items in one checkpointed batch operation.",
      }),
    );
    registry.register(createUndoLastActionTool(gateway));
    return registry;
  }

  /**
   * Runs one turn against a fixed script.
   *
   * The script is the contract: asking for a step the script does not have
   * fails the turn, which is what proves the journey never regenerated a note
   * body the batch had already frozen.
   */
  async function runJourneyTurn(params: {
    conversationKey: number;
    userText: string;
    sourceMessageTimestamp: number;
    steps: AgentModelStep[];
  }): Promise<JourneyTurn> {
    const events: AgentEvent[] = [];
    const prompts: AgentModelMessage[][] = [];
    let resolvedRequest: AgentRuntimeRequest | undefined;
    let index = 0;
    const runtime = new AgentRuntime({
      registry: createJourneyRegistry(),
      adapterFactory: (resolved) => ({
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
        }),
        supportsTools: () => true,
        async runStep(stepParams: AgentStepParams): Promise<AgentModelStep> {
          resolvedRequest = resolved;
          prompts.push(stepParams.messages);
          const step = params.steps[index];
          index += 1;
          if (!step)
            throw new Error(
              `The journey script ends at ${params.steps.length} steps; the model was asked to generate a step ${index}.`,
            );
          return step;
        },
      }),
    });
    const outcome = await runtime.runTurn({
      request: {
        conversationKey: params.conversationKey,
        mode: "agent",
        userText: params.userText,
        libraryID: 1,
        model: "test",
        apiKey: "test",
        apiBase: "https://example.invalid",
        metadata: { sourceMessageTimestamp: params.sourceMessageTimestamp },
      },
      onEvent: (event) => {
        events.push(event);
        if (event.type === "confirmation_required")
          runtime.resolveConfirmation(event.requestId, true);
      },
    });
    return { outcome, events, prompts, request: resolvedRequest, steps: index };
  }

  beforeEach(async function () {
    clearAgentTranscriptStore();
    restoreDb = installMockDb();
    restoreStores = installAgentStoreSqlite();
    library = installJourneyLibrary();
    originalToolkit = (globalThis as any).ztoolkit;
    (globalThis as any).ztoolkit = { log: () => undefined };
    setOriginalAgentPermissionMode("safe");
    await initPlanDocumentStore();
    await initAgentBatchJobStore();
    await initAgentBatchItemStore();
    await initAgentChangeJournal();
  });

  afterEach(function () {
    (globalThis as any).ztoolkit = originalToolkit;
    library.restore();
    restoreStores();
    restoreDb();
  });

  it("writes three notes, continues the one that failed, and undoes the set", async function () {
    const conversationKey = 881_101;

    // Turn 1: one call carries all three bodies, and Zotero refuses paper 2.
    library.refuseNoteFor(REFUSED_PAPER_ID);
    const first = await runJourneyTurn({
      conversationKey,
      userText: "Write a summary note on each of these three papers",
      sourceMessageTimestamp: 100,
      steps: [
        toolCallStep("note-batch-1", "note_write_batch", {
          notes: PAPER_IDS.map((id) => ({
            targetItemId: id,
            content: `# Paper ${id}\n\nSummary of paper ${id}.`,
          })),
        }),
        finalStep("I wrote two of the three notes."),
      ],
    });
    library.refuseNoteFor(undefined);
    assert.equal(first.outcome.kind, "completed");

    // The user approved the exact bodies, named by the material frozen for them.
    const confirmation = firstEvent(first.events, "confirmation_required");
    assert.exists(
      confirmation,
      "a batch write must be reviewed before it runs",
    );
    assert.equal(confirmation?.action.toolName, "note_write_batch");
    assert.deepEqual(
      confirmation?.action.fields[0]?.type === "checklist"
        ? confirmation.action.fields[0].items.map((item) => item.label)
        : [],
      ["Paper 1", "Paper 2", "Paper 3"],
      "every item of the set is on one card",
    );

    // Three bodies, three documents, one durable row each.
    const batchItems = eventsOfType(first.events, "batch_item_outcome");
    assert.lengthOf(batchItems, 3, "each item of the batch is announced");
    const batchId = batchItems[0].batchId;
    assert.deepEqual(
      batchItems.map((event) => event.itemKey),
      ["item:1", "item:2", "item:3"],
    );
    assert.deepEqual(
      batchItems.map((event) => event.status),
      ["saved", "failed", "saved"],
      "a refused item fails on its own; the batch does not stop at it",
    );
    assert.deepEqual(
      batchItems.map((event) => event.written),
      [true, false, true],
      "the call reports which notes it actually wrote",
    );
    assert.match(batchItems[1].error || "", /Zotero refused the note write/);
    assert.isEmpty(
      eventsOfType(first.events, "material_finalized"),
      "fifty note bodies must never flood the turn's material ledger",
    );

    const rowsAfterFirst = await listBatchItems(batchId);
    assert.deepEqual(
      rowsAfterFirst.map((row) => row.status),
      ["saved", "failed", "saved"],
    );
    const frozen = rowsAfterFirst.map((row) => row.materialRef!);
    assert.lengthOf(
      new Set(frozen.map((ref) => ref.documentId)),
      3,
      "each note body is its own finalized document",
    );
    for (const [index, ref] of frozen.entries()) {
      const document = await loadPlanDocument(ref.documentId);
      assert.exists(document, "every item's body is stored before any write");
      assert.equal(document!.contentHash, ref.contentHash);
      assert.include(
        document!.visibleMarkdown,
        `Summary of paper ${index + 1}`,
      );
    }
    const savedNoteIds = [rowsAfterFirst[0].noteId!, rowsAfterFirst[2].noteId!];
    assert.equal(library.notes.size, 2, "only the notes that landed exist");
    for (const [index, noteId] of savedNoteIds.entries()) {
      const document = await loadPlanDocument(
        frozen[index === 0 ? 0 : 2].documentId,
      );
      assert.equal(library.notes.get(noteId).stored, document!.visibleHtml);
    }

    // One action, one step per note, and the refused note is a failed step.
    const [openedAction] = await listJournalActions({ conversationKey });
    assert.exists(openedAction, "the batch opens exactly one journal action");
    assert.equal(openedAction.toolName, "note_write_batch");
    assert.equal(openedAction.status, "partially_applied");
    assert.equal(openedAction.affectedCount, 2);
    assert.deepEqual(
      openedAction.steps.map((step) => step.sequence),
      [1, 2, 3],
    );
    assert.deepEqual(
      openedAction.steps.map((step) => step.status),
      ["applied", "failed", "applied"],
    );

    // Turn 2: the host tells the model the batch can be continued, and the
    // model continues it by name. No body is authored a second time.
    const second = await runJourneyTurn({
      conversationKey,
      userText: "Finish the rest",
      sourceMessageTimestamp: 200,
      steps: [
        toolCallStep("note-batch-2", "note_write_batch", {
          resumeBatchId: batchId,
        }),
        finalStep("All three notes are written."),
      ],
    });
    assert.equal(second.outcome.kind, "completed");
    const block = hostBlock(second.prompts, BATCH_HEADER);
    assert.exists(block, "the turn after an interrupted batch must name it");
    assert.include(
      block!.content,
      `batchId=${batchId} total=3 saved=2 failed=1 pending=0`,
    );
    assert.include(
      block!.content,
      `To continue, call note_write_batch with resumeBatchId=${batchId}; the saved items are skipped and no note is regenerated.`,
    );
    assert.isTrue(
      block!.transient,
      "the rows are read again every turn, so the block must never persist",
    );
    assert.include(
      block!.next,
      "Finish the rest",
      "the host block sits immediately before this turn's user message",
    );
    assert.isUndefined(
      hostBlock(second.prompts, MATERIAL_HEADER),
      "batch bodies are recovered from the batch's own rows, not the ledger",
    );

    const resumeResult = toolResultFor(second.events, "note_write_batch");
    assert.isTrue(resumeResult?.ok, "the resume writes the note that failed");
    const rowsAfterResume = await listBatchItems(batchId);
    assert.deepEqual(
      rowsAfterResume.map((row) => row.status),
      ["saved", "saved", "saved"],
    );
    assert.deepEqual(
      rowsAfterResume.map((row) => row.materialRef),
      frozen,
      "the frozen material identities are unchanged: nothing was regenerated",
    );
    const recoveredNoteId = rowsAfterResume[1].noteId!;
    const recoveredDocument = await loadPlanDocument(frozen[1].documentId);
    assert.equal(
      library.notes.get(recoveredNoteId).stored,
      recoveredDocument!.visibleHtml,
      "the recovered note carries exactly the body frozen before the failure",
    );
    assert.deepEqual(
      [rowsAfterResume[0].noteId, rowsAfterResume[2].noteId],
      savedNoteIds,
      "the notes that already landed are left alone",
    );
    assert.equal(library.notes.size, 3, "exactly the missing note is added");
    assert.deepEqual(
      eventsOfType(second.events, "batch_item_outcome").map(
        (event) => event.written,
      ),
      [false, true, false],
      "a resume announces every row it holds and names the one it wrote",
    );
    assert.isEmpty(
      eventsOfType(second.events, "material_finalized"),
      "a resume finalizes nothing",
    );

    // The batch is finished, but its action still holds the first attempt's
    // failed step, so the journal records it as partially applied.
    const actionsAfterResume = await listJournalActions({ conversationKey });
    assert.deepEqual(
      actionsAfterResume.map((action) => action.actionId),
      [openedAction.actionId],
      "a resume opens no second action beside the batch's own",
    );
    assert.equal(actionsAfterResume[0].status, "partially_applied");
    assert.equal(actionsAfterResume[0].affectedCount, 3);
    assert.deepEqual(
      actionsAfterResume[0].steps.map((step) => step.sequence).sort(),
      [1, 2, 3, 4],
      "resumed steps continue the action's sequence instead of colliding",
    );

    // Turn 3: one undo reverts the whole set.
    const third = await runJourneyTurn({
      conversationKey,
      userText: "Undo that",
      sourceMessageTimestamp: 300,
      steps: [
        toolCallStep("undo-1", "undo_last_action", {}),
        finalStep("I removed all three notes."),
      ],
    });
    assert.equal(third.outcome.kind, "completed");
    assert.isUndefined(
      hostBlock(third.prompts, BATCH_HEADER),
      "a batch with every item written is no longer offered for continuing",
    );
    const undoResult = toolResultFor(third.events, "undo_last_action");
    assert.isTrue(undoResult?.ok);
    assert.equal((undoResult?.content as { status?: string }).status, "undone");
    assert.equal(
      (undoResult?.content as { actionId?: string }).actionId,
      openedAction.actionId,
    );
    assert.deepEqual(
      library.trashed,
      [[recoveredNoteId], [savedNoteIds[1]], [savedNoteIds[0]]],
      "the action's steps are reverted newest-first, one note each",
    );
    assert.deepEqual(
      [...library.notes.values()].map((note) => note.deleted),
      [true, true, true],
      "every note the batch wrote is gone from the library",
    );
    const [revertedAction] = await listJournalActions({
      actionId: openedAction.actionId,
    });
    assert.equal(revertedAction.status, "reverted");

    assert.deepEqual(
      [first.steps, second.steps, third.steps],
      [2, 2, 2],
      "six generation steps: propose, answer, continue, answer, undo, answer",
    );
    const batchCalls = [first, second].map(
      (turn) =>
        eventsOfType(turn.events, "tool_call").filter(
          (event) => event.name === "note_write_batch",
        ).length,
    );
    assert.deepEqual(
      batchCalls,
      [1, 1],
      "one batch call wrote three notes and one continued them; no body was authored twice",
    );
  });
});
