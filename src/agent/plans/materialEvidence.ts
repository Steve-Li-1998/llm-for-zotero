import type { AgentRuntimeRequest } from "../types";
import type { PlanDocument } from "../documents/types";
import { loadPlanExecutionLedger } from "./store";
import { planExecutionCoordinator } from "./coordinator";
import type { ExecutionTask, TaskEvidence } from "./types";

export function buildPlanMaterialEvidence(
  task: ExecutionTask,
  document: PlanDocument,
  now = Date.now(),
): TaskEvidence | undefined {
  const requirement = task.completionRequirements?.find(
    (entry) => entry.kind === "material_integrity",
  );
  if (!requirement) return undefined;
  if (!task.materialOutputId || !document.validation.integrityValidated)
    throw new Error("The approved material identity or integrity is missing");
  return {
    version: 3,
    evidenceId: `${task.executionId}:${task.taskId}:${document.documentId}:material`,
    executionId: task.executionId,
    taskId: task.taskId,
    kind: "material_integrity",
    verified: true,
    requirementId: requirement.requirementId,
    criterionIds: requirement.criterionIds,
    contractDigest: requirement.contractDigest,
    payload: {
      type: "material_integrity",
      materialOutputId: task.materialOutputId,
      documentId: document.documentId,
      documentVersion: document.documentVersion,
      contentHash: document.contentHash,
      integrityValidated: true,
    },
    reference: document.contentHash,
    summary:
      "The exact approved material passed integrity validation and was stored",
    createdAt: now,
  };
}

/** A generated intermediate artifact is verified before any action saves it. */
export async function requirePlanMaterialTask(
  request: AgentRuntimeRequest,
  outputId: string,
) {
  const plan = request.planContext;
  if (plan?.phase !== "executing") return undefined;
  const ledger = await loadPlanExecutionLedger(plan.executionId);
  const task = ledger?.tasks.find(
    (entry) => entry.taskId === ledger.activeTaskId,
  );
  const requirement = task?.completionRequirements?.find(
    (entry) => entry.kind === "material_integrity",
  );
  if (
    !task ||
    task.status !== "in_progress" ||
    task.materialOutputId !== outputId ||
    !requirement
  )
    throw new Error(
      `Start the approved artifact step for materialOutputId '${outputId}' before generating it.`,
    );
  return { ledger: ledger!, task, requirement };
}

export async function attachPlanMaterialEvidence(
  request: AgentRuntimeRequest,
  outputId: string,
  document: PlanDocument,
): Promise<void> {
  const active = await requirePlanMaterialTask(request, outputId);
  if (!active) return;
  if (
    !document.validation.integrityValidated ||
    document.conversationKey !== request.conversationKey
  )
    throw new Error(
      "The stored workflow material has not passed integrity validation",
    );
  await planExecutionCoordinator.attachEvidence(
    buildPlanMaterialEvidence(active.task, document)!,
  );
}
