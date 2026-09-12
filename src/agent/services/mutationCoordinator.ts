import {
  executeJournaledStep,
  runIdFor,
  MutationMayHaveAppliedError,
  getActiveJournalActionId,
  withActiveJournalAction,
  type JournalActionSeed,
  type MutationStepPlan,
} from "./externalMutationCoordinator";
import type {
  AgentJournalActionScope,
  AgentJournalStepOutcome,
  AgentActionEvidence,
  AgentToolContext,
  AgentToolEffect,
  AgentWriteToolOutput,
} from "../types";
import {
  claimJournalAction,
  claimJournalStep,
  createJournalId,
  isAgentChangeJournalAvailable,
  prepareJournalAction,
  prepareJournalStep,
  registerJournalRecoveryPayloads,
  updateJournalAction,
  updateJournalStep,
  type JournalReversibility,
} from "../store/changeJournal";
import type {
  LibraryMutationExecutionResult,
  LibraryMutationOperation,
  LibraryMutationService,
} from "./libraryMutationService";
import { mutationPostconditionIsSatisfied } from "./libraryMutation/handlerOperations";

export type CoordinatedMutationResult = {
  actionId?: string;
  effect: AgentToolEffect;
  affectedCount: number;
  results: LibraryMutationExecutionResult[];
  actionEvidence: AgentActionEvidence[];
};

function inversePayload(operations: LibraryMutationOperation[] | undefined) {
  return operations?.length
    ? { version: 1, kind: "library_operations", operations }
    : undefined;
}

function combineReversibility(
  values: JournalReversibility[],
): JournalReversibility {
  if (!values.length || values.every((value) => value === "full")) {
    return "full";
  }
  if (values.every((value) => value === "none")) return "none";
  return "partial";
}

function combineEffects(values: AgentToolEffect[]): AgentToolEffect {
  if (!values.length || values.every((value) => value === "none")) {
    return "none";
  }
  return values.every((value) => value === "applied") ? "applied" : "partial";
}

export function summarizeMutationOutcomes(
  outcomes: ReadonlyArray<
    Pick<
      AgentJournalStepOutcome,
      "effect" | "status" | "reversibility" | "affectedCount"
    >
  >,
): {
  effect: AgentToolEffect;
  reversibility: JournalReversibility;
  affectedCount: number;
} {
  const changed = outcomes.filter((outcome) => outcome.effect !== "none");
  const recoveryRelevant = outcomes.filter(
    (outcome) => outcome.status !== "no_effect",
  );
  return {
    effect: combineEffects(changed.map((outcome) => outcome.effect)),
    reversibility: combineReversibility(
      recoveryRelevant.map((outcome) => outcome.reversibility),
    ),
    affectedCount: changed.reduce(
      (total, outcome) => total + Math.max(0, outcome.affectedCount),
      0,
    ),
  };
}

/**
 * Operations whose concrete writes are journalled one step each.
 *
 * A note batch is not one change: it is N note creations that each reserve a
 * native identity, each carry their own durable inverse, and each fail
 * independently. It therefore contributes one step per note to the action
 * that owns it instead of being flattened into a single journalled step with
 * one whole-batch inverse.
 */
function ownsItsOwnJournalSteps(operation: LibraryMutationOperation): boolean {
  return operation.type === "save_notes_batch";
}

async function stepPlanFor(
  service: LibraryMutationService,
  operation: LibraryMutationOperation,
  context: AgentToolContext,
): Promise<MutationStepPlan> {
  const plan = await service.planOperation(operation, context);
  return {
    operation: operation.type,
    description: plan.description,
    forward: operation,
    inverse: inversePayload(plan.inverseOperations),
    precondition: plan.precondition,
    reversibility: plan.reversibility,
    reason: plan.reason,
    deferredInverse: plan.deferredInverse,
  };
}

/**
 * Run an operation that journals its own steps.
 *
 * The action is seeded before the first child write so the children can claim
 * steps under it, and the native write window is held for the whole composite
 * under the owning action id: the children's own acquires are reentrant, so
 * no concurrent write can slip between two notes of the same batch.
 */
async function executeComposite(params: {
  service: LibraryMutationService;
  operation: LibraryMutationOperation;
  context: AgentToolContext;
  actionId: string | null;
  parentScope?: AgentJournalActionScope;
  allocateSequence: () => number;
  prepareAction?: (plan: MutationStepPlan) => JournalActionSeed;
}) {
  const { service, operation, context, actionId, parentScope } = params;
  const run = async () => {
    const plan = await stepPlanFor(service, operation, context);
    if (actionId && params.prepareAction) {
      await prepareJournalAction({
        actionId,
        ...params.prepareAction(plan),
        effect: "write",
      });
    }
    const stepOutcomes: AgentJournalStepOutcome[] = [];
    const scope: AgentJournalActionScope | undefined = actionId
      ? {
          actionId,
          allocateSequence: params.allocateSequence,
          recordStep: (outcome) => {
            stepOutcomes.push(outcome);
            parentScope?.recordStep(outcome);
          },
        }
      : undefined;
    let executed: Awaited<
      ReturnType<LibraryMutationService["executeOperation"]>
    >;
    let expectedPostcondition: unknown;
    try {
      executed = await service.executeOperation(
        operation,
        scope ? { ...context, journalActionScope: scope } : context,
      );
      expectedPostcondition = await service.captureOperationState(
        operation,
        context,
        executed.result,
      );
    } catch (error) {
      // The children own their own durable state; from here the composite
      // can only report that its window may have changed the library.
      throw new MutationMayHaveAppliedError(
        error instanceof Error ? error.message : String(error),
        plan.reversibility,
      );
    }
    const changed = executed.effect !== "none";
    const reversibility = changed
      ? summarizeMutationOutcomes(stepOutcomes).reversibility
      : "full";
    const status: AgentJournalStepOutcome["status"] = changed
      ? executed.effect === "partial"
        ? "partially_applied"
        : reversibility === "none"
          ? "irreversible"
          : "applied"
      : "no_effect";
    return {
      result: executed.result,
      reversibility,
      effect: executed.effect,
      status,
      affectedCount: executed.affectedCount,
      expectedPostcondition,
      precondition: plan.precondition,
      journalStepId: undefined as string | undefined,
    };
  };
  return actionId ? withActiveJournalAction(actionId, run) : run();
}

async function executeOne(params: {
  service: LibraryMutationService;
  operation: LibraryMutationOperation;
  context: AgentToolContext;
  actionId: string | null;
  sequence: number;
  prepareAction?: (plan: MutationStepPlan) => JournalActionSeed;
}) {
  const { service, operation, context } = params;
  return executeJournaledStep({
    ...params,
    plan: async () => stepPlanFor(service, operation, context),
    execute: async () => {
      const executed = await service.executeOperation(operation, context);
      const inverse = executed.inverse;
      return {
        result: executed.result,
        inverse:
          inverse === undefined
            ? undefined
            : (inversePayload(inverse?.inverseOperations) ?? null),
        expectedPostcondition: await service.captureOperationState(
          operation,
          context,
          executed.result,
        ),
        affectedCount: executed.affectedCount,
        effect: executed.effect,
        reason: inverse?.irreversibleReason,
      };
    },
    reconcileAfterError: async () => {
      const postState = await service.captureOperationState(
        operation,
        context,
        {
          reconciliation: true,
        },
      );
      if (!mutationPostconditionIsSatisfied(operation, postState)) return null;
      return {
        result: {
          operation: operation.type,
          operationId: operation.id,
          result: { status: "reconciled_after_uncertain_execution" },
        },
        expectedPostcondition: postState,
        affectedCount: 0,
        effect: "none",
        reason:
          "The mutation call threw after starting, but authoritative Zotero state already satisfied its postcondition.",
      };
    },
  });
}

/**
 * Execute one user-visible action with one or more durable ordered steps.
 */
export async function executeLibraryMutationAction(params: {
  service: LibraryMutationService;
  operations: LibraryMutationOperation[];
  context: AgentToolContext;
  facadeToolName: string;
}): Promise<CoordinatedMutationResult> {
  const { service, operations, context, facadeToolName } = params;
  const journalToolName = context.journalToolName || facadeToolName;
  if (!operations.length) {
    return {
      effect: "none",
      affectedCount: 0,
      results: [],
      actionEvidence: [],
    };
  }

  const parentScope = context.journalActionScope;
  const journalAvailable = isAgentChangeJournalAvailable();
  if (!journalAvailable && !context.journalFallbackApproved) {
    throw new Error(
      "The durable change journal is unavailable. This write requires explicit fallback confirmation.",
    );
  }
  const actionId =
    parentScope?.actionId ||
    (journalAvailable ? createJournalId("action") : null);
  const ownsAction = Boolean(actionId && !parentScope);

  const results: LibraryMutationExecutionResult[] = [];
  const completedOutcomes: AgentJournalStepOutcome[] = [];
  const actionEvidence: AgentActionEvidence[] = [];
  let affectedCount = 0;
  let localSequence = 0;
  // One allocator for the whole action, so an operation that contributes N
  // steps cannot collide with the sequences of its siblings.
  const allocateSequence = () =>
    parentScope ? parentScope.allocateSequence() : (localSequence += 1);
  try {
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      const prepareAction =
        ownsAction && index === 0
          ? (plan: MutationStepPlan) => ({
              runId: runIdFor(context),
              conversationKey: context.request.conversationKey,
              toolName: journalToolName,
              description:
                operations.length === 1
                  ? plan.description
                  : `${journalToolName}: ${operations.length} planned changes`,
              reversibility: plan.reversibility,
              recovery: plan.reason,
            })
          : undefined;
      // A prior step may have created or changed an object referenced by this
      // operation. Re-plan at the step boundary so its pre-image describes
      // the state immediately before this write, not the state before the
      // whole batch started.
      const executed = ownsItsOwnJournalSteps(operation)
        ? await executeComposite({
            service,
            operation,
            context,
            actionId,
            parentScope,
            allocateSequence,
            prepareAction,
          })
        : await executeOne({
            service,
            operation,
            context,
            actionId,
            sequence: allocateSequence(),
            prepareAction,
          });
      results.push(executed.result);
      if (
        executed.precondition &&
        executed.expectedPostcondition &&
        typeof executed.precondition === "object" &&
        typeof executed.expectedPostcondition === "object"
      ) {
        actionEvidence.push({
          version: 1,
          proofDomain: "zotero_state",
          operationValue: operation,
          preState: executed.precondition as AgentActionEvidence["preState"],
          postState:
            executed.expectedPostcondition as AgentActionEvidence["postState"],
          journalStepId: executed.journalStepId,
          effect: executed.effect,
        });
      }
      completedOutcomes.push({
        effect: executed.effect,
        status: executed.status,
        reversibility: executed.reversibility,
        affectedCount: executed.affectedCount,
      });
      if (executed.effect !== "none") {
        affectedCount += executed.affectedCount;
      }
    }
    const summary = summarizeMutationOutcomes(completedOutcomes);
    const effect = summary.effect;
    if (actionId && ownsAction) {
      await updateJournalAction({
        actionId,
        status:
          effect === "none"
            ? "no_effect"
            : effect === "partial"
              ? "partially_applied"
              : summary.reversibility === "none"
                ? "irreversible"
                : "applied",
        reversibility: summary.reversibility,
        affectedCount: summary.affectedCount,
      });
    }
    return {
      actionId: actionId || undefined,
      effect,
      affectedCount: summary.affectedCount,
      results,
      actionEvidence,
    };
  } catch (error) {
    const changedOutcomes = completedOutcomes.filter(
      (outcome) => outcome.effect !== "none",
    );
    const uncertain = error instanceof MutationMayHaveAppliedError;
    const recovery = changedOutcomes.length
      ? `${changedOutcomes.length} prior operation${
          changedOutcomes.length === 1 ? "" : "s"
        } changed the library; durable recovery steps were retained.`
      : uncertain
        ? "The current operation may have applied; inspect journal state before retrying."
        : undefined;
    if (actionId && ownsAction) {
      const failureReversibilities = uncertain
        ? [
            ...changedOutcomes.map((outcome) => outcome.reversibility),
            error.reversibility,
          ]
        : changedOutcomes.map((outcome) => outcome.reversibility);
      await updateJournalAction({
        actionId,
        status: changedOutcomes.length
          ? "partially_applied"
          : uncertain
            ? "uncertain"
            : "failed",
        reversibility: combineReversibility(failureReversibilities),
        affectedCount,
        error: error instanceof Error ? error.message : String(error),
        recovery,
      }).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (changedOutcomes.length) throw new Error(`${message} (${recovery})`);
    if (uncertain) throw new Error(`${message} (${recovery})`);
    throw error;
  }
}

export function currentMutationActionId(): string | null {
  return getActiveJournalActionId();
}
