import { assert } from "chai";
import { createRevertChangesTool } from "../src/agent/tools/write/revertChanges";
import { createTestActionContractService } from "./helpers/actionContractService";

/**
 * revert_changes had no test file of its own. Same purpose as the
 * undo_last_action characterization: pin the frozen proposal, and pin that the
 * receipt's `verification` currently comes from the tool's own counters rather
 * than from the per-step native re-read. Phase 3 task 3 changes the second half.
 */
describe("revert_changes effect path", function () {
  const tool = createRevertChangesTool({} as never);
  const service = createTestActionContractService();

  const validated = (args: Record<string, unknown>) => {
    const input = tool.validate(args);
    if (!input.ok) throw new Error(input.error);
    return input.value;
  };

  it("freezes the revert budget and any explicitly named actions", async function () {
    const proposals = await tool.describeAction!(
      validated({ actionIds: ["action-1", "action-2"] }),
    );
    assert.lengthOf(proposals, 1);
    assert.equal(proposals[0].operation, "revert");
    assert.equal(proposals[0].capability, "zotero.undo");
    assert.equal(proposals[0].proofDomain, "zotero_state");
    assert.equal(proposals[0].parameters?.revertCount, 1);
    assert.deepEqual(proposals[0].requestedTargets, [
      "journal-action:action-1",
      "journal-action:action-2",
    ]);
  });

  it("proposes nothing for a dry run", async function () {
    const proposals = await tool.describeAction!(
      validated({ count: 3, dryRun: true }),
    );
    assert.deepEqual(proposals, []);
  });

  it("verifies only a clean revert that reports the actions it reverted", async function () {
    const prepared = await service.prepare(
      tool,
      validated({ actionIds: ["action-1"] }),
    );
    const receipts = await service.finalize(undefined, prepared, {
      ok: true,
      effect: "applied",
      content: {
        reverted: 1,
        partiallyReverted: 0,
        actionIds: ["action-1"],
      },
    });
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].verification, "verified");
    assert.equal(receipts[0].status, "applied");
    assert.deepEqual(receipts[0].appliedTargets, ["journal-action:action-1"]);
  });

  it("refuses to verify a revert that left a step partially applied", async function () {
    const prepared = await service.prepare(
      tool,
      validated({ actionIds: ["action-1"] }),
    );
    const receipts = await service.finalize(undefined, prepared, {
      ok: true,
      effect: "partial",
      content: {
        reverted: 1,
        partiallyReverted: 1,
        actionIds: ["action-1"],
      },
    });
    assert.equal(receipts[0].verification, "unverified");
    assert.equal(receipts[0].status, "unverified");
    assert.deepEqual(receipts[0].rejectedTargets, ["journal-action:action-1"]);
  });

  it("reports a cancelled revert as not_applicable", async function () {
    const prepared = await service.prepare(tool, validated({ count: 1 }));
    const receipts = await service.finalize(undefined, prepared, {
      ok: false,
      cancelled: true,
      reason: "The user declined the revert.",
    });
    assert.equal(receipts[0].verification, "not_applicable");
    assert.equal(receipts[0].status, "cancelled");
  });
});
