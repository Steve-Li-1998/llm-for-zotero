import { assert } from "chai";
import { createAgentExecutionContext } from "../src/agent/execution/context";

describe("Agent execution context", function () {
  it("separates the run identity from the durable workspace snapshot", function () {
    const context = createAgentExecutionContext(
      {
        conversationKey: 7,
        conversationGeneration: 3,
        libraryID: 1,
        userText: "tag these papers",
        history: [],
        attachments: [],
        turnPaperScope: {
          libraryID: 1,
          papers: [
            {
              roles: ["active", "selected"],
              paper: {
                libraryID: 1,
                itemId: 10,
                contextItemId: 11,
                title: "Paper",
              },
            },
          ],
          collections: [],
          tags: [],
        },
      } as never,
      "run-attempt-2",
      { notesDirectory: null },
    );

    assert.equal(context.executionId, "run-attempt-2");
    assert.equal(context.conversationKey, 7);
    assert.equal(context.conversationGeneration, 3);
    assert.equal(context.permissionOwner, "original_agent");
    assert.equal(context.workspaceSnapshot.activePaper?.itemId, 10);
    assert.deepEqual(context.workspaceSnapshot.selectedPapers, [
      {
        libraryID: 1,
        itemId: 10,
        contextItemId: 11,
        title: "Paper",
      },
    ]);
  });
});
