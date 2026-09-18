import type { AgentActionContract } from "../contracts/types";
import type { PlanArtifact } from "../plans/types";
import type { PlanEffectSpecification } from "../plans/types";
import { operationCatalogEntry } from "../contracts/operationCatalog";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import {
  listPaperFindings,
  loadResearchJobForExecution,
  saveResearchMutationApprovalGrant,
} from "./store";
import type {
  PaperFinding,
  ResearchJob,
  ResearchMutationApprovalGrant,
} from "./types";

export async function researchMutationDigest(value: unknown): Promise<string> {
  return `sha256:${await sha256Text(canonicalJson(value))}`;
}

export async function computeResearchResultDigest(params: {
  job: ResearchJob;
  findings: readonly PaperFinding[];
  includeScopeLineage?: boolean;
}): Promise<string> {
  return researchMutationDigest({
    researchJobId: params.job.researchJobId,
    coverageStatus: params.job.coverageStatus,
    ...(params.includeScopeLineage !== false
      ? { scopeLineageDigest: params.job.scopeLineageDigest }
      : {}),
    findings: params.findings.map((finding) => ({
      findingId: finding.findingId,
      libraryID: finding.libraryID,
      itemKey: finding.itemKey,
      inclusionDecision: finding.inclusionDecision,
      sourceFingerprint: finding.sourceFingerprint,
    })),
  });
}

export async function computeResearchTargetSetDigest(params: {
  operations: readonly {
    capability: string;
    operation: string;
    parameters?: unknown;
    targets: readonly { libraryID: number; itemKey: string }[];
  }[];
  resolvedTargets: readonly {
    libraryID: number;
    itemKey: string;
    itemId: number;
  }[];
}): Promise<string> {
  return researchMutationDigest(params);
}

async function validateResearchMutationGrantInternal(params: {
  grant: ResearchMutationApprovalGrant;
  artifact: PlanArtifact;
}): Promise<ValidatedResearchMutationGrant> {
  const { grant, artifact } = params;
  if (
    grant.status !== "approved" ||
    grant.planId !== artifact.planId ||
    grant.planRevision !== artifact.revision ||
    grant.conversationKey !== artifact.conversationKey ||
    grant.planDigest !== artifact.digest ||
    (grant.version === 4
      ? artifact.version !== 5 ||
        !artifact.effectSpecification?.deferredEffects.length
      : artifact.contract?.effects?.libraryMutation.approval !==
        "after_research")
  ) {
    throw new Error(
      "The research-selected mutation approval no longer matches the plan",
    );
  }
  const job = await loadResearchJobForExecution(grant.executionId);
  if (
    !job ||
    job.status !== "completed" ||
    !["complete", "complete_with_limitations"].includes(
      String(job.coverageStatus),
    )
  ) {
    throw new Error(
      "The research result behind the mutation approval is not terminal",
    );
  }
  if (
    grant.version >= 2 &&
    grant.scopeLineageDigest !== job.scopeLineageDigest
  ) {
    throw new Error(
      "The research scope lineage changed after mutation approval",
    );
  }
  const findings = await listPaperFindings(job.researchJobId);
  if (
    (await computeResearchResultDigest({
      job,
      findings,
      includeScopeLineage: grant.version >= 2,
    })) !== grant.researchResultDigest
  ) {
    throw new Error("Research findings changed after mutation approval");
  }
  const operations: Array<{
    capability: string;
    operation: string;
    parameters?: unknown;
    targets: Array<{ libraryID: number; itemKey: string }>;
  }> = [];
  const resolvedTargets: Array<{
    libraryID: number;
    itemKey: string;
    itemId: number;
  }> = [];
  if (grant.version === 4) {
    const approved = grant.effectSpecification;
    const base = artifact.effectSpecification;
    if (
      !approved ||
      !base ||
      (await researchMutationDigest(approved)) !==
        grant.effectSpecificationDigest ||
      canonicalJson(approved.constraints) !== canonicalJson(base.constraints) ||
      canonicalJson(approved.deferredEffects) !==
        canonicalJson(base.deferredEffects)
    ) {
      throw new Error(
        "The research-selected effect specification changed after approval",
      );
    }
    const baseEffects = new Map(
      base.effects.map((effect) => [effect.effectId, effect]),
    );
    const retainedInitialEffects = approved.effects.filter(
      (entry) => !entry.derivedFromDeferredEffectId,
    );
    if (retainedInitialEffects.length !== base.effects.length) {
      throw new Error(
        "The research approval omitted an initially approved effect",
      );
    }
    for (const effect of retainedInitialEffects) {
      if (
        canonicalJson(baseEffects.get(effect.effectId)) !==
        canonicalJson(effect)
      ) {
        throw new Error("The initially approved Plan effects changed");
      }
    }
    const derivedEffects = approved.effects.filter((effect) =>
      Boolean(effect.derivedFromDeferredEffectId),
    );
    if (!derivedEffects.length) {
      throw new Error("The research approval contains no derived effects");
    }
    for (const effect of derivedEffects) {
      const deferred = base.deferredEffects.find(
        (entry) => entry.effectId === effect.derivedFromDeferredEffectId,
      );
      const authority = operationCatalogEntry(effect.operation);
      if (
        !deferred ||
        !authority ||
        effect.operation !== deferred.operation ||
        canonicalJson(effect.parameters) !==
          canonicalJson(deferred.parameters) ||
        effect.review !== deferred.review ||
        canonicalJson(effect.restrictions) !==
          canonicalJson(deferred.restrictions) ||
        canonicalJson(effect.dependsOnEffectIds) !==
          canonicalJson(deferred.dependsOnEffectIds) ||
        canonicalJson(effect.targetBindings) !==
          canonicalJson(deferred.targetBindings) ||
        canonicalJson(effect.materialBindings) !==
          canonicalJson(deferred.materialBindings)
      ) {
        throw new Error(
          "A research-derived effect no longer matches its approved template",
        );
      }
      for (const target of effect.targets) {
        if (target.domain !== "zotero") {
          throw new Error(
            "Research-selected effects must use exact Zotero targets",
          );
        }
        const stableTargets: Array<{ libraryID: number; itemKey: string }> = [];
        for (const targetId of target.targetIds) {
          const match = /^item:(\d+)$/.exec(targetId);
          const item = match ? Zotero.Items.get(Number(match[1])) : null;
          if (
            !item ||
            item.deleted ||
            Number(item.libraryID) !== target.libraryID ||
            !String(item.key || "").trim()
          ) {
            throw new Error(
              "A research-selected mutation target changed or disappeared",
            );
          }
          const stable = {
            libraryID: target.libraryID,
            itemKey: String(item.key),
          };
          stableTargets.push(stable);
          resolvedTargets.push({ ...stable, itemId: Number(match![1]) });
        }
        operations.push({
          capability: authority.capability,
          operation: effect.operation,
          parameters: effect.parameters,
          targets: stableTargets,
        });
      }
    }
    if (
      (await computeResearchTargetSetDigest({
        operations,
        resolvedTargets,
      })) !== grant.targetSetDigest
    ) {
      throw new Error(
        "Research-selected mutation targets or parameters changed after approval",
      );
    }
    return { kind: "v5_effects", effectSpecification: approved };
  }
  if (!grant.actionContract) {
    throw new Error("The legacy research approval has no action contract");
  }
  for (const obligation of grant.actionContract.obligations) {
    const boundary = obligation.targetBoundary;
    if (!boundary?.frozenTargetIds.length) {
      throw new Error(
        "The approved mutation no longer has an exact target boundary",
      );
    }
    const targets = boundary.frozenTargetIds.map((itemId) => {
      const item = Zotero.Items.get(itemId);
      if (
        !item ||
        item.deleted ||
        Number(item.libraryID) !== boundary.libraryID ||
        !String(item.key || "").trim()
      ) {
        throw new Error(
          "A research-selected mutation target changed or disappeared",
        );
      }
      const target = {
        libraryID: boundary.libraryID,
        itemKey: String(item.key),
      };
      resolvedTargets.push({ ...target, itemId });
      return target;
    });
    operations.push({
      capability: obligation.capability,
      operation: obligation.operation,
      parameters: obligation.parameters,
      targets,
    });
  }
  if (
    (await computeResearchTargetSetDigest({ operations, resolvedTargets })) !==
    grant.targetSetDigest
  ) {
    throw new Error(
      "Research-selected mutation targets or parameters changed after approval",
    );
  }
  return { kind: "legacy_action_contract", contract: grant.actionContract };
}

export type ValidatedResearchMutationGrant =
  | Readonly<{
      kind: "legacy_action_contract";
      contract: AgentActionContract;
    }>
  | Readonly<{
      kind: "v5_effects";
      effectSpecification: PlanEffectSpecification;
    }>;

export async function validateResearchMutationGrant(params: {
  grant: ResearchMutationApprovalGrant;
  artifact: PlanArtifact;
}): Promise<ValidatedResearchMutationGrant> {
  try {
    return await validateResearchMutationGrantInternal(params);
  } catch (error) {
    if (params.grant.status === "approved") {
      await saveResearchMutationApprovalGrant({
        ...params.grant,
        status: "invalidated",
        invalidatedAt: Date.now(),
      });
    }
    throw error;
  }
}
