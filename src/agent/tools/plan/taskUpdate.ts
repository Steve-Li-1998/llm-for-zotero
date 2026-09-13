import type {
  AgentToolDefinition,
  AgentToolInputValidation,
  ExecutionTaskStatus,
} from "../../types";
import type { MaterialRef } from "../../documents/materialRef";
import { planExecutionCoordinator } from "../../plans/coordinator";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { listTaskEvidence } from "../../plans/store";
import { planRequiresModelTaskUpdates } from "../../plans/taskOwnership";
import type {
  ExecutionTask,
  PlanAcceptanceCriterion,
  PlanCompletionRequirementKind,
  PlanExecutionLedger,
  TaskEvidence,
  TaskTransitionRequest,
} from "../../plans/types";
import { fail, ok, validateObject } from "../shared";
import {
  applyExecutionCheckpointUpdates,
  createEmptyExecutionCheckpoint,
  loadExecutionEvidenceForRun,
  type ExecutionCheckpointTaskUpdate,
} from "../../execution/checkpoint";

type TaskUpdateRequest = {
  taskId: string;
  status: ExecutionTaskStatus;
  description?: string;
  dependencies?: string[];
  parentTaskId?: string;
  content?: string;
  activeForm?: string;
  acceptanceCriteria?: PlanAcceptanceCriterion[];
  expectedEffect?: "read" | "artifact" | "mutation" | "reasoning";
  expectedCapability?: string;
  targetIds?: string[];
  reason?: string;
  reasoningAssertion?: string;
  journalActionIds?: string[];
  verifiedReceiptIds?: string[];
  readEvidenceIds?: string[];
  materialRefs?: MaterialRef[];
};

type TaskUpdateInput = {
  /** Compatible shorthand for one transition. */
  task?: TaskUpdateRequest;
  /** Atomic batch form used by ordinary tracked work and Plan transitions. */
  tasks: TaskUpdateRequest[];
};

const STATUSES = new Set<ExecutionTaskStatus>([
  "pending",
  "in_progress",
  "waiting_for_user",
  "interrupted",
  "completed",
  "blocked",
  "failed",
  "skipped",
  "cancelled",
]);
const VERIFIERS = new Set<PlanCompletionRequirementKind>([
  "verified_read",
  "research_coverage",
  "document_integrity",
  "document_published",
  "mutation_receipts",
  "bounded_reasoning",
  "user_decision",
]);

const MATERIAL_REF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["documentId", "documentVersion", "contentHash"],
  properties: {
    documentId: { type: "string" },
    documentVersion: { type: "integer", minimum: 1 },
    contentHash: { type: "string" },
  },
} as const;

const TASK_UPDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "status"],
  properties: {
    taskId: { type: "string" },
    status: { type: "string", enum: Array.from(STATUSES) },
    description: {
      type: "string",
      description: "Required when creating an ordinary tracked task.",
    },
    dependencies: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
    reasoningAssertion: {
      type: "string",
      description:
        "Required when completing an approved bounded-reasoning Plan task.",
    },
    parentTaskId: { type: "string" },
    content: { type: "string" },
    activeForm: { type: "string" },
    acceptanceCriteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterionId", "description", "verifier"],
        properties: {
          criterionId: { type: "string" },
          description: { type: "string" },
          verifier: {
            type: "string",
            enum: Array.from(VERIFIERS),
          },
        },
      },
    },
    expectedEffect: {
      type: "string",
      enum: ["read", "artifact", "mutation", "reasoning"],
    },
    expectedCapability: { type: "string" },
    targetIds: { type: "array", items: { type: "string" } },
    journalActionIds: { type: "array", items: { type: "string" } },
    verifiedReceiptIds: { type: "array", items: { type: "string" } },
    readEvidenceIds: { type: "array", items: { type: "string" } },
    materialRefs: { type: "array", items: MATERIAL_REF_SCHEMA },
  },
} as const;

function stringList(
  value: unknown,
  label: string,
): AgentToolInputValidation<string[] | undefined> {
  if (value === undefined) return ok(undefined);
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    return fail(`${label} must be an array of non-empty strings`);
  }
  return ok([...new Set(value.map((entry) => entry.trim()))]);
}

function parseMaterialRefs(
  value: unknown,
): AgentToolInputValidation<MaterialRef[] | undefined> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value)) return fail("materialRefs must be an array");
  const refs: MaterialRef[] = [];
  for (const [index, entry] of value.entries()) {
    if (!validateObject<Record<string, unknown>>(entry)) {
      return fail(`materialRefs[${index}] must be an object`);
    }
    const documentId =
      typeof entry.documentId === "string" ? entry.documentId.trim() : "";
    const contentHash =
      typeof entry.contentHash === "string" ? entry.contentHash.trim() : "";
    const documentVersion = Number(entry.documentVersion);
    if (
      !documentId ||
      !contentHash ||
      !Number.isSafeInteger(documentVersion) ||
      documentVersion < 1
    ) {
      return fail(`materialRefs[${index}] has an invalid immutable identity`);
    }
    refs.push({ documentId, documentVersion, contentHash });
  }
  return ok(refs);
}

function parseTaskUpdate(
  raw: unknown,
  label: string,
): AgentToolInputValidation<TaskUpdateRequest> {
  if (!validateObject<Record<string, unknown>>(raw)) {
    return fail(`${label} must be an object`);
  }
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  const status = raw.status as ExecutionTaskStatus;
  if (!taskId || !STATUSES.has(status)) {
    return fail(`${label} has an invalid identity/status`);
  }
  const acceptanceCriteria = Array.isArray(raw.acceptanceCriteria)
    ? raw.acceptanceCriteria.flatMap((value) => {
        if (!validateObject<Record<string, unknown>>(value)) return [];
        const criterionId =
          typeof value.criterionId === "string" ? value.criterionId.trim() : "";
        const description =
          typeof value.description === "string" ? value.description.trim() : "";
        const verifier = value.verifier as PlanCompletionRequirementKind;
        return criterionId && description && VERIFIERS.has(verifier)
          ? [{ criterionId, description, verifier }]
          : [];
      })
    : undefined;
  if (
    Array.isArray(raw.acceptanceCriteria) &&
    acceptanceCriteria?.length !== raw.acceptanceCriteria.length
  ) {
    return fail(`${label}.acceptanceCriteria is invalid`);
  }
  if (
    raw.expectedEffect !== undefined &&
    !["read", "artifact", "mutation", "reasoning"].includes(
      String(raw.expectedEffect),
    )
  ) {
    return fail(`${label}.expectedEffect is invalid`);
  }
  const dependencies = stringList(raw.dependencies, `${label}.dependencies`);
  if (!dependencies.ok) return dependencies;
  const journalActionIds = stringList(
    raw.journalActionIds,
    `${label}.journalActionIds`,
  );
  if (!journalActionIds.ok) return journalActionIds;
  const verifiedReceiptIds = stringList(
    raw.verifiedReceiptIds,
    `${label}.verifiedReceiptIds`,
  );
  if (!verifiedReceiptIds.ok) return verifiedReceiptIds;
  const readEvidenceIds = stringList(
    raw.readEvidenceIds,
    `${label}.readEvidenceIds`,
  );
  if (!readEvidenceIds.ok) return readEvidenceIds;
  const materialRefs = parseMaterialRefs(raw.materialRefs);
  if (!materialRefs.ok) return materialRefs;
  return ok({
    taskId,
    status,
    description:
      typeof raw.description === "string"
        ? raw.description.trim() || undefined
        : undefined,
    dependencies: dependencies.value,
    reason:
      typeof raw.reason === "string" && raw.reason.trim()
        ? raw.reason.trim()
        : undefined,
    reasoningAssertion:
      typeof raw.reasoningAssertion === "string" &&
      raw.reasoningAssertion.trim()
        ? raw.reasoningAssertion.trim()
        : undefined,
    parentTaskId:
      typeof raw.parentTaskId === "string"
        ? raw.parentTaskId.trim() || undefined
        : undefined,
    content:
      typeof raw.content === "string"
        ? raw.content.trim() || undefined
        : undefined,
    activeForm:
      typeof raw.activeForm === "string"
        ? raw.activeForm.trim() || undefined
        : undefined,
    acceptanceCriteria,
    expectedEffect: raw.expectedEffect as TaskUpdateRequest["expectedEffect"],
    expectedCapability:
      typeof raw.expectedCapability === "string"
        ? raw.expectedCapability.trim() || undefined
        : undefined,
    targetIds: Array.isArray(raw.targetIds)
      ? raw.targetIds.map(String).filter(Boolean)
      : undefined,
    journalActionIds: journalActionIds.value,
    verifiedReceiptIds: verifiedReceiptIds.value,
    readEvidenceIds: readEvidenceIds.value,
    materialRefs: materialRefs.value,
  });
}

export function validateTaskUpdateInput(
  args: unknown,
): AgentToolInputValidation<TaskUpdateInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("task_update expects an object");
  }
  const hasTask = args.task !== undefined;
  const hasTasks = args.tasks !== undefined;
  if (hasTask === hasTasks) {
    return fail("task_update requires exactly one of task or tasks");
  }
  if (hasTask) {
    const parsed = parseTaskUpdate(args.task, "task_update.task");
    return parsed.ok
      ? ok({ task: parsed.value, tasks: [parsed.value] })
      : parsed;
  }
  if (!Array.isArray(args.tasks) || !args.tasks.length) {
    return fail("task_update.tasks must be a non-empty array");
  }
  const tasks: TaskUpdateRequest[] = [];
  for (const [index, raw] of args.tasks.entries()) {
    const parsed = parseTaskUpdate(raw, `task_update.tasks[${index}]`);
    if (!parsed.ok) return parsed;
    tasks.push(parsed.value);
  }
  return ok({ tasks });
}

export function buildReasoningAssertionEvidence(params: {
  executionId: string;
  task: ExecutionTask;
  status: ExecutionTaskStatus;
  assertion?: string;
  createdAt?: number;
}): TaskEvidence | undefined {
  const assertion = params.assertion?.trim();
  if (!assertion) return undefined;
  const requirement = params.task.completionRequirements?.find(
    (entry) => entry.kind === "bounded_reasoning",
  );
  if (!requirement) {
    // Extra narrative is not evidence for a host-verifiable task. Ignore it
    // and let the normal completion verifier require the real receipts.
    return undefined;
  }
  if (params.status !== "completed") {
    throw new Error(
      "A reasoning assertion must accompany a completed transition",
    );
  }
  const createdAt = params.createdAt ?? Date.now();
  return {
    version: 3,
    evidenceId: `${params.executionId}:${params.task.taskId}:reasoning:${createdAt}`,
    executionId: params.executionId,
    taskId: params.task.taskId,
    kind: "reasoning_assertion",
    verified: true,
    requirementId: requirement.requirementId,
    criterionIds: requirement.criterionIds,
    contractDigest: requirement.contractDigest,
    payload: {
      type: "bounded_reasoning",
      assertion,
    },
    summary: assertion,
    createdAt,
  };
}

export function createTaskUpdateTool(): AgentToolDefinition<
  TaskUpdateInput,
  unknown
> {
  return {
    spec: {
      name: "task_update",
      description:
        "Create or update progress for compound work. Use task as a compatible single-update shorthand or tasks to commit a related batch atomically. Ordinary tasks use a short stable taskId, description, optional dependencies, and host-issued evidence identities. Approved Plan tasks accept immutable IDs and status transitions only.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: TASK_UPDATE_SCHEMA,
          tasks: {
            type: "array",
            minItems: 1,
            items: TASK_UPDATE_SCHEMA,
          },
        },
      },
      executionClass: "control",
      workCategory: "planning",
    },
    /**
     * The plan machinery itself. Its calls are how a plan is drafted and
     * advanced, and the plan card already shows the reader the outcome, so a
     * row for each of them would report the trace's own plumbing.
     */
    presentation: { hiddenInTrace: true },
    isAvailable: (request) => {
      if (request.planContext?.phase !== "executing") {
        return request.executionContext?.permissionOwner === "original_agent";
      }
      const ledger = request.metadata?.planExecutionLedger as
        | PlanExecutionLedger
        | null
        | undefined;
      return !ledger || planRequiresModelTaskUpdates(ledger);
    },
    guidance: {
      matches: (request) => {
        if (request.planContext?.phase !== "executing") return false;
        const ledger = request.metadata?.planExecutionLedger as
          | PlanExecutionLedger
          | null
          | undefined;
        return !ledger || planRequiresModelTaskUpdates(ledger);
      },
      instruction:
        "Execute the approved plan in order. The host owns the authoritative immutable task ledger. Never call task_update for research or document tasks whose requirements are only verified_read, material_integrity, mutation_receipts, research_coverage, document_integrity, or document_published; their owning tools advance them automatically. For other active tasks, use task as a single-transition shorthand or tasks for an atomic related batch, with only each immutable taskId, status, optional reason, and required reasoningAssertion. A completed request is rejected unless receipts or verified evidence satisfy the task; after completion the host starts the next pending task. Never rename, create, delete, reorder, or silently skip an approved task.",
    },
    validate: validateTaskUpdateInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "This host-owned control updates only task progress in the active workflow.",
      }),
    execute: async (input, context) => {
      const plan = context.request.planContext;
      if (!plan || plan.phase !== "executing") {
        const execution = context.request.executionContext;
        if (execution?.permissionOwner !== "original_agent") {
          throw new Error(
            "task_update requires an ordinary Original Agent execution or an approved Plan",
          );
        }
        if (!context.runId || !context.publishExecutionCheckpoint) {
          throw new Error(
            "Ordinary task progress requires durable run checkpoint persistence",
          );
        }
        const checkpoint =
          context.request.executionCheckpoint ||
          createEmptyExecutionCheckpoint(execution);
        const inventory = context.loadExecutionEvidence
          ? await context.loadExecutionEvidence()
          : await loadExecutionEvidenceForRun(context.runId, context.request);
        const updates: ExecutionCheckpointTaskUpdate[] = input.tasks.map(
          (request) => ({
            taskId: request.taskId,
            description: request.description,
            dependencies: request.dependencies,
            status: request.status,
            reason: request.reason,
            journalActionIds: request.journalActionIds,
            verifiedReceiptIds: request.verifiedReceiptIds,
            readEvidenceIds: request.readEvidenceIds,
            materialRefs: request.materialRefs,
          }),
        );
        const updated = applyExecutionCheckpointUpdates({
          checkpoint,
          updates,
          evidence: inventory,
          context: execution,
        });
        await context.publishExecutionCheckpoint(updated);
        context.request.executionCheckpoint = updated;
        return { checkpoint: updated };
      }
      if (
        input.tasks.some((request) =>
          Boolean(
            request.description ||
            request.dependencies?.length ||
            request.parentTaskId ||
            request.content ||
            request.activeForm ||
            request.acceptanceCriteria?.length ||
            request.expectedEffect ||
            request.expectedCapability ||
            request.targetIds?.length ||
            request.journalActionIds?.length ||
            request.verifiedReceiptIds?.length ||
            request.readEvidenceIds?.length ||
            request.materialRefs?.length,
          ),
        )
      ) {
        throw new Error(
          "Approved Plan tasks are immutable; task_update accepts only taskId, status, reason, and bounded reasoning evidence",
        );
      }
      let ledger = await planExecutionCoordinator.startNextTask(
        plan.executionId,
      );
      const transitions: Array<{
        request: TaskTransitionRequest;
        evidence?: TaskEvidence;
      }> = [];
      for (const request of input.tasks) {
        const current = ledger.tasks.find(
          (task) => task.taskId === request.taskId,
        );
        if (!current) throw new Error(`Unknown Plan taskId: ${request.taskId}`);
        if (current.status === request.status) {
          throw new Error(
            `Task ${request.taskId} is already ${request.status}; task_update requires a status transition`,
          );
        }
        const evidence = buildReasoningAssertionEvidence({
          executionId: plan.executionId,
          task: current,
          status: request.status,
          assertion: request.reasoningAssertion,
        });
        const requestedBy =
          request.status === "skipped" && current.expectedEffect === "mutation"
            ? (await listTaskEvidence(plan.executionId, request.taskId)).some(
                (entry) =>
                  entry.verified &&
                  entry.kind === "validation" &&
                  entry.reference?.startsWith("user-declined:"),
              )
              ? "user"
              : plan.provider
            : plan.provider;
        transitions.push({
          request: {
            executionId: plan.executionId,
            taskId: request.taskId,
            toStatus: request.status,
            reason: request.reason,
            requestedBy,
          },
          evidence,
        });
      }
      ledger =
        await planExecutionCoordinator.requestTransitionBatch(transitions);
      if (ledger.status === "running" || ledger.status === "pending") {
        ledger = await planExecutionCoordinator.startNextTask(plan.executionId);
      }
      await context.publishPlanEvent?.({
        type: "plan_execution_updated",
        ledger,
      });
      return { ledger };
    },
  };
}
