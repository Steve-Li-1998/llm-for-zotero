/**
 * Writes a note onto each of many items under the central interaction policy.
 *
 * `note_write` takes a single `targetItemId` and every `mode:'create'` call
 * returns its own review card, so "write a summary note on each of my 50 most
 * recent papers" meant 50 tool calls and 50 human approvals. The round budget
 * was never the binding constraint — consent was.
 */
import type {
  AgentBatchBinding,
  AgentBatchItemOutcome,
  AgentToolContext,
  AgentWriteToolDefinition,
} from "../../types";
import type { MaterialRef } from "../../documents/materialRef";
import {
  LibraryMutationService,
  type SaveNotesBatchOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { DirectDocumentFinalizer } from "../../documents/directFinalization";
import { materialRefFromDocument } from "../../documents/workflowMaterial";
import {
  createBatchJob,
  finishBatchJob,
  getBatchJob,
} from "../../store/batchJobStore";
import {
  createBatchItems,
  listBatchItems,
  type NewBatchItem,
} from "../../store/batchItemStore";
import { sha256Text } from "../../store/journalRecoveryBlobStore";
import { describeLibraryMutationActions } from "../../contracts/actionOperationEvidence";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import {
  executeAndRecordUndo,
  normalizeChecklistItemIdsFromResolution,
  planLibraryMutations,
} from "./mutateLibraryShared";

const NOTES_CHECKLIST_FIELD_ID = "writeNotesChecklist";

/**
 * One prepared item: its durable row key, the material frozen for it, and the
 * preview the user approves. Host-only, set during preparation.
 */
type PreparedBatchItem = {
  itemKey: string;
  targetItemId: number;
  material?: MaterialRef;
  /** Exactly what the confirmation card shows for this item. */
  preview: string;
  /** Why this item has no material; it is recorded failed and never written. */
  failure?: string;
};

type WriteNotesBatchInput = {
  operation: SaveNotesBatchOperation;
  /** Host-prepared per-item material, frozen before the user is asked. */
  _items?: PreparedBatchItem[];
};

/**
 * A durable row key for one item of this batch.
 *
 * The target item identifies the note in every user-visible surface, so it is
 * the key; a batch that writes two notes onto the same paper distinguishes
 * them by occurrence so the batch's rows stay one per note.
 */
function batchItemKeys(notes: SaveNotesBatchOperation["notes"]): string[] {
  const seen = new Map<number, number>();
  return notes.map((note) => {
    const occurrence = (seen.get(note.targetItemId) || 0) + 1;
    seen.set(note.targetItemId, occurrence);
    return occurrence === 1
      ? `item:${note.targetItemId}`
      : `item:${note.targetItemId}#${occurrence}`;
  });
}

export function createWriteNotesBatchTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<WriteNotesBatchInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);
  const finalizer = new DirectDocumentFinalizer(zoteroGateway);

  function itemTitle(targetItemId: number): string {
    const item = zoteroGateway.getItem(targetItemId);
    return item
      ? String(item.getDisplayTitle?.() || `Item ${targetItemId}`)
      : `Item ${targetItemId}`;
  }

  /**
   * Freeze every body as its own durable document before the user is asked.
   *
   * Preparation, not execution, is where this belongs: the confirmation card
   * must preview the text that will actually be written, and the material has
   * to be frozen before approval for the approval to mean anything. It writes
   * nothing durable of its own, so a denied batch leaves no rows behind.
   *
   * Identical content in the same run keeps the identity it already
   * published, so preparing the same batch again mints no second copy.
   */
  async function prepareBatchMaterial(
    input: WriteNotesBatchInput,
    context: AgentToolContext,
  ): Promise<PreparedBatchItem[]> {
    if (input._items) return input._items;
    const runId = context.runId;
    if (!runId) throw new Error("The note batch has no run identity");
    const now = Date.now();
    const keys = batchItemKeys(input.operation.notes);
    const items: PreparedBatchItem[] = [];
    for (const [index, note] of input.operation.notes.entries()) {
      const base = {
        itemKey: keys[index],
        targetItemId: note.targetItemId,
      };
      try {
        const { document } = await finalizer.finalizeNoteBody({
          request: context.request,
          runId,
          title: itemTitle(note.targetItemId),
          markdown: note.content,
          now,
        });
        items.push({
          ...base,
          material: materialRefFromDocument(document),
          preview: previewOf(document.visibleMarkdown),
        });
      } catch (error) {
        // One body the host cannot finalize must not cost the other
        // forty-nine notes; this item is recorded failed and never written.
        items.push({
          ...base,
          preview: previewOf(note.content),
          failure: error instanceof Error ? error.message : String(error),
        });
      }
    }
    input._items = items;
    return items;
  }

  /**
   * The durable identity of this exact batch.
   *
   * A fresh id per call would orphan the rows of an interrupted attempt: they
   * would stay resumable for ever while the retry wrote every note again
   * under a new batch. Deriving it from the run and the frozen material means
   * a retry of the same work lands on the same rows.
   */
  async function batchIdentity(
    runId: string,
    items: readonly PreparedBatchItem[],
  ): Promise<string> {
    const canonical = JSON.stringify([
      runId,
      items.map((item) => [
        item.itemKey,
        item.material?.documentId ?? null,
        item.material?.documentVersion ?? null,
        item.material?.contentHash ?? null,
      ]),
    ]);
    return `batch-note_write_batch-${await sha256Text(canonical)}`;
  }

  /** Seeds the durable rows for an approved batch, reusing any it already has. */
  async function openBatch(
    input: WriteNotesBatchInput,
    context: AgentToolContext,
  ): Promise<AgentBatchBinding> {
    const items = await prepareBatchMaterial(input, context);
    const batchId = await batchIdentity(context.runId || "", items);
    const now = Date.now();
    if (!(await getBatchJob(batchId)))
      await createBatchJob({
        jobId: batchId,
        conversationKey: context.request.conversationKey,
        action: "note_write_batch",
        input: { target: input.operation.target },
        totalCount: items.length,
        now,
      });
    const rows: NewBatchItem[] = items.map((item, index) => ({
      itemKey: item.itemKey,
      position: index + 1,
      materialRef: item.material,
    }));
    await createBatchItems(batchId, rows, now);
    return {
      batchId,
      items: items.map((item) => ({
        itemKey: item.itemKey,
        targetItemId: item.targetItemId,
        material: item.material,
        failure: item.failure,
      })),
    };
  }

  return {
    spec: {
      name: "write_notes_batch",
      description:
        "Write a note onto each of many items in one approved operation. Use this instead of calling note_write once per paper — the user approves the whole set on a single card and can uncheck any of them.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["notes"],
        properties: {
          notes: {
            type: "array",
            description:
              "One entry per item. Write the actual note content for each — this tool does not generate it.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["targetItemId", "content"],
              properties: {
                targetItemId: {
                  type: "number",
                  description: "The item the note is attached to.",
                },
                content: {
                  type: "string",
                  description: "Note content, in Markdown.",
                },
                collections: {
                  type: "array",
                  items: { type: "number" },
                  description:
                    "Only for target:'standalone': collections to file the note into. A child note belongs to its parent and cannot be a collection member.",
                },
              },
            },
          },
          target: {
            type: "string",
            enum: ["item", "standalone"],
            default: "item",
            description:
              "'item' attaches each note to its target as a child note; 'standalone' creates free-standing notes.",
          },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Write Notes",
      summaries: {
        onCall: "Preparing notes",
        onPending: "Waiting for confirmation to write notes",
        onApproved: "Writing notes",
        onDenied: "Note writing cancelled",
        onSuccess: ({ content }) => {
          const outer =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const inner =
            outer.result && typeof outer.result === "object"
              ? (outer.result as Record<string, unknown>)
              : {};
          const innermost =
            inner.result && typeof inner.result === "object"
              ? (inner.result as Record<string, unknown>)
              : {};
          const created = Number(innermost.createdCount || 0);
          const failed = Number(innermost.failedCount || 0);
          if (!created) return "No notes written";
          return `Wrote ${created} note${created === 1 ? "" : "s"}${
            failed ? ` (${failed} failed)` : ""
          }`;
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with notes. Example: { notes: [{ targetItemId: 101, content: "## Summary\\n..." }] }',
        );
      }
      if (!Array.isArray(args.notes) || !args.notes.length) {
        return fail(
          "notes must be a non-empty array of { targetItemId, content }.",
        );
      }
      const notes: SaveNotesBatchOperation["notes"] = [];
      for (const raw of args.notes) {
        if (!validateObject<Record<string, unknown>>(raw)) continue;
        const targetItemId = normalizePositiveInt(raw.targetItemId);
        const content = typeof raw.content === "string" ? raw.content : "";
        if (!targetItemId || !content.trim()) continue;
        notes.push({
          targetItemId,
          content,
          collections: Array.isArray(raw.collections)
            ? (raw.collections
                .map((id) => normalizePositiveInt(id))
                .filter(Boolean) as number[])
            : undefined,
        });
      }
      if (!notes.length) {
        return fail(
          "Every note needs a targetItemId and non-empty content. Nothing valid was provided.",
        );
      }
      return ok({
        operation: {
          type: "save_notes_batch" as const,
          notes,
          target: args.target === "standalone" ? "standalone" : "item",
        },
      });
    },

    createPendingAction(input) {
      const notes = input.operation.notes;
      return {
        toolName: "write_notes_batch",
        title: `Write ${notes.length} note${notes.length === 1 ? "" : "s"}`,
        description: `Write a note onto ${notes.length} item${notes.length === 1 ? "" : "s"}. Uncheck any you do not want. This can be undone.`,
        confirmLabel: "Write notes",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "checklist" as const,
            id: NOTES_CHECKLIST_FIELD_ID,
            label: "Notes to write",
            items: notes.map((note, index) => ({
              id: `${note.targetItemId}`,
              label: itemTitle(note.targetItemId),
              // A preview matters here: the user is approving fifty pieces
              // of generated text at once, and an unreviewable card is
              // consent in name only. It shows the finalized text, which is
              // what the write will actually store.
              description:
                input._items?.[index]?.preview ?? previewOf(note.content),
              checked: true,
            })),
          },
        ],
      };
    },

    applyConfirmation(input, resolutionData) {
      const keep = normalizeChecklistItemIdsFromResolution(
        resolutionData,
        NOTES_CHECKLIST_FIELD_ID,
      );
      if (!keep) return ok(input);
      const kept = new Set(keep);
      const keptIndexes = input.operation.notes.flatMap((note, index) =>
        kept.has(note.targetItemId) ? [index] : [],
      );
      if (!keptIndexes.length) {
        return fail("Every note was unchecked, so there is nothing to write.");
      }
      // The prepared material is positional, so it is filtered with the notes
      // it describes rather than re-derived from the survivors.
      return ok({
        operation: {
          ...input.operation,
          notes: keptIndexes.map((index) => input.operation.notes[index]),
        },
        ...(input._items
          ? { _items: keptIndexes.map((index) => input._items![index]) }
          : {}),
      });
    },

    async planInvocation(input, context) {
      await prepareBatchMaterial(input, context);
      return planLibraryMutations(mutationService, [input.operation], context);
    },

    describeAction: (input) =>
      describeLibraryMutationActions(input).map((descriptor) => ({
        ...descriptor,
        parameters: {
          ...descriptor.parameters,
          // The proposal names the exact material each item will write, so
          // approval is bound to it and not to text that could still change.
          materialRefs: (input._items || []).flatMap((item) =>
            item.material ? [item.material] : [],
          ),
        },
      })),

    async execute(input, context) {
      const batchBinding = await openBatch(input, context);
      const result = await executeAndRecordUndo(
        mutationService,
        input.operation,
        { ...context, batchBinding },
        "write_notes_batch",
      );
      const batchItems = await readBatchOutcomes(batchBinding.batchId);
      // The rows are the authority on what still needs writing, so the job is
      // closed only once every item of it has landed. A throw above leaves it
      // open on purpose: the startup sweep will mark it interrupted and its
      // pending rows stay resumable.
      await finishBatchJob({
        jobId: batchBinding.batchId,
        status: batchItems.every((item) => item.status === "saved")
          ? "completed"
          : "failed",
        now: Date.now(),
      });
      return { ...result, batchItems };
    },
  };
}

/** What the host announces for each item, read back from the durable rows. */
async function readBatchOutcomes(
  batchId: string,
): Promise<AgentBatchItemOutcome[]> {
  return (await listBatchItems(batchId)).map((row) => ({
    batchId: row.batchId,
    itemKey: row.itemKey,
    materialRef: row.materialRef,
    status: row.status,
    ...(row.noteId === undefined ? {} : { noteId: row.noteId }),
    ...(row.error === undefined ? {} : { error: row.error }),
  }));
}

function previewOf(content: string): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  return flattened.length > 160 ? `${flattened.slice(0, 160)}…` : flattened;
}
