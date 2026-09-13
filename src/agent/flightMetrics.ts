import type { AgentEvent } from "./types";

/**
 * What one agent flight cost, read off the run's own event stream.
 *
 * This is the deterministic counterpart of
 * `src/agent/research/flightReport.ts`'s `summarizeFlightRuns`: a pure
 * function over an `AgentEvent[]`, with the two quantities that leave no event
 * behind passed in as extras. It exists so a scripted journey in the unit
 * suite can be measured the same way twice and the numbers pinned against
 * drift.
 *
 * Every count comes from a declared contract -- the `stage` a call announced,
 * the `written` flag a durable batch row carries, the facts a receipt proved.
 * None comes from a tool's name: tools are renamed for presentation, so a
 * number keyed on a name would move for a reason that is not a behavior
 * change.
 */
export type AgentFlightSummary = {
  /** Generation steps per turn, in turn order (the adapter seam's count). */
  modelCallsPerTurn: number[];
  modelCallsTotal: number;
  /**
   * Model calls divided by the distinct durable-batch items the flight
   * touched, rounded to three decimals; `null` when the flight ran no batch.
   *
   * This is the number the per-item batch contract exists to hold down: a
   * batch of fifty notes must not cost fifty model calls.
   */
  modelCallsPerBatchItem: number | null;
  /**
   * Tool calls grouped by the product stage each call declared.
   *
   * Keys are `AgentStage` values, plus `"unattributed"` for a call that
   * declared no category at all (an older trace, or a tool with no contract).
   */
  toolCallsByStage: Record<string, number>;
  /**
   * Distinct notes the flight's receipts prove it wrote, by note id.
   *
   * Read from `verifiedFacts`: `created_note:item:<id>` and
   * `native_note:<id>:...`, which are the facts the note-write verifier mints
   * after a forced native read-back.
   */
  nativeWrites: number;
  /** Physical native writes observed at the store (passed in as an extra). */
  nativeSaves: number;
  /**
   * Physical writes the flight's receipts do not account for
   * (`nativeSaves - nativeWrites`, floored at zero).
   *
   * A second write of the same note raises it -- and so does a write whose
   * receipt carries no note fact, which is why it must be read together with
   * `batchItems.written` before anyone calls it a duplicate. The durable note
   * batch mints one aggregate receipt with no per-note facts today, so every
   * note it writes lands here.
   */
  duplicateNativeWrites: number;
  /**
   * Durable-batch rows as they were announced, one count per `written` case.
   *
   * A resumed batch announces every row it holds, so a row it did not write
   * this time is `announcedNotWritten` rather than a write.
   */
  batchItems: {
    written: number;
    announcedNotWritten: number;
    failed: number;
  };
  /** Material finalizations: the host-announced `material_finalized` events. */
  materialFinalized: number;
};

export type AgentFlightExtras = {
  /** One entry per turn, counted where the adapter was actually called. */
  modelCalls: readonly number[];
  /** Native writes that reached the store, counted at the save seam. */
  nativeSaves: number;
};

/** The bucket a tool call with no declared work category is counted in. */
export const UNATTRIBUTED_STAGE = "unattributed";

const CREATED_NOTE_FACT = /^created_note:item:(\d+)$/;
const NATIVE_NOTE_FACT = /^native_note:(\d+):/;

function noteIdOfFact(fact: string): string | undefined {
  const created = CREATED_NOTE_FACT.exec(fact);
  if (created) return created[1];
  const native = NATIVE_NOTE_FACT.exec(fact);
  return native ? native[1] : undefined;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function summarizeAgentFlight(
  events: readonly AgentEvent[],
  extras: AgentFlightExtras,
): AgentFlightSummary {
  const stageOfCall = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "agent_stage" || !event.callId) continue;
    if (!stageOfCall.has(event.callId))
      stageOfCall.set(event.callId, event.stage);
  }

  const toolCallsByStage: Record<string, number> = {};
  const writtenNoteIds = new Set<string>();
  const batchItemKeys = new Set<string>();
  const batchItems = { written: 0, announcedNotWritten: 0, failed: 0 };
  let materialFinalized = 0;

  for (const event of events) {
    if (event.type === "tool_call") {
      const stage =
        stageOfCall.get(event.callId) ||
        event.workCategory ||
        UNATTRIBUTED_STAGE;
      toolCallsByStage[stage] = (toolCallsByStage[stage] || 0) + 1;
    }
    if (event.type === "tool_result") {
      for (const receipt of event.actionReceipts || [])
        for (const fact of receipt.verifiedFacts || []) {
          const noteId = noteIdOfFact(fact);
          if (noteId) writtenNoteIds.add(noteId);
        }
    }
    if (event.type === "batch_item_outcome") {
      batchItemKeys.add(`${event.batchId}::${event.itemKey}`);
      if (event.status === "failed") batchItems.failed += 1;
      else if (event.written) batchItems.written += 1;
      else batchItems.announcedNotWritten += 1;
    }
    if (event.type === "material_finalized") materialFinalized += 1;
  }

  const modelCallsPerTurn = [...extras.modelCalls];
  const modelCallsTotal = modelCallsPerTurn.reduce(
    (total, calls) => total + calls,
    0,
  );
  const nativeWrites = writtenNoteIds.size;
  return {
    modelCallsPerTurn,
    modelCallsTotal,
    modelCallsPerBatchItem: batchItemKeys.size
      ? round(modelCallsTotal / batchItemKeys.size)
      : null,
    toolCallsByStage,
    nativeWrites,
    nativeSaves: extras.nativeSaves,
    duplicateNativeWrites: Math.max(0, extras.nativeSaves - nativeWrites),
    batchItems,
    materialFinalized,
  };
}
