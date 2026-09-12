import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createRenamedTool } from "../src/agent/tools/facade";
import { createSubmitDocumentTool } from "../src/agent/tools/plan/submitPlanDocument";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import {
  initPlanDocumentStore,
  loadPlanDocument,
} from "../src/agent/documents/store";
import { clearAgentTranscriptStore } from "../src/agent/store/transcriptStore";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { setOriginalAgentPermissionMode } from "../src/agent/originalAgentPermissionMode";
import {
  installMockDb,
  installAgentStoreSqlite,
} from "./helpers/agentRuntimeMockDb";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";
import { createTestActionContractService } from "./helpers/actionContractService";
import type { MaterialRef } from "../src/agent/documents/materialRef";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type {
  AgentEvent,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
} from "../src/agent/types";
import type { AgentStepParams } from "../src/agent/model/adapter";

/**
 * The complete direct-Agent material journey: generate in one turn, save in
 * the next, and recover the same material after a failed save.
 *
 * Every other test in this area covers one seam of that path. This one drives
 * `AgentRuntime.runTurn` across the run boundary the product decision creates
 * (`submit_document` ends its turn), so the parts have to agree: the ref the
 * finalizer minted, the ref frozen into the confirmation the user approves,
 * the ref on the receipt, and the ref the next turn is told about.
 */

const PARENT_ITEM_ID = 42;
const DOCUMENT_TITLE = "Representational drift";
const BLOCK_HEADER = "Finalized material available (not saved as a note):";

const submitDocumentGateway = {
  formatStructuredCitations: () => ({
    styleId: "apa",
    styleTitle: "APA",
    locale: "en-US",
    clusters: [],
    bibliographyEntries: [],
  }),
} as unknown as ZoteroGateway;

/** The library the journey writes into: one regular paper and its notes. */
function installJourneyLibrary(): {
  notes: Map<number, any>;
  failNextNativeSave: (enabled: boolean) => void;
  restore: () => void;
} {
  let failNativeSave = false;
  const native = installNativeNoteStore({
    startId: 500,
    onSave: () => {
      if (failNativeSave)
        throw new Error("The native note write never reached the database.");
    },
  });
  const zotero = globalThis.Zotero as unknown as Record<string, any>;
  const parent = {
    id: PARENT_ITEM_ID,
    key: "PAPER42",
    libraryID: 1,
    deleted: false,
    isRegularItem: () => true,
    isNote: () => false,
    isAttachment: () => false,
    getDisplayTitle: () => "Drift in the hippocampus",
  };
  const notes = native.notes;
  zotero.Items = {
    get: (id: number) => (id === PARENT_ITEM_ID ? parent : notes.get(id)),
    getByLibraryAndKey: (libraryID: number, key: string) =>
      key === parent.key
        ? parent
        : [...notes.values()].find(
            (note) => note.libraryID === libraryID && note.key === key,
          ) || null,
  };
  zotero.Libraries = { userLibraryID: 1 };
  return {
    notes,
    failNextNativeSave: (enabled: boolean) => {
      failNativeSave = enabled;
    },
    restore: native.restore,
  };
}

function createJourneyRegistry(): AgentToolRegistry {
  const noteGateway = {
    getItem: (itemId: number) => (globalThis.Zotero as any).Items.get(itemId),
    getCollectionSummary: () => null,
  } as unknown as ZoteroGateway;
  const registry = new AgentToolRegistry(
    createTestActionContractService(
      (itemId) => (globalThis.Zotero as any).Items.get(itemId) || null,
    ),
  );
  registry.register(createSubmitDocumentTool(submitDocumentGateway));
  registry.register(
    createRenamedTool({
      tool: createEditCurrentNoteTool(noteGateway),
      name: "note_write",
      label: "Write Note",
      description:
        "Create, append to, or edit one Zotero note and verify native post-state.",
    }),
  );
  return registry;
}

function submitDocumentStep(callId: string): AgentModelStep {
  const call = {
    id: callId,
    name: "submit_document",
    arguments: {
      documentKind: "guide",
      integrityPolicy: "authored",
      title: DOCUMENT_TITLE,
      markdown: `# ${DOCUMENT_TITLE}\n\nA complete guide.`,
      citations: [],
      quotes: [],
      assets: [],
      groundingReviewed: "passed",
      groundingIssues: [],
    },
  };
  return {
    kind: "tool_calls",
    calls: [call],
    assistantMessage: { role: "assistant", content: "", tool_calls: [call] },
  };
}

function noteWriteStep(callId: string, documentId: string): AgentModelStep {
  const call = {
    id: callId,
    name: "note_write",
    arguments: {
      mode: "create",
      documentId,
      targetItemId: PARENT_ITEM_ID,
    },
  };
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

type JourneyTurn = {
  outcome: Awaited<ReturnType<AgentRuntime["runTurn"]>>;
  events: AgentEvent[];
  /** The request the turn actually ran with, including its material ledger. */
  request: AgentRuntimeRequest | undefined;
  /** The messages handed to the adapter, one entry per generation step. */
  prompts: AgentModelMessage[][];
  /** Generation steps this turn consumed. */
  steps: number;
};

/**
 * Runs one turn against a fixed script.
 *
 * The script is the contract: asking for a step the script does not have
 * fails the turn, which is what proves the journey never regenerated
 * material it had already finalized.
 */
async function runJourneyTurn(params: {
  conversationKey: number;
  userText: string;
  sourceMessageTimestamp: number;
  steps: AgentModelStep[];
  approve?: boolean;
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
        runtime.resolveConfirmation(event.requestId, params.approve !== false);
    },
  });
  return { outcome, events, prompts, request: resolvedRequest, steps: index };
}

function firstEvent<TType extends AgentEvent["type"]>(
  events: readonly AgentEvent[],
  type: TType,
): Extract<AgentEvent, { type: TType }> | undefined {
  return events.find((event) => event.type === type) as
    | Extract<AgentEvent, { type: TType }>
    | undefined;
}

function toolResultFor(
  events: readonly AgentEvent[],
  name: string,
): Extract<AgentEvent, { type: "tool_result" }> | undefined {
  return events.find(
    (event) => event.type === "tool_result" && event.name === name,
  ) as Extract<AgentEvent, { type: "tool_result" }> | undefined;
}

/** The unsaved-material block as the model actually received it. */
function materialBlock(prompts: AgentModelMessage[][]): string | undefined {
  for (const messages of prompts) {
    const message = messages.find((entry) =>
      String(entry.content).includes(BLOCK_HEADER),
    );
    if (message) return String(message.content);
  }
  return undefined;
}

describe("direct material journey", function () {
  let restoreDb: () => void;
  let restoreDocuments: () => void;
  let library: ReturnType<typeof installJourneyLibrary>;
  let originalToolkit: unknown;

  beforeEach(async function () {
    clearAgentTranscriptStore();
    restoreDb = installMockDb();
    restoreDocuments = installAgentStoreSqlite();
    library = installJourneyLibrary();
    originalToolkit = (globalThis as any).ztoolkit;
    (globalThis as any).ztoolkit = { log: () => undefined };
    setOriginalAgentPermissionMode("safe");
    await initPlanDocumentStore();
    await initAgentChangeJournal();
  });

  afterEach(function () {
    (globalThis as any).ztoolkit = originalToolkit;
    library.restore();
    restoreDocuments();
    restoreDb();
  });

  /** Turn 1: the model authors the material and the turn ends there. */
  async function generateMaterial(conversationKey: number): Promise<{
    turn: JourneyTurn;
    materialRef: MaterialRef;
  }> {
    const turn = await runJourneyTurn({
      conversationKey,
      userText: "Write a guide about representational drift",
      sourceMessageTimestamp: 100,
      steps: [submitDocumentStep("submit-document-1")],
    });
    assert.equal(turn.outcome.kind, "completed");
    const announced = firstEvent(turn.events, "material_finalized");
    assert.exists(announced, "turn 1 must announce the finalized material");
    return { turn, materialRef: announced!.materialRef };
  }

  it("generates material in one turn and saves it as a verified note in the next", async function () {
    const conversationKey = 880_101;
    const { turn: first, materialRef } =
      await generateMaterial(conversationKey);

    // Turn 1: the document is finalized and the turn ends on it.
    assert.equal(
      first.steps,
      1,
      "submit_document ends the turn, so it costs exactly one generation step",
    );
    const submitResult = toolResultFor(first.events, "submit_document");
    assert.isTrue(submitResult?.ok);
    assert.deepEqual(
      (submitResult?.content as { materialRef?: MaterialRef }).materialRef,
      materialRef,
      "the announcement names the ref the finalizer returned",
    );
    const firstFinal = firstEvent(first.events, "final");
    assert.deepEqual(
      firstFinal?.materialRef,
      materialRef,
      "the terminal event names the material the turn produced",
    );
    assert.equal(firstFinal?.documentId, materialRef.documentId);

    // Turn 2: the save turn. It never regenerates; it names the document.
    const second = await runJourneyTurn({
      conversationKey,
      userText: "Save that as a note on the paper",
      sourceMessageTimestamp: 200,
      steps: [
        noteWriteStep("note-write-1", materialRef.documentId),
        finalStep("Saved it to the paper."),
      ],
    });
    assert.equal(second.outcome.kind, "completed");
    assert.equal(
      second.steps,
      2,
      "one step proposes the note and one step answers after it is written",
    );

    // The save turn is told the material exists, so it can name the document
    // instead of writing the guide a second time.
    assert.include(
      materialBlock(second.prompts) || "",
      `documentId=${materialRef.documentId} version=${materialRef.documentVersion} hash=${materialRef.contentHash} title="${DOCUMENT_TITLE}" status=finalized`,
    );

    // The user authorizes an exact material version, not just a tool call.
    const confirmation = firstEvent(second.events, "confirmation_required");
    assert.exists(
      confirmation,
      "a note write must be reviewed before it happens",
    );
    assert.equal(confirmation?.action.toolName, "note_write");
    assert.deepEqual(
      confirmation?.action.material,
      { operation: "note_create", ref: materialRef },
      "the confirmation card carries the frozen material reference",
    );
    assert.isTrue(
      second.events.some(
        (event) =>
          event.type === "confirmation_resolved" && event.approved === true,
      ),
    );

    const noteResult = toolResultFor(second.events, "note_write");
    assert.isTrue(noteResult?.ok, "the approved note write must succeed");
    const content = noteResult?.content as {
      noteId?: number;
      documentId?: string;
    };
    assert.equal(content.documentId, materialRef.documentId);
    assert.isNumber(content.noteId);

    // The receipt is the durable proof, and it names both the material and
    // the native state it verified.
    const receipt = (noteResult?.actionReceipts || []).find(
      (entry) => entry.operation === "note_create",
    );
    assert.exists(receipt, "a note write must mint a receipt");
    assert.deepEqual(receipt?.materialRef, materialRef);
    assert.equal(receipt?.verification, "verified");
    assert.include(
      receipt?.verifiedFacts || [],
      `created_note:item:${content.noteId}`,
    );
    const hashFact = (receipt?.verifiedFacts || []).find((fact) =>
      fact.startsWith(`native_note:${content.noteId}:html_sha256:`),
    );
    assert.exists(
      hashFact,
      "the strong evidence path records the native note digest",
    );
    assert.match(hashFact!, /html_sha256:[0-9a-f]{64}$/);

    // Zotero itself must hold the exact finalized document.
    const document = await loadPlanDocument(materialRef.documentId);
    assert.exists(document);
    const note = library.notes.get(content.noteId!);
    assert.exists(note, "the note must exist in the library");
    assert.equal(note.getNote(), document!.visibleHtml);
    assert.equal(note.parentID, PARENT_ITEM_ID);

    // The receipt this journey actually minted must close the material
    // outcome, or a later turn would keep offering to save the same guide
    // and the user would end up with two notes.
    const third = await runJourneyTurn({
      conversationKey,
      userText: "Thanks",
      sourceMessageTimestamp: 300,
      steps: [finalStep("You are welcome.")],
    });
    assert.deepEqual(
      third.request?.materialOutcomes?.map((entry) => entry.status),
      ["saved"],
    );
    assert.isUndefined(
      materialBlock(third.prompts),
      "saved material is never offered for saving again",
    );
    assert.deepEqual(
      [first.steps, second.steps, third.steps],
      [1, 2, 1],
      "four generation steps for the whole journey: author, propose, answer, acknowledge",
    );
  });

  it("recovers the same material for a retry after a failed native write", async function () {
    const conversationKey = 880_202;
    const { turn: first, materialRef } =
      await generateMaterial(conversationKey);
    const document = await loadPlanDocument(materialRef.documentId);
    assert.exists(document);

    // Turn 2: the native write never reaches the database.
    library.failNextNativeSave(true);
    const second = await runJourneyTurn({
      conversationKey,
      userText: "Save that as a note on the paper",
      sourceMessageTimestamp: 200,
      steps: [
        noteWriteStep("note-write-1", materialRef.documentId),
        finalStep("I could not save it."),
      ],
    });
    library.failNextNativeSave(false);
    const failed = toolResultFor(second.events, "note_write");
    assert.exists(failed, "the failed write still reports a result");
    assert.isFalse(failed?.ok, "a native write that did not land is not ok");
    assert.equal(
      library.notes.size,
      0,
      "nothing may be left behind in the library by a failed write",
    );

    // Turn 3: the host tells the model the material is still available, and
    // the model retries the save with the same documentId.
    const third = await runJourneyTurn({
      conversationKey,
      userText: "Try again",
      sourceMessageTimestamp: 300,
      steps: [
        noteWriteStep("note-write-2", materialRef.documentId),
        finalStep("Saved it on the retry."),
      ],
    });
    const block = materialBlock(third.prompts);
    assert.exists(
      block,
      "the turn after a failed write must be told the material still exists",
    );
    assert.include(
      block!,
      `documentId=${materialRef.documentId} version=${materialRef.documentVersion} hash=${materialRef.contentHash} title="${DOCUMENT_TITLE}" status=write_failed`,
    );
    assert.include(block!, "a previous save of this material failed");
    assert.include(
      block!,
      "If the user asks to save it, call note_write with that documentId; do not regenerate it.",
    );
    const blockIndex = third.prompts[0].findIndex((message) =>
      String(message.content).includes(BLOCK_HEADER),
    );
    assert.isTrue(
      (third.prompts[0][blockIndex] as { transient?: boolean }).transient,
      "the block is recomputed every turn, so it must never be persisted",
    );
    assert.include(
      String(third.prompts[0][blockIndex + 1]?.content),
      "Try again",
      "the block sits immediately before this turn's user message",
    );

    assert.equal(third.outcome.kind, "completed");
    const retried = toolResultFor(third.events, "note_write");
    assert.isTrue(retried?.ok, "the retry writes the same material");
    const content = retried?.content as {
      noteId?: number;
      documentId?: string;
    };
    assert.equal(content.documentId, materialRef.documentId);
    const note = library.notes.get(content.noteId!);
    assert.equal(note.getNote(), document!.visibleHtml);

    // No turn after the first ever asked the model to author the material
    // again: the scripts contain no submit_document call, and an unscripted
    // generation step fails the turn outright.
    assert.deepEqual(
      [first.steps, second.steps, third.steps],
      [1, 2, 2],
      "five generation steps for the whole journey: author, propose, answer, propose again, answer",
    );
    assert.isFalse(
      [...second.events, ...third.events].some(
        (event) => event.type === "material_finalized",
      ),
      "material is finalized once for the whole journey",
    );
  });
});
