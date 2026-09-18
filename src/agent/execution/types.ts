import type { MaterialRef } from "../documents/materialRef";
import type { ExecutionTaskStatus } from "../plans/types";

export type ExecutionCheckpointTask = Readonly<{
  taskId: string;
  description: string;
  dependencies: readonly string[];
  status: ExecutionTaskStatus;
  journalActionIds: readonly string[];
  verifiedReceiptIds: readonly string[];
  readEvidenceIds: readonly string[];
  materialRefs: readonly MaterialRef[];
  createdAt: number;
  updatedAt: number;
}>;

/**
 * Durable progress for ordinary agent work.
 *
 * The checkpoint contains identities only.
 * Journal payloads, native receipts, read observations, and document bodies remain in their existing stores.
 * Nothing in this record grants permission to execute an effect.
 */
export type ExecutionCheckpoint = Readonly<{
  version: 1;
  executionId: string;
  conversationKey: number;
  conversationGeneration: number;
  tasks: readonly ExecutionCheckpointTask[];
  createdAt: number;
  updatedAt: number;
}>;

export type ExecutionEvidenceInventory = Readonly<{
  journalActionIds: ReadonlySet<string>;
  verifiedReceiptIds: ReadonlySet<string>;
  readEvidenceIds: ReadonlySet<string>;
  materialRefs: ReadonlyMap<string, MaterialRef>;
}>;

/**
 * What happened to one finalized material revision, so far.
 *
 * `finalized` means the material exists and no verified note write has claimed
 * it yet; `write_failed` means a note write for that document failed; `saved`
 * means a verified receipt named this exact `MaterialRef`.
 */
export type MaterialOutcomeStatus = "finalized" | "saved" | "write_failed";

export type MaterialOutcomeEntry = Readonly<{
  materialRef: MaterialRef;
  materialKind?: string;
  materialTitle?: string;
  /** The run that finalized this revision. */
  runId: string;
  status: MaterialOutcomeStatus;
  /** Journal action of the write that closed the entry, when one did. */
  actionId?: string;
  /** Receipt that proved the save, when one did. */
  receiptId?: string;
}>;

export type DroppedMaterialOutcome = Readonly<{
  documentId: string;
  runId: string;
  reason: string;
}>;

/** Material outcomes for one conversation, newest finalization first. */
export type MaterialOutcomeLedger = Readonly<{
  entries: readonly MaterialOutcomeEntry[];
  dropped: readonly DroppedMaterialOutcome[];
}>;

export type ExecutionCheckpointTaskUpdate = Readonly<{
  taskId: string;
  description?: string;
  dependencies?: readonly string[];
  status: ExecutionTaskStatus;
  reason?: string;
  journalActionIds?: readonly string[];
  verifiedReceiptIds?: readonly string[];
  readEvidenceIds?: readonly string[];
  materialRefs?: readonly MaterialRef[];
}>;
