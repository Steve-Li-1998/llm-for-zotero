import type { MaterialRef } from "../documents/types";
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
