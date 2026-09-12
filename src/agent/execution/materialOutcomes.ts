import { loadMaterialRef } from "../documents/workflowMaterial";
import {
  listAgentRunEvents,
  listAgentRunsForConversation,
} from "../store/traceStore";
import type { AgentEvent } from "../types";
import {
  collectJournalActionIds,
  materialRefKey,
  parseMaterialRef,
} from "./checkpoint";
import type {
  DroppedMaterialOutcome,
  MaterialOutcomeEntry,
  MaterialOutcomeLedger,
} from "./types";

export type {
  DroppedMaterialOutcome,
  MaterialOutcomeEntry,
  MaterialOutcomeLedger,
  MaterialOutcomeStatus,
} from "./types";

/**
 * How far back a conversation is scanned for material outcomes.
 *
 * The ledger is derived, not stored, so the bound is what keeps a long
 * conversation's turn start cheap.
 */
export const MATERIAL_OUTCOME_RUN_LIMIT = 20;

const NOTE_WRITE_TOOL_NAME = "note_write";

type OpenEntry = {
  entry: MaterialOutcomeEntry;
  /** Position of the announcement that opened this entry, for newest-first order. */
  ordinal: number;
};

function readDocumentId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = (value as Record<string, unknown>).documentId;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

/**
 * Replay one conversation's persisted run events into material outcomes.
 *
 * `material_finalized` opens an entry; a verified receipt naming the same
 * `MaterialRef` closes it as saved; a failed `note_write` against the same
 * document marks it as a failed write.  Events are replayed in run order, so
 * the last thing that happened to a document is the status it carries.
 */
export async function loadMaterialOutcomesForConversation(
  conversationKey: number,
  options: { limitRuns?: number } = {},
): Promise<MaterialOutcomeLedger> {
  const limitRuns = Math.max(
    1,
    Math.floor(options.limitRuns ?? MATERIAL_OUTCOME_RUN_LIMIT),
  );
  const runs = (await listAgentRunsForConversation(conversationKey)).slice(
    -limitRuns,
  );
  const open = new Map<string, OpenEntry>();
  let ordinal = 0;
  for (const run of runs) {
    const callArguments = new Map<string, unknown>();
    for (const record of await listAgentRunEvents(run.runId)) {
      ordinal += 1;
      const event: AgentEvent = record.payload;
      if (event.type === "tool_call") {
        callArguments.set(event.callId, event.args);
        continue;
      }
      if (event.type === "material_finalized") {
        const materialRef = parseMaterialRef(event.materialRef);
        if (!materialRef) continue;
        open.set(materialRef.documentId, {
          ordinal,
          entry: {
            materialRef,
            materialKind: event.materialKind,
            materialTitle: event.materialTitle,
            runId: run.runId,
            status: "finalized",
          },
        });
        continue;
      }
      if (event.type !== "tool_result") continue;
      if (event.ok) {
        for (const receipt of event.actionReceipts || []) {
          const receiptRef = parseMaterialRef(receipt.materialRef);
          if (receipt.verification !== "verified" || !receiptRef) continue;
          const saved = open.get(receiptRef.documentId);
          if (
            !saved ||
            materialRefKey(saved.entry.materialRef) !==
              materialRefKey(receiptRef)
          )
            continue;
          const actionId = collectJournalActionIds(event.content)[0];
          saved.entry = {
            ...saved.entry,
            status: "saved",
            receiptId: receipt.id,
            ...(actionId ? { actionId } : {}),
          };
        }
        continue;
      }
      if (event.name !== NOTE_WRITE_TOOL_NAME) continue;
      const documentId =
        readDocumentId(event.content) ||
        readDocumentId(callArguments.get(event.callId));
      const failed = documentId ? open.get(documentId) : undefined;
      if (failed)
        failed.entry = { ...failed.entry, status: "write_failed" as const };
    }
  }

  const entries: MaterialOutcomeEntry[] = [];
  const dropped: DroppedMaterialOutcome[] = [];
  for (const { entry } of [...open.values()].sort(
    (left, right) => right.ordinal - left.ordinal,
  )) {
    try {
      const stored = await loadMaterialRef(entry.materialRef, conversationKey);
      if (!stored) {
        dropped.push({
          documentId: entry.materialRef.documentId,
          runId: entry.runId,
          reason: "The finalized material is no longer stored.",
        });
        continue;
      }
      entries.push(entry);
    } catch (error) {
      dropped.push({
        documentId: entry.materialRef.documentId,
        runId: entry.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { entries, dropped };
}

/**
 * The host block that names material the conversation finalized but never
 * saved.  Empty when every finalized material was already written.
 */
export function formatMaterialOutcomeRecoveryLines(
  entries: readonly MaterialOutcomeEntry[],
): string[] {
  const unsaved = entries.filter(
    (entry) => entry.status === "finalized" || entry.status === "write_failed",
  );
  if (!unsaved.length) return [];
  return [
    "Finalized material not yet saved:",
    ...unsaved.map(
      (entry) =>
        `documentId=${entry.materialRef.documentId} version=${entry.materialRef.documentVersion} hash=${entry.materialRef.contentHash} title="${entry.materialTitle || ""}" status=${entry.status}`,
    ),
    "To save it, call note_write with that documentId; do not regenerate it.",
  ];
}
