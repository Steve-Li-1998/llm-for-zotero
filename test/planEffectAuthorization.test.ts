import { assert } from "chai";
import type { AgentActionProposal } from "../src/agent/contracts/types";
import { matchPlanEffectProposals } from "../src/agent/plans/effectAuthorization";
import type { PlanEffectSpecification } from "../src/agent/plans/types";
import type { ExecutionTask, TaskEvidence } from "../src/agent/plans/types";
import { assertTaskCompletionEvidence } from "../src/agent/plans/taskState";

const specification: PlanEffectSpecification = {
  version: 1,
  constraints: [
    {
      kind: "deny_effects",
      effects: ["delete"],
      domains: ["zotero_library"],
      description: "Do not delete papers.",
    },
  ],
  effects: [
    {
      effectId: "tag-selected",
      approval: "initial",
      operation: "apply_tags",
      targets: [
        {
          domain: "zotero",
          libraryID: 1,
          targetIds: ["item:42", "item:43"],
          scopeDigest: "sha256:scope",
        },
      ],
      targetBindings: [],
      parameters: { tags: ["reviewed"] },
      review: "default",
      restrictions: [],
      dependsOnEffectIds: [],
      materialBindings: [],
    },
  ],
  deferredEffects: [],
};

const proposal = (
  overrides: Partial<AgentActionProposal> = {},
): AgentActionProposal => ({
  id: "proposal",
  proofDomain: "zotero_state",
  capability: "zotero.tags",
  operation: "apply_tags",
  source: "library_mutation",
  requestedTargets: ["item:42"],
  destinationCollectionIds: [],
  parameters: { tags: ["reviewed"] },
  ...overrides,
});

describe("v5 Plan effect authorization", function () {
  it("matches a concrete subset only inside the active frozen effect", function () {
    const result = matchPlanEffectProposals({
      specification,
      activeEffectIds: ["tag-selected"],
      proposals: [proposal()],
    });
    assert.equal(result.kind, "matched");
    if (result.kind !== "matched") return;
    assert.deepEqual(result.effectIds, ["tag-selected"]);
    assert.deepEqual(result.constraints, specification.constraints);
    assert.equal(result.reviewPreference, "default");
  });

  it("carries the strongest approved review preference into assessment", function () {
    const result = matchPlanEffectProposals({
      specification: {
        ...specification,
        effects: specification.effects.map((effect) => ({
          ...effect,
          review: "review" as const,
        })),
      },
      activeEffectIds: ["tag-selected"],
      proposals: [proposal()],
    });
    assert.equal(result.kind, "matched");
    if (result.kind === "matched") {
      assert.equal(result.reviewPreference, "review");
    }
  });

  it("rejects a changed target or normalized parameter", function () {
    assert.equal(
      matchPlanEffectProposals({
        specification,
        activeEffectIds: ["tag-selected"],
        proposals: [proposal({ requestedTargets: ["item:99"] })],
      }).kind,
      "outside_approved_effects",
    );
    assert.equal(
      matchPlanEffectProposals({
        specification,
        activeEffectIds: ["tag-selected"],
        proposals: [proposal({ parameters: { tags: ["changed"] } })],
      }).kind,
      "outside_approved_effects",
    );
  });

  it("accepts a created destination only from its verified producer binding", function () {
    const createThenMove: PlanEffectSpecification = {
      version: 1,
      constraints: [],
      effects: [
        {
          effectId: "create-destination",
          approval: "initial",
          operation: "create_collection",
          targets: [
            {
              domain: "zotero",
              libraryID: 1,
              targetIds: ["library:1"],
              scopeDigest: "sha256:library",
            },
          ],
          targetBindings: [],
          parameters: { collectionName: "Reviewed" },
          review: "default",
          restrictions: [],
          dependsOnEffectIds: [],
          materialBindings: [],
        },
        {
          effectId: "move-paper",
          approval: "initial",
          operation: "move_to_collection",
          targets: [
            {
              domain: "zotero",
              libraryID: 1,
              targetIds: ["item:42"],
              scopeDigest: "sha256:item",
            },
          ],
          targetBindings: [
            {
              role: "destination_collection",
              producedByEffectId: "create-destination",
            },
          ],
          parameters: { sourceCollectionId: 8 },
          review: "default",
          restrictions: [],
          dependsOnEffectIds: ["create-destination"],
          materialBindings: [],
        },
      ],
      deferredEffects: [],
    };
    const move = proposal({
      capability: "zotero.collections",
      operation: "move_to_collection",
      requestedTargets: ["item:42"],
      destinationCollectionIds: [77],
      parameters: { sourceCollectionId: 8, destinationCollectionId: 77 },
    });
    assert.equal(
      matchPlanEffectProposals({
        specification: createThenMove,
        activeEffectIds: ["move-paper"],
        proposals: [move],
      }).kind,
      "outside_approved_effects",
    );
    assert.equal(
      matchPlanEffectProposals({
        specification: createThenMove,
        activeEffectIds: ["move-paper"],
        proposals: [move],
        resolvedTargetBindings: { "move-paper": ["collection:77"] },
      }).kind,
      "matched",
    );
  });

  it("completes an effect only after verified receipts cover every frozen target", function () {
    const task: ExecutionTask = {
      version: 2,
      taskId: "task",
      executionId: "execution",
      planStepId: "step",
      kind: "required_step",
      content: "Tag selected papers",
      activeForm: "Tagging selected papers",
      acceptanceCriteria: [
        {
          criterionId: "tagged",
          description: "Every paper is tagged",
          verifier: "mutation_receipts",
        },
      ],
      expectedEffect: "mutation",
      effectIds: ["tag-selected"],
      completionRequirements: [
        {
          requirementId: "step:mutation",
          kind: "mutation_receipts",
          criterionIds: ["tagged"],
          contractDigest: "sha256:contract",
        },
      ],
      obligationIds: [],
      status: "in_progress",
      attemptCount: 1,
      evidenceIds: [],
      failureReasons: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const evidence = (id: string, target: string): TaskEvidence => ({
      version: 3,
      evidenceId: id,
      executionId: task.executionId,
      taskId: task.taskId,
      kind: "mutation_receipt",
      verified: true,
      requirementId: "step:mutation",
      criterionIds: ["tagged"],
      contractDigest: "sha256:contract",
      receipt: {
        version: 2,
        id: `receipt:${id}`,
        proposalId: `proposal:${id}`,
        proofDomain: "zotero_state",
        capability: "zotero.tags",
        operation: "apply_tags",
        verification: "verified",
        status: "applied",
        requestedTargets: [target],
        appliedTargets: [target],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        normalizedParameters: { tags: ["reviewed"] },
        reasons: [],
        verifiedFacts: ["tag present"],
      },
      payload: {
        type: "mutation_receipts",
        receiptIds: [`receipt:${id}`],
        effectIds: ["tag-selected"],
        effectTargets: [
          {
            effectId: "tag-selected",
            targetIds: ["item:42", "item:43"],
          },
        ],
      },
      createdAt: 1,
    });
    assert.throws(
      () => assertTaskCompletionEvidence(task, [evidence("one", "item:42")]),
      /not satisfied/,
    );
    assert.doesNotThrow(() =>
      assertTaskCompletionEvidence(task, [
        evidence("one", "item:42"),
        evidence("two", "item:43"),
      ]),
    );
  });
});
