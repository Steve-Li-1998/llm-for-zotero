import type { MaterialRef } from "../documents/types";
import { loadMaterialRef } from "../documents/workflowMaterial";
import { getAgentRunTrace } from "../store/traceStore";
import type {
  AgentExecutionContext,
  AgentRuntimeRequest,
  AgentRunEventRecord,
} from "../types";
import type { ExecutionTaskStatus } from "../plans/types";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
  ExecutionCheckpointTaskUpdate,
  ExecutionEvidenceInventory,
} from "./types";

export type {
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
  ExecutionCheckpointTaskUpdate,
  ExecutionEvidenceInventory,
} from "./types";

const ORDINARY_ALLOWED_TRANSITIONS: Record<
  ExecutionTaskStatus,
  readonly ExecutionTaskStatus[]
> = {
  pending: ["in_progress", "completed", "cancelled", "skipped"],
  in_progress: [
    "waiting_for_user",
    "interrupted",
    "completed",
    "blocked",
    "failed",
    "skipped",
    "cancelled",
  ],
  waiting_for_user: ["in_progress", "blocked", "skipped", "cancelled"],
  interrupted: ["in_progress", "completed", "failed", "cancelled"],
  completed: [],
  blocked: ["in_progress", "failed", "cancelled"],
  failed: ["in_progress", "cancelled"],
  skipped: [],
  cancelled: [],
};

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (values || []).map((value) => requiredText(value, "Evidence identity")),
    ),
  ];
}

export function materialRefKey(reference: MaterialRef): string {
  return `${requiredText(reference.documentId, "Material document ID")}:${reference.documentVersion}:${requiredText(reference.contentHash, "Material content hash")}`;
}

export function ordinaryExecutionTaskId(
  executionId: string,
  modelTaskId: string,
): string {
  const owner = requiredText(executionId, "Execution ID");
  const raw = requiredText(modelTaskId, "Task ID");
  const prefix = `${owner}:task:`;
  const local = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(local)) {
    throw new Error(
      "Task IDs must use 1-128 letters, numbers, dots, underscores, or hyphens",
    );
  }
  return `${prefix}${local}`;
}

export function createEmptyExecutionCheckpoint(
  context: AgentExecutionContext,
  now = Date.now(),
): ExecutionCheckpoint {
  return {
    version: 1,
    executionId: context.executionId,
    conversationKey: context.conversationKey,
    conversationGeneration: context.conversationGeneration,
    tasks: [],
    createdAt: now,
    updatedAt: now,
  };
}

function assertCheckpointOwner(
  checkpoint: ExecutionCheckpoint,
  context?: AgentExecutionContext,
): void {
  if (!context) return;
  if (
    checkpoint.executionId !== context.executionId ||
    checkpoint.conversationKey !== context.conversationKey ||
    checkpoint.conversationGeneration !== context.conversationGeneration
  ) {
    throw new Error("Execution checkpoint belongs to another execution");
  }
}

function assertKnownReferences(
  update: ExecutionCheckpointTaskUpdate,
  inventory: ExecutionEvidenceInventory,
): void {
  const groups: Array<
    readonly [readonly string[] | undefined, ReadonlySet<string>, string]
  > = [
    [update.journalActionIds, inventory.journalActionIds, "journal action"],
    [
      update.verifiedReceiptIds,
      inventory.verifiedReceiptIds,
      "verified receipt",
    ],
    [update.readEvidenceIds, inventory.readEvidenceIds, "read evidence"],
  ];
  for (const [values, known, label] of groups) {
    for (const value of uniqueStrings(values)) {
      if (!known.has(value)) {
        throw new Error(`${label} ${value} is not host-verified`);
      }
    }
  }
  for (const reference of update.materialRefs || []) {
    const key = materialRefKey(reference);
    if (!inventory.materialRefs.has(key)) {
      throw new Error(`Material reference ${key} is not host-verified`);
    }
  }
}

function assertAcyclic(tasks: readonly ExecutionCheckpointTask[]): void {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId))
      throw new Error("Task dependencies contain a cycle");
    const task = byId.get(taskId);
    if (!task) throw new Error(`Unknown task dependency: ${taskId}`);
    visiting.add(taskId);
    for (const dependency of task.dependencies) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.taskId);
}

function hasCompletionEvidence(task: ExecutionCheckpointTask): boolean {
  return Boolean(
    task.verifiedReceiptIds.length ||
    task.readEvidenceIds.length ||
    task.materialRefs.length,
  );
}

export function applyExecutionCheckpointUpdates(params: {
  checkpoint: ExecutionCheckpoint;
  updates: readonly ExecutionCheckpointTaskUpdate[];
  evidence: ExecutionEvidenceInventory;
  context?: AgentExecutionContext;
  now?: number;
}): ExecutionCheckpoint {
  const { checkpoint } = params;
  assertCheckpointOwner(checkpoint, params.context);
  if (checkpoint.version !== 1) {
    throw new Error("Unsupported execution checkpoint version");
  }
  if (!params.updates.length)
    throw new Error("At least one task update is required");
  const now = params.now ?? Date.now();
  const taskIds = params.updates.map((update) =>
    ordinaryExecutionTaskId(checkpoint.executionId, update.taskId),
  );
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error("A task may appear only once in one batch update");
  }
  for (const update of params.updates) {
    assertKnownReferences(update, params.evidence);
  }

  const tasks: ExecutionCheckpointTask[] = checkpoint.tasks.map((task) => ({
    ...task,
    dependencies: [...task.dependencies],
    journalActionIds: [...task.journalActionIds],
    verifiedReceiptIds: [...task.verifiedReceiptIds],
    readEvidenceIds: [...task.readEvidenceIds],
    materialRefs: task.materialRefs.map((reference) => ({ ...reference })),
  }));
  const byId = new Map(tasks.map((task) => [task.taskId, task]));

  for (const [index, update] of params.updates.entries()) {
    const taskId = taskIds[index];
    const existing = byId.get(taskId);
    const dependencies = (
      update.dependencies ||
      existing?.dependencies ||
      []
    ).map((dependency) =>
      ordinaryExecutionTaskId(checkpoint.executionId, dependency),
    );
    if (dependencies.includes(taskId)) {
      throw new Error(`Task ${taskId} cannot depend on itself`);
    }
    const description = update.description?.trim() || existing?.description;
    if (!description) {
      throw new Error(`New task ${taskId} requires a description`);
    }
    if (
      existing &&
      update.description !== undefined &&
      description !== existing.description
    ) {
      throw new Error(`Existing task ${taskId} has immutable presentation`);
    }
    if (
      existing &&
      update.dependencies !== undefined &&
      JSON.stringify(dependencies) !== JSON.stringify(existing.dependencies)
    ) {
      throw new Error(`Existing task ${taskId} has immutable dependencies`);
    }
    if (
      !existing &&
      !["pending", "in_progress", "completed"].includes(update.status)
    ) {
      throw new Error(
        "New ordinary tasks must start pending, in progress, or completed with evidence",
      );
    }
    if (
      existing &&
      existing.status !== update.status &&
      !ORDINARY_ALLOWED_TRANSITIONS[existing.status].includes(update.status)
    ) {
      throw new Error(
        `Invalid ordinary task transition: ${existing.status} -> ${update.status}`,
      );
    }

    const materialRefs = new Map(
      (existing?.materialRefs || []).map((reference) => [
        materialRefKey(reference),
        reference,
      ]),
    );
    for (const reference of update.materialRefs || []) {
      materialRefs.set(materialRefKey(reference), { ...reference });
    }
    const next: ExecutionCheckpointTask = {
      taskId,
      description,
      dependencies: [...new Set(dependencies)],
      status: update.status,
      journalActionIds: [
        ...new Set([
          ...(existing?.journalActionIds || []),
          ...uniqueStrings(update.journalActionIds),
        ]),
      ],
      verifiedReceiptIds: [
        ...new Set([
          ...(existing?.verifiedReceiptIds || []),
          ...uniqueStrings(update.verifiedReceiptIds),
        ]),
      ],
      readEvidenceIds: [
        ...new Set([
          ...(existing?.readEvidenceIds || []),
          ...uniqueStrings(update.readEvidenceIds),
        ]),
      ],
      materialRefs: [...materialRefs.values()],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (next.status === "completed" && !hasCompletionEvidence(next)) {
      throw new Error(
        `Task ${taskId} requires host-verified evidence before completion`,
      );
    }
    if (existing)
      tasks[tasks.findIndex((task) => task.taskId === taskId)] = next;
    else tasks.push(next);
    byId.set(taskId, next);
  }

  assertAcyclic(tasks);
  for (const task of tasks) {
    if (!["in_progress", "completed"].includes(task.status)) continue;
    const unresolved = task.dependencies.filter(
      (dependency) => byId.get(dependency)?.status !== "completed",
    );
    if (unresolved.length) {
      throw new Error(
        `Task ${task.taskId} has incomplete dependencies: ${unresolved.join(", ")}`,
      );
    }
  }
  if (tasks.filter((task) => task.status === "in_progress").length > 1) {
    throw new Error("Only one ordinary task may be in progress");
  }

  return {
    ...checkpoint,
    tasks,
    updatedAt: now,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseMaterialRef(value: unknown): MaterialRef | null {
  const candidate = record(value);
  if (
    !candidate ||
    typeof candidate.documentId !== "string" ||
    !Number.isSafeInteger(candidate.documentVersion) ||
    Number(candidate.documentVersion) < 1 ||
    typeof candidate.contentHash !== "string"
  ) {
    return null;
  }
  return {
    documentId: candidate.documentId,
    documentVersion: Number(candidate.documentVersion),
    contentHash: candidate.contentHash,
  };
}

/** Build the evidence namespace exclusively from host-persisted tool results. */
export async function loadExecutionEvidenceForRun(
  runId: string,
  request: AgentRuntimeRequest,
): Promise<ExecutionEvidenceInventory> {
  const journalActionIds = new Set<string>();
  const verifiedReceiptIds = new Set<string>();
  const readEvidenceIds = new Set(
    (request.documentReadObservations || []).map(
      (entry) => entry.observationId,
    ),
  );
  const materialRefs = new Map<string, MaterialRef>();
  const trace = await getAgentRunTrace(runId);
  for (const event of trace.events as readonly AgentRunEventRecord[]) {
    if (event.payload.type !== "tool_result" || !event.payload.ok) continue;
    for (const receipt of event.payload.actionReceipts || []) {
      if (
        receipt.verification === "verified" &&
        ["applied", "already_satisfied", "observed"].includes(receipt.status)
      ) {
        verifiedReceiptIds.add(receipt.id);
      }
    }
    const content = record(event.payload.content);
    const actionId =
      typeof content?.actionId === "string" ? content.actionId.trim() : "";
    if (actionId) journalActionIds.add(actionId);
    if (Array.isArray(content?.actionIds)) {
      for (const value of content.actionIds) {
        if (typeof value === "string" && value.trim()) {
          journalActionIds.add(value.trim());
        }
      }
    }
    const materialRef = parseMaterialRef(content?.materialRef);
    if (materialRef) {
      const stored = await loadMaterialRef(
        materialRef,
        request.conversationKey,
      );
      if (stored) materialRefs.set(materialRefKey(materialRef), materialRef);
    }
  }
  return {
    journalActionIds,
    verifiedReceiptIds,
    readEvidenceIds,
    materialRefs,
  };
}

export function latestExecutionCheckpoint(
  events: readonly AgentRunEventRecord[],
): ExecutionCheckpoint | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index].payload;
    if (event.type === "execution_checkpoint") return event.checkpoint;
  }
  return undefined;
}
