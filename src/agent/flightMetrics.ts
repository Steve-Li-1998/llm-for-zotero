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
   * What one durable-batch item cost in model calls, rounded to two decimals;
   * `null` when the flight ran no batch.
   *
   * The numerator is only the model calls of the turns that carried batch work
   * -- the turns whose events announced at least one `batch_item_outcome` --
   * divided by the distinct items those turns touched. A turn that did
   * something else (the undo turn at the end of the batch journey, a question
   * the user asked in between) is not the batch's cost and must not move this
   * number.
   *
   * Turns come from `extras.turnEvents`. A caller that cannot split its
   * events by turn charges the batch for every model call of the flight, which
   * is the old whole-flight reading and an over-estimate.
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
   * Distinct notes proved written by receipt FACTS, by note id.
   *
   * Read from `verifiedFacts`: `created_note:item:<id>` and
   * `native_note:<id>:...`, the facts the note-write verifier mints after a
   * forced native content read-back.
   *
   * A receipt that was verified only against captured post-state counts zero
   * here even though it is `verification: "verified"`, because it names no
   * note and proves no content. Zero therefore means "no content read-back was
   * recorded", never "the writes were unverified": the durable note batch
   * takes the library-mutation receipt branch and carries an empty
   * `verifiedFacts`, so its notes are counted by `batchItems.written` instead.
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
   * batch mints one receipt with no note facts today, so every note it writes
   * lands here.
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
  /**
   * The same events, split by turn and in the same order as `modelCalls`.
   *
   * An `AgentEvent` does not say which turn it belongs to, so a cost that is
   * charged to some turns and not others needs the split from the caller. Omit
   * it and the whole flight is read as one turn.
   */
  turnEvents?: readonly (readonly AgentEvent[])[];
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

/** Every rate this module pins is rounded the same way, to two decimals. */
function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The model calls of the turns that carried batch work.
 *
 * Without a turn split there is nothing to narrow: the flight is read as one
 * turn, so every model call is charged to the batch.
 */
function batchTurnModelCalls(
  events: readonly AgentEvent[],
  extras: AgentFlightExtras,
  modelCallsTotal: number,
): number {
  const carriesBatchWork = (turn: readonly AgentEvent[]) =>
    turn.some((event) => event.type === "batch_item_outcome");
  if (!extras.turnEvents) return carriesBatchWork(events) ? modelCallsTotal : 0;
  let total = 0;
  extras.turnEvents.forEach((turn, index) => {
    if (carriesBatchWork(turn)) total += extras.modelCalls[index] ?? 0;
  });
  return total;
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
      ? roundHundredths(
          batchTurnModelCalls(events, extras, modelCallsTotal) /
            batchItemKeys.size,
        )
      : null,
    toolCallsByStage,
    nativeWrites,
    nativeSaves: extras.nativeSaves,
    duplicateNativeWrites: Math.max(0, extras.nativeSaves - nativeWrites),
    batchItems,
    materialFinalized,
  };
}

/**
 * One streamed turn as it was driven: a fixed transcript pushed at one delta
 * size, and what the panel was asked to do about it.
 *
 * `blocksReleased` is what the coalescer let through; `refreshesScheduled` is
 * how many repaints those blocks asked for. They are separate counts on
 * purpose: the contract that makes streaming affordable is that they stay
 * equal -- one repaint per readable block -- however small the provider's
 * deltas get.
 */
export type RenderFlightRun = {
  /** The name this run is pinned under. */
  id: string;
  /** Characters the provider handed over at a time. */
  deltaChars: number;
  deltas: number;
  charsPushed: number;
  blocksReleased: number;
  refreshesScheduled: number;
  /** Whether the stalled-stream timer fired between every delta. */
  stallTimerFires: boolean;
};

export type RenderFlightSample = Omit<RenderFlightRun, "id"> & {
  /**
   * Repaints per thousand characters of answer, rounded to two decimals.
   *
   * This is the number that has to stay flat across delta sizes: it is the
   * cost of an answer, not the cost of a provider's chunking.
   */
  refreshesPerKChar: number;
};

/** The pinned render journey: one sample per run, keyed by run id. */
export type RenderFlightSummary = Record<string, RenderFlightSample>;

/**
 * Turns the driven runs into the pinned render journey.
 *
 * Pure over the counts: it neither drives a stream nor knows what released a
 * block, so the rig that produces the counts can change without changing what
 * the numbers mean.
 */
export function summarizeRenderFlight(
  runs: readonly RenderFlightRun[],
): RenderFlightSummary {
  const summary: RenderFlightSummary = {};
  for (const run of runs) {
    summary[run.id] = {
      deltaChars: run.deltaChars,
      deltas: run.deltas,
      charsPushed: run.charsPushed,
      blocksReleased: run.blocksReleased,
      refreshesScheduled: run.refreshesScheduled,
      refreshesPerKChar: run.charsPushed
        ? roundHundredths((run.refreshesScheduled * 1000) / run.charsPushed)
        : 0,
      stallTimerFires: run.stallTimerFires,
    };
  }
  return summary;
}
