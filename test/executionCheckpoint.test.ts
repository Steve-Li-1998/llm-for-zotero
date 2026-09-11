import { assert } from "chai";
import {
  applyExecutionCheckpointUpdates,
  createEmptyExecutionCheckpoint,
  type ExecutionEvidenceInventory,
} from "../src/agent/execution/checkpoint";
import { createTaskUpdateTool } from "../src/agent/tools/plan/taskUpdate";
import { renderExecutionCheckpointBlock } from "../src/agent/model/messageBuilder";
import type {
  AgentExecutionContext,
  AgentToolContext,
  ExecutionCheckpoint,
} from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const executionContext: AgentExecutionContext = {
  version: 1,
  executionId: "execution-direct-1",
  conversationKey: 41,
  conversationGeneration: 3,
  chatLibraryID: 1,
  permissionOwner: "original_agent",
  workspaceSnapshot: {
    selectedPapers: [],
    selectedCollections: [],
  },
  configuredAccess: { libraryIDs: [1], outputDirectories: [] },
};

const evidence: ExecutionEvidenceInventory = {
  journalActionIds: new Set(["action-1"]),
  verifiedReceiptIds: new Set(["receipt-1"]),
  readEvidenceIds: new Set(["read-1"]),
  materialRefs: new Map([
    [
      "document-1:2:sha256:material",
      {
        documentId: "document-1",
        documentVersion: 2,
        contentHash: "sha256:material",
      },
    ],
  ]),
};

describe("ordinary ExecutionCheckpoint", function () {
  it("namespaces model-local IDs and applies a dependent batch atomically", function () {
    const initial = createEmptyExecutionCheckpoint(executionContext, 10);
    const updated = applyExecutionCheckpointUpdates({
      checkpoint: initial,
      updates: [
        {
          taskId: "read",
          description: "Read the selected papers",
          status: "completed",
          readEvidenceIds: ["read-1"],
        },
        {
          taskId: "save",
          description: "Save the finalized synthesis",
          dependencies: ["read"],
          status: "in_progress",
        },
      ],
      evidence,
      now: 20,
    });

    assert.deepEqual(
      updated.tasks.map((task) => ({
        taskId: task.taskId,
        dependencies: task.dependencies,
        status: task.status,
      })),
      [
        {
          taskId: "execution-direct-1:task:read",
          dependencies: [],
          status: "completed",
        },
        {
          taskId: "execution-direct-1:task:save",
          dependencies: ["execution-direct-1:task:read"],
          status: "in_progress",
        },
      ],
    );
    assert.deepEqual(updated.tasks[0].readEvidenceIds, ["read-1"]);
    assert.equal(initial.tasks.length, 0);
  });

  it("rejects one unknown evidence reference without partially applying the batch", function () {
    const initial = createEmptyExecutionCheckpoint(executionContext, 10);
    assert.throws(
      () =>
        applyExecutionCheckpointUpdates({
          checkpoint: initial,
          updates: [
            {
              taskId: "read",
              description: "Read the selected papers",
              status: "completed",
              readEvidenceIds: ["read-1"],
            },
            {
              taskId: "save",
              description: "Save the document",
              status: "completed",
              verifiedReceiptIds: ["invented-receipt"],
            },
          ],
          evidence,
          now: 20,
        }),
      "not host-verified",
    );
    assert.deepEqual(initial.tasks, []);
  });

  it("requires host-known evidence before a task can be completed", function () {
    const initial = createEmptyExecutionCheckpoint(executionContext, 10);
    assert.throws(
      () =>
        applyExecutionCheckpointUpdates({
          checkpoint: initial,
          updates: [
            {
              taskId: "done",
              description: "Claim completion",
              status: "completed",
            },
          ],
          evidence,
          now: 20,
        }),
      "host-verified evidence",
    );
    assert.throws(
      () =>
        applyExecutionCheckpointUpdates({
          checkpoint: initial,
          updates: [
            {
              taskId: "journal-only",
              description: "Do a write",
              status: "completed",
              journalActionIds: ["action-1"],
            },
          ],
          evidence,
          now: 20,
        }),
      "host-verified evidence",
    );
  });

  it("keeps a versioned MaterialRef and no document payload in task state", function () {
    const initial = createEmptyExecutionCheckpoint(executionContext, 10);
    const updated = applyExecutionCheckpointUpdates({
      checkpoint: initial,
      updates: [
        {
          taskId: "draft",
          description: "Finalize the draft",
          status: "completed",
          materialRefs: [evidence.materialRefs.values().next().value!],
        },
      ],
      evidence,
      now: 20,
    });

    assert.deepEqual(updated.tasks[0].materialRefs, [
      {
        documentId: "document-1",
        documentVersion: 2,
        contentHash: "sha256:material",
      },
    ]);
    assert.notProperty(updated.tasks[0], "markdown");
    assert.notProperty(updated.tasks[0], "payload");
  });

  it("renders only progress and evidence identities into recovery context", function () {
    const checkpoint = applyExecutionCheckpointUpdates({
      checkpoint: createEmptyExecutionCheckpoint(executionContext, 10),
      updates: [
        {
          taskId: "save",
          description: "Save the finalized synthesis",
          status: "completed",
          journalActionIds: ["action-1"],
          verifiedReceiptIds: ["receipt-1"],
        },
      ],
      evidence,
      now: 20,
    });
    const request = resolvedAgentRequest({
      conversationKey: 41,
      mode: "agent",
      userText: "Continue",
      libraryID: 1,
      executionContext,
      executionCheckpoint: checkpoint,
    });

    const rendered = renderExecutionCheckpointBlock(request);
    assert.include(rendered, "execution-direct-1:task:save");
    assert.include(rendered, "receipt-1");
    assert.include(rendered, "authority-free progress");
    assert.notInclude(rendered, "proposalId");
    assert.notInclude(rendered, "verifiedFacts");
    assert.notInclude(rendered, "executionAuthority");
  });
});

describe("task_update direct-agent batch", function () {
  function context(
    publish: (checkpoint: ExecutionCheckpoint) => Promise<void>,
  ): AgentToolContext {
    return {
      request: resolvedAgentRequest({
        conversationKey: 41,
        mode: "agent",
        userText: "Read the papers, make a synthesis, and save it",
        libraryID: 1,
        executionContext,
      }),
      runId: "run-1",
      item: null,
      currentAnswerText: "",
      modelName: "test",
      loadExecutionEvidence: async () => evidence,
      publishExecutionCheckpoint: publish,
    };
  }

  it("accepts the legacy task shorthand and the new tasks batch, but not both", function () {
    const tool = createTaskUpdateTool();
    assert.isTrue(
      tool.validate({ task: { taskId: "one", status: "pending" } }).ok,
    );
    assert.isTrue(
      tool.validate({
        tasks: [
          {
            taskId: "one",
            description: "First task",
            status: "pending",
          },
          {
            taskId: "two",
            description: "Second task",
            dependencies: ["one"],
            status: "pending",
          },
        ],
      }).ok,
    );
    const invalid = tool.validate({
      task: { taskId: "one", status: "pending" },
      tasks: [{ taskId: "two", status: "pending" }],
    });
    assert.isFalse(invalid.ok);
  });

  it("persists one complete checkpoint event for the whole ordinary batch", async function () {
    const published: ExecutionCheckpoint[] = [];
    const tool = createTaskUpdateTool();
    const validated = tool.validate({
      tasks: [
        {
          taskId: "read",
          description: "Read the selected papers",
          status: "completed",
          readEvidenceIds: ["read-1"],
        },
        {
          taskId: "synthesize",
          description: "Synthesize the findings",
          dependencies: ["read"],
          status: "in_progress",
        },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const ctx = context(async (checkpoint) => {
      published.push(structuredClone(checkpoint));
    });

    const result = (await tool.execute(validated.value, ctx)) as {
      checkpoint: ExecutionCheckpoint;
    };

    assert.lengthOf(published, 1);
    assert.deepEqual(result.checkpoint, published[0]);
    assert.deepEqual(ctx.request.executionCheckpoint, published[0]);
    assert.deepEqual(
      published[0].tasks.map((task) => task.status),
      ["completed", "in_progress"],
    );
  });

  it("does not publish or mutate request state when any update is invalid", async function () {
    let published = 0;
    const tool = createTaskUpdateTool();
    const validated = tool.validate({
      tasks: [
        {
          taskId: "read",
          description: "Read",
          status: "completed",
          readEvidenceIds: ["read-1"],
        },
        {
          taskId: "save",
          description: "Save",
          status: "completed",
          verifiedReceiptIds: ["not-real"],
        },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const ctx = context(async () => {
      published += 1;
    });

    try {
      await tool.execute(validated.value, ctx);
      assert.fail("expected evidence validation to reject the whole batch");
    } catch (error) {
      assert.include(String(error), "not host-verified");
    }
    assert.equal(published, 0);
    assert.isUndefined(ctx.request.executionCheckpoint);
  });
});
