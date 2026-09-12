import { assert } from "chai";
import {
  evaluateActionContract,
  evaluatePreparedActionContract,
  formatReceiptStatus,
} from "../src/agent/contracts/actionEvaluation";
import {
  semanticContractFixture,
  classifiedFixture,
} from "./helpers/semanticIntent";

describe("prepared action completion", function () {
  it("accepts an explicitly interpreted answer with no requested actions", function () {
    assert.equal(
      evaluatePreparedActionContract(
        {
          classifiedIntent: classifiedFixture(),
          actionPreparation: { state: "ready", issues: [] },
        },
        [],
      ).state,
      "satisfied",
    );
  });

  it("accepts a fresh direct answer without predicted obligations", function () {
    const decision = evaluatePreparedActionContract({}, []);
    assert.equal(decision.state, "satisfied");
    assert.isUndefined(decision.correction);
  });
  it("does not accept an unresolved reference even when a prior contract exists", function () {
    const contract = semanticContractFixture({
      id: "old",
      obligations: [],
      writeDisposition: "none",
    });
    const decision = evaluatePreparedActionContract(
      {
        actionContract: contract,
        actionPreparation: {
          state: "needs_input",
          issues: ["Choose an exact destination"],
        },
      },
      [],
    );
    assert.equal(decision.state, "failed");
    assert.include(decision.failure!, "Choose an exact destination");
  });
  it("accepts a valid semantic answer contract without inventing mutation evidence", function () {
    const intent = classifiedFixture();
    const contract = semanticContractFixture({
      id: "answer",
      intent,
      obligations: [],
      writeDisposition: "none",
    });
    assert.equal(
      evaluatePreparedActionContract(
        {
          actionContract: contract,
          actionPreparation: { state: "ready", issues: [] },
        },
        [],
      ).state,
      "satisfied",
    );
  });
  it("requires verified evidence for an unresolved concrete effect", function () {
    const contract = semanticContractFixture({
      id: "filing",
      writeDisposition: "required",
      obligations: [
        {
          id: "filing:0",
          operation: "move_to_collection",
          capability: "zotero.collections",
          proofDomain: "zotero_state",
          coverage: "one",
          targetKind: "papers",
          parameters: { destinationCollectionId: 5 },
        },
      ],
    });
    const decision = evaluatePreparedActionContract(
      {
        actionContract: contract,
        actionPreparation: { state: "ready", issues: [] },
      },
      [],
    );
    assert.equal(decision.state, "pending");
    assert.isString(decision.correction);
  });

  function tagReceipt(
    status: import("../src/agent/contracts/types").AgentActionReceipt["status"],
  ): import("../src/agent/contracts/types").AgentActionReceipt {
    return {
      version: 2,
      id: "contract:unmatched:apply_tags",
      proposalId: "proposal:apply_tags",
      proofDomain: "zotero_state",
      capability: "zotero.tags",
      operation: "apply_tags",
      verification: "verified",
      status,
      requestedTargets: ["item:41"],
      appliedTargets: status === "applied" ? ["item:41"] : [],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
    };
  }

  it("reports delegated native receipts without rechecking Original Agent intent", function () {
    const receipt = {
      ...tagReceipt("applied"),
      executionAuthority: "external_runtime" as const,
    };
    const request = {
      classifiedIntent: classifiedFixture(),
      actionPreparation: {
        state: "needs_input" as const,
        issues: ["Original semantic reference was not resolved"],
      },
    };
    assert.equal(
      evaluatePreparedActionContract(request, [receipt]).state,
      "satisfied",
    );
    assert.equal(
      evaluatePreparedActionContract(request, [tagReceipt("applied")]).state,
      "failed",
    );
  });

  for (const status of ["partial", "failed", "unverified"] as const) {
    it(`reports delegated ${status} effects without automatically retrying`, function () {
      const receipt = {
        ...tagReceipt(status),
        executionAuthority: "external_runtime" as const,
      };
      const decision = evaluatePreparedActionContract({}, [receipt]);
      assert.equal(decision.state, status);
      assert.include(decision.failure!, status);
      assert.isUndefined(decision.correction);
    });
  }

  it("does not let an effect the client ran in its own runtime answer for a Zotero action", function () {
    // Phase 3 task 5 receipts Codex's and Claude Code's own file changes and
    // shell commands. They are audit evidence: they must neither satisfy a
    // Zotero obligation nor report an otherwise complete turn as unverified.
    const runtimeEffect: import("../src/agent/contracts/types").AgentActionReceipt =
      {
        version: 2,
        executionAuthority: "external_runtime",
        id: "external_runtime:claude_code:command_execute:call-1:executed",
        proposalId: "external_runtime:claude_code:command_execute:call-1",
        proofDomain: "execution",
        capability: "command.execute",
        operation: "command_execute",
        verification: "execution_only",
        status: "observed",
        requestedTargets: ["command:fnv1a32:0000dead"],
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
        verifiedFacts: [],
      };
    const zoteroWrite = {
      ...tagReceipt("applied"),
      executionAuthority: "external_runtime" as const,
    };
    assert.equal(
      evaluatePreparedActionContract({}, [zoteroWrite, runtimeEffect]).state,
      "satisfied",
      "an execution_only shell effect must not spoil a verified delegated write",
    );
    const contract = semanticContractFixture({
      id: "shell-instead-of-tags",
      writeDisposition: "none",
      obligations: [],
      skippedActions: [{ actionIndex: 0, operation: "apply_tags" }],
    });
    assert.equal(
      evaluatePreparedActionContract(
        {
          actionContract: contract,
          actionPreparation: { state: "ready", issues: [] },
        },
        [runtimeEffect],
      ).state,
      "failed",
      "a shell command is not the tag write the turn owed",
    );
  });

  it("reports a dropped action as not performed instead of bare success", function () {
    const contract = semanticContractFixture({
      id: "dropped",
      writeDisposition: "none",
      obligations: [],
      skippedActions: [{ actionIndex: 0, operation: "apply_tags" }],
    });
    const decision = evaluateActionContract(contract, []);
    assert.equal(decision.state, "failed");
    assert.include(decision.failure!, "apply tags");
    assert.include(decision.failure!, "not performed");
  });

  it("accepts a dropped action covered by the agent's own judgment write", function () {
    const contract = semanticContractFixture({
      id: "dropped-then-done",
      writeDisposition: "none",
      obligations: [],
      skippedActions: [{ actionIndex: 0, operation: "apply_tags" }],
    });
    assert.equal(
      evaluateActionContract(contract, [tagReceipt("applied")]).state,
      "satisfied",
    );
    // A receipt that did not apply anything does not cover the dropped action.
    assert.equal(
      evaluateActionContract(contract, [tagReceipt("failed")]).state,
      "failed",
    );
  });
});

describe("receipt status vocabulary", function () {
  type Receipt = import("../src/agent/contracts/types").AgentActionReceipt;

  function receipt(
    verification: Receipt["verification"],
    extra: Partial<Receipt> = {},
  ): Receipt {
    return {
      version: 2,
      id: "contract:unmatched:apply_tags",
      proposalId: "proposal:apply_tags",
      proofDomain: "zotero_state",
      capability: "zotero.tags",
      operation: "apply_tags",
      verification,
      status: "applied",
      requestedTargets: ["item:41"],
      appliedTargets: ["item:41"],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
      ...extra,
    };
  }

  // The status block is appended to the answer the user reads, so it names a
  // verification value the same way the trace chip does.
  it("names every verification value in the words the trace uses", function () {
    assert.equal(
      formatReceiptStatus([receipt("verified")]),
      "[Action status: apply_tags — applied 1/1; Verified; proof:zotero_state]",
    );
    assert.equal(
      formatReceiptStatus([receipt("execution_only")]),
      "[Action status: apply_tags — applied 1/1; Ran (no state proof); proof:zotero_state]",
    );
    assert.equal(
      formatReceiptStatus([receipt("unverified")]),
      "[Action status: apply_tags — applied 1/1; Unverified; proof:zotero_state]",
    );
    assert.equal(
      formatReceiptStatus([
        receipt("not_applicable", {
          status: "cancelled",
          appliedTargets: [],
        }),
      ]),
      "[Action status: apply_tags — cancelled 0/1; Not applicable; proof:zotero_state]",
    );
  });

  it("keeps a receipt written before the value existed readable", function () {
    const legacy = receipt("verified");
    delete (legacy as { verification?: unknown }).verification;
    assert.equal(
      formatReceiptStatus([legacy]),
      "[Action status: apply_tags — applied 1/1; proof:zotero_state]",
    );
  });

  it("reports one line per receipt", function () {
    assert.equal(
      formatReceiptStatus([receipt("verified"), receipt("unverified")]),
      [
        "[Action status: apply_tags — applied 1/1; Verified; proof:zotero_state]",
        "[Action status: apply_tags — applied 1/1; Unverified; proof:zotero_state]",
      ].join("\n"),
    );
  });
});
