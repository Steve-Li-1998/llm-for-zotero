import { assert } from "chai";
import { createUndoLastActionTool } from "../src/agent/tools/write/undoLastAction";
import { createTestActionContractService } from "./helpers/actionContractService";

/**
 * undo_last_action had no test file of its own. These pin the proposal it
 * freezes and, deliberately, the fact that its receipt's `verification` is read
 * from the tool's own result today rather than from the per-step native re-read
 * `changeReverter` already performs. Phase 3 task 3 moves that; until it does,
 * this is the characterization it has to change on purpose.
 */
describe("undo_last_action effect path", function () {
  const tool = createUndoLastActionTool({} as never);
  const service = createTestActionContractService();

  const validated = (args: Record<string, unknown>) => {
    const input = tool.validate(args);
    if (!input.ok) throw new Error(input.error);
    return input.value;
  };

  it("freezes the journal action it targets", async function () {
    const proposals = await tool.describeAction!(
      validated({ actionId: "action-42" }),
    );
    assert.lengthOf(proposals, 1);
    assert.equal(proposals[0].operation, "undo");
    assert.equal(proposals[0].capability, "zotero.undo");
    assert.equal(proposals[0].proofDomain, "zotero_state");
    assert.equal(proposals[0].source, "zotero_native");
    assert.deepEqual(proposals[0].requestedTargets, [
      "journal-action:action-42",
    ]);
  });

  it("names no target when the newest reversible action is chosen at run time", async function () {
    const proposals = await tool.describeAction!(validated({}));
    assert.lengthOf(proposals, 1);
    assert.equal(proposals[0].id, "undo:latest");
    assert.deepEqual(proposals[0].requestedTargets, []);
  });

  it("calls the receipt verified from the tool's own reported status", async function () {
    const prepared = await service.prepare(
      tool,
      validated({ actionId: "action-42" }),
    );
    const receipts = await service.finalize(undefined, prepared, {
      ok: true,
      effect: "applied",
      content: { status: "undone", actionId: "action-42", reverted: 1 },
    });
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].verification, "verified");
    assert.equal(receipts[0].status, "applied");
    assert.equal(receipts[0].evidenceRef, "action-42");
    assert.deepEqual(receipts[0].appliedTargets, ["journal-action:action-42"]);
  });

  it("reports a partial undo as unverified and rejects its target", async function () {
    const prepared = await service.prepare(
      tool,
      validated({ actionId: "action-42" }),
    );
    const receipts = await service.finalize(undefined, prepared, {
      ok: true,
      effect: "partial",
      content: {
        status: "partially_undone",
        actionId: "action-42",
        reverted: 0,
        partiallyReverted: 1,
      },
    });
    assert.equal(receipts[0].verification, "unverified");
    assert.equal(receipts[0].status, "unverified");
    assert.deepEqual(receipts[0].rejectedTargets, ["journal-action:action-42"]);
  });

  it("treats nothing-to-undo as already satisfied, not as a failed write", async function () {
    const prepared = await service.prepare(tool, validated({}));
    const receipts = await service.finalize(undefined, prepared, {
      ok: true,
      effect: "none",
      content: { status: "nothing_reversible", reverted: 0 },
    });
    assert.equal(receipts[0].verification, "verified");
    assert.equal(receipts[0].status, "already_satisfied");
  });
});
