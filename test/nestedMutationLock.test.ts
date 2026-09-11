import { assert } from "chai";
import { executeExternalMutation } from "../src/agent/services/externalMutationCoordinator";
import { executeLibraryMutationAction } from "../src/agent/services/mutationCoordinator";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

describe("native mutation lock ownership", function () {
  it("lets a composite coordinator delegate the native write lock to its child", async function () {
    const originalZotero = globalThis.Zotero;
    globalThis.Zotero = { DB: new ChangeJournalTestDb() } as never;
    await initAgentChangeJournal();
    const context = {
      request: { conversationKey: 51 },
      currentAnswerText: "",
      item: null,
      modelName: "test",
      journalFallbackApproved: true,
    } as AgentToolContext;

    try {
      const composite = executeLibraryMutationAction({
        context,
        facadeToolName: "note_write",
        operations: [
          {
            type: "save_notes_batch",
            notes: [{ targetItemId: 1, content: "Prepared note" }],
          },
        ],
        service: {
          planOperation: async () => ({
            effect: "write" as const,
            reversibility: "full" as const,
            description: "Write one prepared child note",
          }),
          executeOperation: async (_operation, childContext) => {
            assert.match(
              childContext.journalChildActionPrefix || "",
              /^action-[^:]+:child:1$/,
            );
            const child = await executeExternalMutation({
              context: childContext,
              toolName: "note_write",
              plan: {
                operation: "create_note",
                description: "Create the prepared child note",
                forward: { key: "NOTE0001" },
                reversibility: "full",
              },
              execute: async () => ({
                result: { noteId: 1 },
                effect: "applied",
                affectedCount: 1,
              }),
            });
            return {
              result: child.content,
              effect: child.effect,
              affectedCount: 1,
            };
          },
          captureOperationState: async () => ({
            version: 1,
            operation: "save_notes_batch",
          }),
        },
      } as Parameters<typeof executeLibraryMutationAction>[0]);

      const outcome = await Promise.race([
        composite,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("nested native mutation lock deadlocked")),
            100,
          ),
        ),
      ]);

      assert.equal(outcome.effect, "applied");
      assert.equal(outcome.results[0]?.noteId, 1);
      assert.isString(outcome.results[0]?.actionId);
      assert.notEqual(outcome.results[0]?.actionId, outcome.actionId);
    } finally {
      globalThis.Zotero = originalZotero;
    }
  });
});
