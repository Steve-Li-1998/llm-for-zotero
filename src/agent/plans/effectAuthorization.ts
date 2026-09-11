import type {
  AgentActionProposal,
  AgentActionReceipt,
} from "../contracts/types";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import type {
  PlanConcreteEffect,
  PlanEffectMaterialBinding,
  PlanEffectSpecification,
} from "./types";

export type ResolvedPlanMaterialBinding = Readonly<{
  producedByStepId: string;
  outputId: string;
  documentId: string;
  documentVersion: number;
  contentHash: string;
}>;

export type PlanEffectMatch =
  | Readonly<{
      kind: "matched";
      effectIds: readonly string[];
      constraints: PlanEffectSpecification["constraints"];
      reviewPreference: "default" | "review" | "direct";
    }>
  | Readonly<{ kind: "outside_approved_effects"; reason: string }>;

export function planEffectTargets(effect: PlanConcreteEffect): string[] {
  return effect.targets.flatMap((target) => {
    if (target.domain === "zotero") return target.targetIds;
    if (target.domain === "filesystem") {
      return target.paths.map((path) => `file:${path}`);
    }
    return target.fingerprints.map((fingerprint) =>
      fingerprint.startsWith("command:") || fingerprint.startsWith("script:")
        ? fingerprint
        : `command:${fingerprint}`,
    );
  });
}

function expectedMaterial(
  binding: PlanEffectMaterialBinding,
  resolved: readonly ResolvedPlanMaterialBinding[],
) {
  if ("material" in binding) return binding.material;
  return resolved.find(
    (entry) =>
      entry.producedByStepId === binding.producedByStepId &&
      entry.outputId === binding.outputId,
  );
}

function parametersMatch(
  effect: PlanConcreteEffect,
  proposal: Pick<AgentActionProposal, "parameters">,
): boolean {
  const parameters = { ...(proposal.parameters || {}) };
  if (effect.materialBindings.length) {
    delete parameters.documentId;
    delete parameters.contentHash;
    delete parameters.expectedText;
  }
  if (
    effect.targetBindings.some(
      (binding) => binding.role === "destination_collection",
    )
  ) {
    // The producer receipt supplies this concrete native identity after Plan
    // approval. The proposal matcher verifies it against resolvedTargetBindings.
    delete parameters.destinationCollectionId;
  }
  return canonicalJson(effect.parameters) === canonicalJson(parameters);
}

function materialMatches(params: {
  effect: PlanConcreteEffect;
  proposal: Pick<AgentActionProposal, "parameters" | "expectedContentHash">;
  resolvedMaterials: readonly ResolvedPlanMaterialBinding[];
}): boolean {
  for (const binding of params.effect.materialBindings) {
    const material = expectedMaterial(binding, params.resolvedMaterials);
    if (!material) return false;
    if (params.proposal.expectedContentHash !== material.contentHash)
      return false;
    if (
      params.proposal.parameters?.documentId !== undefined &&
      params.proposal.parameters.documentId !== material.documentId
    ) {
      return false;
    }
    if (
      params.proposal.parameters?.contentHash !== undefined &&
      params.proposal.parameters.contentHash !== material.contentHash
    ) {
      return false;
    }
  }
  return true;
}

function candidateEffects(params: {
  specification: PlanEffectSpecification;
  activeEffectIds: readonly string[];
  operation: AgentActionProposal["operation"];
}): PlanConcreteEffect[] {
  const active = new Set(params.activeEffectIds);
  return params.specification.effects.filter(
    (effect) =>
      active.has(effect.effectId) && effect.operation === params.operation,
  );
}

function proposalMatch(params: {
  specification: PlanEffectSpecification;
  activeEffectIds: readonly string[];
  proposal: AgentActionProposal;
  resolvedMaterials: readonly ResolvedPlanMaterialBinding[];
  resolvedTargetBindings: Readonly<Record<string, readonly string[]>>;
}): PlanEffectMatch {
  const candidates = candidateEffects({
    specification: params.specification,
    activeEffectIds: params.activeEffectIds,
    operation: params.proposal.operation,
  }).filter(
    (effect) =>
      parametersMatch(effect, params.proposal) &&
      materialMatches({
        effect,
        proposal: params.proposal,
        resolvedMaterials: params.resolvedMaterials,
      }),
  );
  if (!candidates.length) {
    return {
      kind: "outside_approved_effects",
      reason: `Operation '${params.proposal.operation}' or its normalized parameters do not match an active approved effect.`,
    };
  }
  const owners = new Map<string, string[]>();
  for (const effect of candidates) {
    for (const target of [
      ...planEffectTargets(effect),
      ...(params.resolvedTargetBindings[effect.effectId] || []),
    ]) {
      const entries = owners.get(target) || [];
      entries.push(effect.effectId);
      owners.set(target, entries);
    }
  }
  const proposalTargets =
    params.proposal.requestedTargets.length > 0
      ? [
          ...params.proposal.requestedTargets,
          ...params.proposal.destinationCollectionIds.map(
            (collectionId) => `collection:${collectionId}`,
          ),
        ]
      : params.proposal.parameters?.commandFingerprint
        ? [`command:${params.proposal.parameters.commandFingerprint}`]
        : params.proposal.destinationCollectionIds.map(
            (collectionId) => `collection:${collectionId}`,
          );
  if (!proposalTargets.length) {
    return {
      kind: "outside_approved_effects",
      reason:
        "The concrete proposal has no host-resolved target to bind to the approved effect.",
    };
  }
  const matched = new Set<string>();
  for (const target of proposalTargets) {
    const targetOwners = owners.get(target) || [];
    if (targetOwners.length !== 1) {
      return {
        kind: "outside_approved_effects",
        reason: `Concrete target '${target}' is outside or ambiguous within the active approved effects.`,
      };
    }
    matched.add(targetOwners[0]);
  }
  return {
    kind: "matched",
    effectIds: [...matched],
    constraints: [
      ...params.specification.constraints,
      ...candidates
        .filter((effect) => matched.has(effect.effectId))
        .flatMap((effect) => effect.restrictions),
    ],
    reviewPreference: candidates.some(
      (effect) => matched.has(effect.effectId) && effect.review === "review",
    )
      ? "review"
      : candidates.every(
            (effect) =>
              !matched.has(effect.effectId) || effect.review === "direct",
          )
        ? "direct"
        : "default",
  };
}

/** Match each host-normalized proposal against the active approved v5 effects. */
export function matchPlanEffectProposals(params: {
  specification: PlanEffectSpecification;
  activeEffectIds: readonly string[];
  proposals: readonly AgentActionProposal[];
  resolvedMaterials?: readonly ResolvedPlanMaterialBinding[];
  resolvedTargetBindings?: Readonly<Record<string, readonly string[]>>;
}): PlanEffectMatch {
  if (!params.proposals.length) {
    return {
      kind: "outside_approved_effects",
      reason:
        "The external write has no typed proposal to bind to the approved Plan.",
    };
  }
  const effectIds = new Set<string>();
  const constraints = new Map<
    string,
    PlanEffectSpecification["constraints"][number]
  >();
  const reviews: Array<"default" | "review" | "direct"> = [];
  for (const proposal of params.proposals) {
    const result = proposalMatch({
      ...params,
      proposal,
      resolvedMaterials: params.resolvedMaterials || [],
      resolvedTargetBindings: params.resolvedTargetBindings || {},
    });
    if (result.kind !== "matched") return result;
    result.effectIds.forEach((id) => effectIds.add(id));
    result.constraints.forEach((constraint) =>
      constraints.set(canonicalJson(constraint), constraint),
    );
    reviews.push(result.reviewPreference);
  }
  return {
    kind: "matched",
    effectIds: [...effectIds],
    constraints: [...constraints.values()],
    reviewPreference: reviews.includes("review")
      ? "review"
      : reviews.every((review) => review === "direct")
        ? "direct"
        : "default",
  };
}

/** Bind a verified receipt back to the approved effects it can satisfy. */
export function matchPlanEffectReceipt(params: {
  specification: PlanEffectSpecification;
  activeEffectIds: readonly string[];
  receipt: AgentActionReceipt;
}): readonly string[] {
  const candidates = candidateEffects({
    specification: params.specification,
    activeEffectIds: params.activeEffectIds,
    operation: params.receipt.operation,
  }).filter(
    (effect) =>
      parametersMatch(effect, {
        parameters: params.receipt.normalizedParameters,
      }) &&
      params.receipt.requestedTargets.every((target) =>
        planEffectTargets(effect).includes(target),
      ),
  );
  return candidates.length === 1 ? [candidates[0].effectId] : [];
}
