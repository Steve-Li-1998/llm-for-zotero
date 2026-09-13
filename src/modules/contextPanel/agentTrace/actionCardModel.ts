import type {
  AgentActionSummaryResultCard,
  AgentNoteChangeResultCard,
  AgentRunEventRecord,
  AgentSavedNoteResultCard,
} from "../../../agent/types";
import type { AgentActionReceipt } from "../../../agent/contracts/types";
import { receiptReportsEffect } from "../../../agent/contracts/actionEvaluation";
import {
  AGENT_ACTION_VERIFICATION_LABELS,
  worstAgentActionVerification,
  type AgentActionVerification,
} from "../../../agent/contracts/actionVerificationLabels";
import { operationLabel } from "../../../agent/contracts/operationCatalog";
import { operationVerb, type ActionCardVerb } from "./actionCardVocabulary";

/** A native object an effect covered, named the way the reader already sees it. */
export type ActionCardTarget =
  | {
      kind: "item";
      itemId: number;
      label: string;
      libraryID?: number;
      itemKey?: string;
    }
  | {
      kind: "collection";
      collectionId: number;
      label: string;
      libraryID?: number;
    }
  | { kind: "library"; libraryID: number; label: string };

/** What an effect acted on, beyond the targets it covered. */
export type ActionCardObject =
  | {
      kind: "collection";
      label: string;
      collectionId?: number;
      libraryID?: number;
    }
  | { kind: "tag"; label: string; removed?: true }
  | {
      kind: "note";
      label: string;
      noteId?: number;
      libraryID?: number;
      itemKey?: string;
    }
  | { kind: "file"; label: string; path: string }
  | { kind: "command"; label: string }
  | { kind: "trash"; libraryID?: number }
  | { kind: "field"; label: string };

/** One receipt's effect: how it is drawn, what it is called, what it touched. */
export type ActionCardEffect = {
  receiptId: string;
  operation: string;
  verb: ActionCardVerb;
  label: string;
  objects: ActionCardObject[];
};

/** One row of the card: the objects a set of effects covered, and its verdict. */
export type ActionCardEntry = {
  targets: ActionCardTarget[];
  effects: ActionCardEffect[];
  verification: AgentActionVerification | null;
  badges: string[];
  authority?: "external_runtime";
  rejected: ActionCardTarget[];
  rejectedReason?: string;
  /** Set by render.ts when a note card matches a note effect in this row. */
  detail?:
    | { kind: "saved_note"; card: AgentSavedNoteResultCard }
    | { kind: "note_change"; card: AgentNoteChangeResultCard };
};

/**
 * How the card names native objects.
 *
 * A receipt carries identities, not words. These resolve an identity against
 * the library the reader is looking at; a resolver that knows nothing returns
 * nothing, and the card falls back to the identity itself rather than inventing
 * a name.
 */
export type ActionCardResolvers = {
  itemLabel: (
    itemId: number,
  ) =>
    | Omit<Extract<ActionCardTarget, { kind: "item" }>, "kind" | "itemId">
    | undefined;
  collectionLabel: (
    collectionId: number,
  ) => { label: string; libraryID?: number } | undefined;
  noteLabel: (
    noteId: number,
  ) => { label: string; libraryID?: number; itemKey?: string } | undefined;
  materialTitle: (documentId: string) => string | undefined;
};

/** The wording a connected client's authority carries wherever it is shown. */
const EXTERNAL_AUTHORITY_LABEL = "Authorized by connected client";

/** The operations whose object is the note they wrote. */
const NOTE_OPERATIONS = new Set([
  "note_create",
  "note_edit",
  "note_append",
  "save_note",
  "save_notes_batch",
]);

/** Every receipt the run journaled, in the order the trace carries them. */
function collectRunReceipts(
  events: readonly AgentRunEventRecord[],
): AgentActionReceipt[] {
  const byId = new Map<string, AgentActionReceipt>();
  for (const entry of events) {
    const payload = entry.payload;
    const receipts =
      payload.type === "tool_result" || payload.type === "codex_tool_activity"
        ? payload.actionReceipts
        : undefined;
    for (const receipt of receipts || []) {
      // One effect reaches the trace through both the tool result and the
      // connected runtime's activity event; the receipt id is its identity.
      if (receipt?.id && !byId.has(receipt.id)) byId.set(receipt.id, receipt);
    }
  }
  return [...byId.values()];
}

/** The material the run's visible answer was rendered from, when it named one. */
function answerMaterialTitle(
  events: readonly AgentRunEventRecord[],
  materialTitle: (documentId: string) => string | undefined,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (payload?.type !== "final") continue;
    const documentId = payload.materialRef?.documentId;
    return documentId ? materialTitle(documentId) : undefined;
  }
  return undefined;
}

/** The native item a `item:<id>` target names, when that is what it names. */
function itemIdOf(target: string): number | undefined {
  const match = /^item:(\d+)$/u.exec(target);
  return match ? Number(match[1]) : undefined;
}

/**
 * The note a note-writing receipt landed on.
 *
 * The verified fact is preferred because it is what the read-back actually
 * proved; the requested parameter is only what the action asked for, and a
 * create has none of it at all.
 */
export function noteEffectNoteId(
  receipt: AgentActionReceipt,
): number | undefined {
  for (const fact of receipt.verifiedFacts || []) {
    const match = /^native_note:(\d+):/u.exec(fact);
    if (match) return Number(match[1]);
  }
  const id = receipt.normalizedParameters?.targetNoteId;
  return typeof id === "number" && id > 0 ? id : undefined;
}

/** One target the card names as a native item. */
type ActionCardItemTarget = Extract<ActionCardTarget, { kind: "item" }>;

/**
 * The items a receipt's targets name, in the order the receipt lists them.
 *
 * A target that names anything else is left out: the row states the objects it
 * can name, not a token the reader would have to decode.
 */
function resolveTargets(
  targets: readonly string[],
  resolvers: ActionCardResolvers,
): ActionCardItemTarget[] {
  const out: ActionCardItemTarget[] = [];
  for (const target of targets) {
    const itemId = itemIdOf(target);
    if (itemId === undefined) continue;
    const resolved = resolvers.itemLabel(itemId);
    out.push({
      kind: "item",
      itemId,
      label: resolved?.label || `Item ${itemId}`,
      ...(resolved?.libraryID !== undefined
        ? { libraryID: resolved.libraryID }
        : {}),
      ...(resolved?.itemKey ? { itemKey: resolved.itemKey } : {}),
    });
  }
  return out;
}

/**
 * What the effect acted on, beyond the items it covered: the collection it
 * moved into, the tags it applied, the note it wrote, the file it produced.
 *
 * Only the receipt's own normalized parameters and verified facts are read, so
 * the card can never name an object no receipt claims.
 */
function objectsOf(
  receipt: AgentActionReceipt,
  resolvers: ActionCardResolvers,
): ActionCardObject[] {
  const p = receipt.normalizedParameters || {};
  const op = receipt.operation as string;
  const collection = (
    id: number | undefined,
    name: string | undefined,
  ): ActionCardObject | null => {
    if (typeof id === "number") {
      const resolved = resolvers.collectionLabel(id);
      return {
        kind: "collection",
        label: resolved?.label || name || `Collection ${id}`,
        collectionId: id,
        ...(resolved?.libraryID !== undefined
          ? { libraryID: resolved.libraryID }
          : {}),
      };
    }
    return name ? { kind: "collection", label: name } : null;
  };
  if (
    op === "move_to_collection" ||
    op === "remove_from_collection" ||
    op === "set_item_collections" ||
    op === "create_collection" ||
    op === "update_collection" ||
    op === "delete_collection"
  ) {
    const single = collection(
      p.destinationCollectionId ?? p.collectionId,
      p.collectionName,
    );
    if (single) return [single];
    return (p.collectionIds || [])
      .map((id) => collection(id, undefined))
      .filter((entry): entry is ActionCardObject => Boolean(entry));
  }
  if (op === "apply_tags" || op === "set_item_tags")
    return (p.tags || []).map((label) => ({ kind: "tag", label }));
  if (op === "remove_tags")
    return (p.tags || []).map((label) => ({
      kind: "tag",
      label,
      removed: true as const,
    }));
  if (op === "update_library_tag")
    return [
      ...(p.tag
        ? [{ kind: "tag" as const, label: p.tag, removed: true as const }]
        : []),
      ...(p.newTag ? [{ kind: "tag" as const, label: p.newTag }] : []),
    ];
  if (NOTE_OPERATIONS.has(op)) {
    const noteId = noteEffectNoteId(receipt);
    const resolved =
      noteId !== undefined ? resolvers.noteLabel(noteId) : undefined;
    return [
      {
        kind: "note",
        label: resolved?.label || "Note",
        ...(noteId !== undefined ? { noteId } : {}),
        ...(resolved?.libraryID !== undefined
          ? { libraryID: resolved.libraryID }
          : {}),
        ...(resolved?.itemKey ? { itemKey: resolved.itemKey } : {}),
      },
    ];
  }
  if (
    op === "file_write" ||
    op === "rename_attachment" ||
    op === "relink_attachment" ||
    op === "import_local_files"
  ) {
    const path = p.newPath || p.newName;
    return path ? [{ kind: "file", label: path, path }] : [];
  }
  if (op === "command_execute" || op === "zotero_script_execute")
    return p.expectedText ? [{ kind: "command", label: p.expectedText }] : [];
  if (op === "update_metadata")
    return (p.metadataFields || []).map((label) => ({ kind: "field", label }));
  if (op === "trash_items" || op === "restore_from_trash")
    return [{ kind: "trash" }];
  return [];
}

/** The targets a receipt claims it covered, rejections excluded. */
function coveredTargets(receipt: AgentActionReceipt): string[] {
  const rejected = new Set(receipt.rejectedTargets || []);
  const covered = receipt.requestedTargets?.length
    ? receipt.requestedTargets.filter((target) => !rejected.has(target))
    : [
        ...(receipt.appliedTargets || []),
        ...(receipt.alreadySatisfiedTargets || []),
      ];
  return [...new Set(covered)];
}

/** One row under construction: its objects, and the receipts that filled it. */
type ActionCardRow = {
  targets: ActionCardItemTarget[];
  effects: ActionCardEffect[];
  receipts: AgentActionReceipt[];
  rejected: ActionCardItemTarget[];
  rejectedReason?: string;
};

/**
 * The verdict wording a row shows: what its receipts proved, and the authority
 * they ran under. The weakest proof wins, because a verified receipt beside an
 * unverified one does not make the row verified.
 */
function rowBadges(
  verification: AgentActionVerification | null,
  authority: boolean,
): string[] {
  return [
    verification ? AGENT_ACTION_VERIFICATION_LABELS[verification] : "",
    authority ? EXTERNAL_AUTHORITY_LABEL : "",
  ].filter(Boolean);
}

/**
 * What the turn did, projected from the receipts the run journaled.
 *
 * The reader used to get this as the `[Action status: …]` block appended to
 * the answer, which was written for the model. The same facts are stated here
 * instead, as structure rather than prose: the items an effect covered, the
 * operation's catalog label and glyph, the objects it acted on, and the shared
 * verification wording the trace rows already use. Nothing is read from a tool
 * name, and nothing is added that no receipt claims.
 *
 * Which receipts count is `receiptReportsEffect`, the same predicate the
 * model-facing block selects with, so the card and the block can never come to
 * disagree about what the turn did. A turn that only read and answered states
 * nothing and shows no card.
 *
 * Receipts that covered the same set of items share a row, keyed by those item
 * ids rather than by their labels, so two items that happen to read the same
 * never collapse into one. A receipt that rejected a target keeps its own row:
 * its rejection belongs to it alone, and merging it would attach the reason to
 * effects that never hit it.
 *
 * The resolvers name native objects; a resolver that returns nothing leaves the
 * card with the identity it already had, never with a guess.
 */
export function buildAgentActionSummaryCard(
  events: readonly AgentRunEventRecord[],
  resolvers: ActionCardResolvers,
): AgentActionSummaryResultCard | null {
  const receipts = collectRunReceipts(events).filter(receiptReportsEffect);
  if (!receipts.length) return null;
  const rows = new Map<string, ActionCardRow>();
  for (const receipt of receipts) {
    const targets = resolveTargets(coveredTargets(receipt), resolvers);
    const rejected = resolveTargets(receipt.rejectedTargets || [], resolvers);
    const effect: ActionCardEffect = {
      receiptId: receipt.id,
      operation: receipt.operation,
      verb: operationVerb(receipt.operation),
      label: operationLabel(receipt.operation),
      objects: objectsOf(receipt, resolvers),
    };
    const targetKey = [...new Set(targets.map((target) => target.itemId))]
      .sort((left, right) => left - right)
      .join(",");
    const key = rejected.length ? `${targetKey} ${receipt.id}` : targetKey;
    const existing = rows.get(key);
    if (existing) {
      existing.effects.push(effect);
      existing.receipts.push(receipt);
      continue;
    }
    rows.set(key, {
      targets,
      effects: [effect],
      receipts: [receipt],
      rejected,
      ...(rejected.length && receipt.reasons?.[0]
        ? { rejectedReason: receipt.reasons[0] }
        : {}),
    });
  }
  const entries: ActionCardEntry[] = [...rows.values()].map((row) => {
    const verification = worstAgentActionVerification(row.receipts);
    const authority = row.receipts.some(
      (receipt) => receipt.executionAuthority === "external_runtime",
    );
    return {
      targets: row.targets,
      effects: row.effects,
      verification,
      badges: rowBadges(verification, authority),
      ...(authority ? { authority: "external_runtime" as const } : {}),
      rejected: row.rejected,
      ...(row.rejectedReason ? { rejectedReason: row.rejectedReason } : {}),
    };
  });
  return {
    kind: "action_summary",
    answerMaterial: answerMaterialTitle(events, resolvers.materialTitle),
    actionCount: receipts.length,
    entries,
  };
}
