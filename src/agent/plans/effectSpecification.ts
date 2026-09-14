import type {
  AgentActionContract,
  AgentActionIntent,
  AgentActionObligation,
} from "../contracts/types";
import type { ActionConstraint } from "../authorization/types";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import { decodePlanArtifact, decodePlanEffectSpecification } from "./decoders";
import type {
  PlanApprovalProvenance,
  PlanArtifact,
  PlanConcreteEffect,
  PlanDeferredEffect,
  PlanEffectSpecification,
  PlanEffectTarget,
  PlanContract,
  PlanStep,
} from "./types";

export type PlanEffectProjection =
  | Readonly<{
      kind: "compatible";
      specification: PlanEffectSpecification;
      provenance: PlanApprovalProvenance;
      actionIndexEffectIds: ReadonlyMap<number, readonly string[]>;
    }>
  | Readonly<{
      kind: "renewed_approval_required";
      reason: string;
    }>;

function renewal(reason: string): PlanEffectProjection {
  return { kind: "renewed_approval_required", reason };
}

function restrictions(
  contract: AgentActionContract | undefined,
): readonly ActionConstraint[] | null {
  const values = contract?.hardConstraints || [];
  if (values.some((entry) => entry.kind === "no_write")) return null;
  return values as readonly ActionConstraint[];
}

function targetForObligation(
  obligation: AgentActionObligation,
  producerLibraryID?: number,
): PlanEffectTarget | null {
  if (obligation.proofDomain === "zotero_state") {
    const boundary = obligation.targetBoundary;
    if (!boundary?.frozenTargetIds.length || !boundary.scopeDigest) {
      return obligation.operation === "create_collection" && producerLibraryID
        ? {
            domain: "zotero",
            libraryID: producerLibraryID,
            targetIds: [`library:${producerLibraryID}`],
            scopeDigest: `library:${producerLibraryID}`,
          }
        : null;
    }
    return {
      domain: "zotero",
      libraryID: boundary.libraryID,
      targetIds: boundary.frozenTargetIds.map((itemId) => `item:${itemId}`),
      scopeDigest: boundary.scopeDigest,
    };
  }
  if (obligation.proofDomain === "file_state") {
    const path = obligation.parameters?.filePath;
    return path ? { domain: "filesystem", paths: [path] } : null;
  }
  const fingerprint = obligation.parameters?.commandFingerprint;
  return fingerprint
    ? { domain: "execution", fingerprints: [fingerprint] }
    : null;
}

function dependencyIndexes(intent: AgentActionIntent): number[] {
  return [
    ...new Set([
      ...(intent.dependsOn || []),
      ...(intent.destinationFrom === undefined ? [] : [intent.destinationFrom]),
    ]),
  ];
}

function cloneParameters(
  parameters: AgentActionIntent["parameters"],
): Readonly<Record<string, unknown>> {
  return parameters
    ? (JSON.parse(canonicalJson(parameters)) as Record<string, unknown>)
    : {};
}

function concreteParameters(
  obligation: AgentActionObligation,
): Readonly<Record<string, unknown>> {
  const result = { ...cloneParameters(obligation.parameters) };
  if (obligation.scope?.collectionId && obligation.scopeRole === "source") {
    result.sourceCollectionId = obligation.scope.collectionId;
  }
  if (
    obligation.scope?.collectionId &&
    obligation.scopeRole === "destination" &&
    !obligation.destinationCreation
  ) {
    result.destinationCollectionId = obligation.scope.collectionId;
  }
  return result;
}

function projectInitialContract(contract: AgentActionContract):
  | Readonly<{
      effects: readonly PlanConcreteEffect[];
      actionIndexEffectIds: ReadonlyMap<number, readonly string[]>;
    }>
  | Readonly<{ error: string }> {
  const effectRestrictions = restrictions(contract);
  if (!effectRestrictions) {
    return {
      error:
        "The legacy contract contains a no-write restriction that cannot authorize its mutations.",
    };
  }
  const byActionIndex = new Map<number, string[]>();
  const byObligationId = new Map<string, string>();
  const producerLibraryIDs = new Map<string, Set<number>>();
  contract.obligations.forEach((obligation, position) => {
    const actionIndex = obligation.sourceActionIndex ?? position;
    const entries = byActionIndex.get(actionIndex) || [];
    const effectId = `effect:legacy:${actionIndex}:${obligation.id}`;
    entries.push(effectId);
    byActionIndex.set(actionIndex, entries);
    byObligationId.set(obligation.id, effectId);
    if (obligation.destinationCreation) {
      const libraries =
        producerLibraryIDs.get(obligation.destinationCreation.obligationId) ||
        new Set<number>();
      libraries.add(obligation.destinationCreation.libraryID);
      producerLibraryIDs.set(
        obligation.destinationCreation.obligationId,
        libraries,
      );
    }
  });
  const effects: PlanConcreteEffect[] = [];
  for (const [position, obligation] of contract.obligations.entries()) {
    if (obligation.contentFrom) {
      return {
        error: `Legacy obligation '${obligation.id}' refers to material without an exact document version.`,
      };
    }
    const libraries = producerLibraryIDs.get(obligation.id);
    if (libraries && libraries.size > 1) {
      return {
        error: `Legacy collection creation '${obligation.id}' spans conflicting libraries.`,
      };
    }
    const target = targetForObligation(
      obligation,
      libraries?.values().next().value,
    );
    if (!target) {
      return {
        error: `Legacy obligation '${obligation.id}' has no frozen target that can be preserved.`,
      };
    }
    const actionIndex = obligation.sourceActionIndex ?? position;
    const dependsOnEffectIds: string[] = [];
    for (const dependency of dependencyIndexes(obligation)) {
      const mapped = byActionIndex.get(dependency);
      if (!mapped?.length || dependency >= actionIndex) {
        return {
          error: `Legacy obligation '${obligation.id}' has an ambiguous action-index dependency.`,
        };
      }
      dependsOnEffectIds.push(...mapped);
    }
    const targetBindings = obligation.destinationCreation
      ? [
          {
            role: "destination_collection",
            producedByEffectId:
              byObligationId.get(obligation.destinationCreation.obligationId) ||
              "",
          },
        ]
      : [];
    if (targetBindings.some((binding) => !binding.producedByEffectId)) {
      return {
        error: `Legacy obligation '${obligation.id}' has an unresolved future target producer.`,
      };
    }
    dependsOnEffectIds.push(
      ...targetBindings.map((binding) => binding.producedByEffectId),
    );
    effects.push({
      effectId: `effect:legacy:${actionIndex}:${obligation.id}`,
      approval: "initial",
      operation: obligation.operation,
      targets: [target],
      targetBindings,
      parameters: concreteParameters(obligation),
      review: obligation.reviewPreference || "default",
      restrictions: effectRestrictions,
      dependsOnEffectIds: [...new Set(dependsOnEffectIds)],
      materialBindings: [],
    });
  }
  return { effects, actionIndexEffectIds: byActionIndex };
}

export type PlanEffectBuildResult =
  | Readonly<{
      kind: "compatible";
      specification: PlanEffectSpecification;
      actionIndexEffectIds: ReadonlyMap<number, readonly string[]>;
    }>
  | Readonly<{ kind: "renewed_approval_required"; reason: string }>;

function nativeLibraryID(targetId: string): number | undefined {
  const [kind, rawId] = targetId.split(":", 2);
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) return undefined;
  if (kind === "library") return id;
  const object =
    kind === "item" || kind === "note" || kind === "attachment"
      ? Zotero.Items?.get?.(id)
      : kind === "collection"
        ? Zotero.Collections?.get?.(id)
        : kind === "saved-search"
          ? Zotero.Searches?.get?.(id)
          : undefined;
  return object ? Number(object.libraryID) : undefined;
}

/**
 * Replace model-supplied Zotero scope digests with a host-derived digest and
 * verify every resolvable native identity before the Plan can be reviewed.
 */
export async function freezePlanEffectSpecification(
  value: PlanEffectSpecification,
): Promise<PlanEffectSpecification> {
  const specification = decodePlanEffectSpecification(value);
  const effects = await Promise.all(
    specification.effects.map(async (effect) => ({
      ...effect,
      targets: await Promise.all(
        effect.targets.map(async (target) => {
          if (target.domain !== "zotero") return target;
          const targetIds = [...new Set(target.targetIds)].sort();
          for (const targetId of targetIds) {
            const resolvedLibraryID = nativeLibraryID(targetId);
            if (
              resolvedLibraryID !== undefined &&
              resolvedLibraryID !== target.libraryID
            ) {
              throw new Error(
                `Plan effect '${effect.effectId}' target '${targetId}' belongs to a different library.`,
              );
            }
            if (
              /^(item|note|attachment|collection|saved-search):/.test(
                targetId,
              ) &&
              resolvedLibraryID === undefined
            ) {
              throw new Error(
                `Plan effect '${effect.effectId}' target '${targetId}' does not exist.`,
              );
            }
          }
          return {
            ...target,
            targetIds,
            scopeDigest: `sha256:${await sha256Text(
              canonicalJson({
                domain: target.domain,
                libraryID: target.libraryID,
                targetIds,
              }),
            )}`,
          };
        }),
      ),
    })),
  );
  return decodePlanEffectSpecification({
    ...specification,
    effects,
  });
}

/** Build v5 effects from an explicit Plan contract without interpreting prose. */
export function buildPlanEffectSpecification(params: {
  contract: PlanContract;
  actionContract?: AgentActionContract;
}): PlanEffectBuildResult {
  const mutation = params.contract.effects?.libraryMutation;
  const initialContract =
    mutation?.approval === "initial"
      ? mutation.contract
      : mutation
        ? undefined
        : params.actionContract;
  const initial = initialContract
    ? projectInitialContract(initialContract)
    : {
        effects: [] as readonly PlanConcreteEffect[],
        actionIndexEffectIds: new Map<number, readonly string[]>(),
      };
  if ("error" in initial) {
    return { kind: "renewed_approval_required", reason: initial.error };
  }
  let deferredEffects: readonly PlanDeferredEffect[] = [];
  if (mutation?.approval === "after_research") {
    const projected = projectDeferredIntents({
      intents: mutation.intent.intents,
      targetSelectionDescription: mutation.intent.targetSelectionDescription,
      effectRestrictions: [],
    });
    if ("error" in projected) {
      return { kind: "renewed_approval_required", reason: projected.error };
    }
    deferredEffects = projected.effects;
  }
  return {
    kind: "compatible",
    specification: decodePlanEffectSpecification({
      version: 1,
      constraints: restrictions(initialContract) || [],
      effects: initial.effects,
      deferredEffects,
    }),
    actionIndexEffectIds: initial.actionIndexEffectIds,
  };
}

function projectDeferredIntents(params: {
  intents: readonly AgentActionIntent[];
  targetSelectionDescription: string;
  effectRestrictions: readonly ActionConstraint[];
}):
  | Readonly<{ effects: readonly PlanDeferredEffect[] }>
  | Readonly<{ error: string }> {
  const effects: PlanDeferredEffect[] = [];
  for (const [index, intent] of params.intents.entries()) {
    if (
      intent.contentFrom ||
      intent.destinationFrom !== undefined ||
      intent.discovery ||
      intent.scope ||
      intent.scopeRole ||
      intent.constraints ||
      intent.targetSelectors?.length
    ) {
      return {
        error: `Deferred legacy effect ${index + 1} contains target, scope, or material semantics that cannot be preserved.`,
      };
    }
    const dependsOnEffectIds: string[] = [];
    for (const dependency of intent.dependsOn || []) {
      if (dependency >= index) {
        return {
          error: `Deferred legacy effect ${index + 1} has an ambiguous action-index dependency.`,
        };
      }
      dependsOnEffectIds.push(`effect:legacy:deferred:${dependency}`);
    }
    effects.push({
      effectId: `effect:legacy:deferred:${index}`,
      approval: "after_research",
      operation: intent.operation,
      targetSelectionDescription: params.targetSelectionDescription,
      targetBindings: [],
      parameters: cloneParameters(intent.parameters),
      review: intent.reviewPreference || "default",
      restrictions: params.effectRestrictions,
      dependsOnEffectIds,
      materialBindings: [],
    });
  }
  return { effects };
}

/**
 * Converts only legacy authority that can be represented without interpreting
 * prose or widening targets. A refusal means the existing approval must remain
 * on its legacy execution path or be approved again as concrete v5 effects.
 */
export function projectLegacyPlanEffects(
  artifact: PlanArtifact,
): PlanEffectProjection {
  if (artifact.version === 5) {
    return renewal(
      "The artifact is already version 5 and does not need legacy projection.",
    );
  }
  const provenance: PlanApprovalProvenance = {
    sourceArtifactVersion: artifact.version,
    sourceDigest: artifact.digest,
    sourceContractDigest: artifact.contractDigest,
  };
  const mutation = artifact.contract?.effects?.libraryMutation;
  if (
    mutation?.approval === "initial" &&
    artifact.actionContract &&
    mutation.contract.id !== artifact.actionContract.id
  ) {
    return renewal(
      "The legacy artifact contains conflicting action contracts.",
    );
  }
  const built = buildPlanEffectSpecification({
    contract: artifact.contract || { deliverable: { kind: "answer" } },
    actionContract: artifact.actionContract,
  });
  if (built.kind !== "compatible") return renewal(built.reason);
  return {
    kind: "compatible",
    specification: built.specification,
    provenance,
    actionIndexEffectIds: built.actionIndexEffectIds,
  };
}

export type PlanArtifactV5Projection =
  | Readonly<{ kind: "compatible"; artifact: PlanArtifact }>
  | Readonly<{ kind: "renewed_approval_required"; reason: string }>;

function artifactRenewal(reason: string): PlanArtifactV5Projection {
  return { kind: "renewed_approval_required", reason };
}

/** Builds an in-memory v5 view. Callers must not rewrite the stored approval. */
export async function projectLegacyPlanArtifactV5(
  artifact: PlanArtifact,
): Promise<PlanArtifactV5Projection> {
  const projection = projectLegacyPlanEffects(artifact);
  if (projection.kind !== "compatible") {
    return artifactRenewal(projection.reason);
  }
  const steps: PlanStep[] = [];
  for (const step of artifact.steps) {
    let effectIds: string[] | undefined;
    if (step.actionIndexes?.length) {
      effectIds = step.actionIndexes.flatMap(
        (index) => projection.actionIndexEffectIds.get(index) || [],
      );
      if (!effectIds.length) {
        return artifactRenewal(
          `Plan step '${step.planStepId}' has an action index that cannot be preserved.`,
        );
      }
    } else if (step.expectedEffect === "mutation") {
      const candidates = [
        ...projection.specification.effects,
        ...projection.specification.deferredEffects,
      ];
      if (candidates.length !== 1) {
        return artifactRenewal(
          `Mutation step '${step.planStepId}' has no unambiguous concrete effect binding.`,
        );
      }
      effectIds = [candidates[0].effectId];
    }
    const { actionIndexes: _legacyIndexes, ...rest } = step;
    steps.push({ ...rest, effectIds });
  }
  const contract = artifact.contract
    ? {
        investigation: artifact.contract.investigation,
        deliverable: artifact.contract.deliverable,
        researchPolicy: artifact.contract.researchPolicy,
      }
    : { deliverable: { kind: "answer" as const } };
  const contractDigest = `sha256:${await sha256Text(
    canonicalJson({ contract, effectSpecification: projection.specification }),
  )}`;
  const normalizedSteps = steps.map((step) => ({
    ...step,
    completionRequirements: step.completionRequirements?.map((requirement) => ({
      ...requirement,
      contractDigest,
    })),
  }));
  const {
    actionContract: _legacyContract,
    actionContractId: _legacyContractId,
    skillRoutingReceipt: _legacySkillRoutingReceipt,
    digest: _legacyDigest,
    version: _legacyVersion,
    ...rest
  } = artifact;
  const unsigned = {
    ...rest,
    version: 5 as const,
    contract,
    contractDigest,
    effectSpecification: projection.specification,
    approvalProvenance: projection.provenance,
    skillBindings:
      _legacySkillRoutingReceipt?.skills.map((skill) => ({
        id: skill.id,
        version: skill.version,
        instructionFingerprint: skill.instructionHash,
        source:
          skill.source === "explicit"
            ? ("forced" as const)
            : ("loaded" as const),
      })) || [],
    steps: normalizedSteps,
  };
  const converted = decodePlanArtifact({
    ...unsigned,
    digest: `sha256:${await sha256Text(canonicalJson(unsigned))}`,
  });
  return { kind: "compatible", artifact: converted };
}
