import { assert } from "chai";
import { createRunCommandTool } from "../src/agent/tools/write/runCommand";
import { createTestActionContractService } from "./helpers/actionContractService";

/**
 * run_command had no test file of its own, so nothing pinned the two facts the
 * rest of the effect path depends on: what it proposes, and what its receipt
 * claims to have verified. Phase 3 changes receipt semantics tool by tool;
 * these are the characterizations those changes must not break silently.
 */
describe("run_command effect path", function () {
  const tool = createRunCommandTool();
  const service = createTestActionContractService();

  const validated = (command: string) => {
    const input = tool.validate({ command });
    if (!input.ok) throw new Error(input.error);
    return input.value;
  };

  it("proposes only a command fingerprint, never the raw command as a target", async function () {
    const proposals = await tool.describeAction!(
      validated("rm -rf /tmp/run-command-target"),
    );
    assert.lengthOf(proposals, 1);
    const proposal = proposals[0];
    assert.equal(proposal.operation, "command_execute");
    assert.equal(proposal.capability, "command.execute");
    assert.equal(proposal.proofDomain, "execution");
    assert.equal(proposal.source, "command");
    assert.deepEqual(proposal.requestedTargets, []);
    assert.deepEqual(proposal.destinationCollectionIds, []);
    assert.match(
      String(proposal.parameters?.commandFingerprint),
      /^fnv1a32:[0-9a-f]{8}$/,
    );
    assert.notInclude(
      JSON.stringify(proposal),
      "/tmp/run-command-target",
      "the exact command is bound by the proposal digest, not republished as a target",
    );
  });

  it("fingerprints differ per command and are stable for the same command", async function () {
    const fingerprint = async (command: string) =>
      (await tool.describeAction!(validated(command)))[0].parameters
        ?.commandFingerprint;
    assert.equal(await fingerprint("echo one"), await fingerprint("echo one"));
    assert.notEqual(
      await fingerprint("echo one"),
      await fingerprint("echo two"),
    );
  });

  it("mints an execution_only receipt because a shell command has no re-readable state", async function () {
    const prepared = await service.prepare(
      tool,
      validated("rm -rf /tmp/run-command-target"),
    );
    const receipts = await service.finalize(undefined, prepared, {
      ok: true,
      effect: "applied",
      content: { exitCode: 0, stdout: "" },
    });
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].operation, "command_execute");
    assert.equal(receipts[0].proofDomain, "execution");
    assert.equal(receipts[0].verification, "execution_only");
    assert.equal(receipts[0].status, "observed");
    assert.deepEqual(receipts[0].appliedTargets, []);
  });

  it("reports a cancelled command as not_applicable, never as executed", async function () {
    const prepared = await service.prepare(tool, validated("echo cancelled"));
    const receipts = await service.finalize(undefined, prepared, {
      ok: false,
      cancelled: true,
      reason: "The user declined the command.",
    });
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].verification, "not_applicable");
    assert.equal(receipts[0].status, "cancelled");
  });
});
