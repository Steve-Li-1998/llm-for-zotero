import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";

/**
 * A turn that wrote a note and also changed the library, in the running
 * application.
 *
 * The panel used to answer such a turn with a stack: a saved-note card, and a
 * separate list of what the turn did. It is now one card whose note is a row
 * the reader can fold open, and whose chips are the way back to the paper, the
 * tag and the collection the turn actually touched. Both halves of that are
 * only true against a live Zotero: the chips are drawn from the receipts the
 * installed tools journal, and clicking one has to move the real items pane
 * and the real collection tree.
 */
describe("workflow: one action card for a mixed turn", function () {
  this.timeout(120000);

  afterEach(function () {
    assert.lengthOf(
      Zotero.getMainWindow().document.querySelectorAll(
        '[data-llm-workflow-test="true"]',
      ),
      0,
      "action-card tests must not leave panel hosts for later workflows",
    );
  });

  it("folds the note into one card and its chips move the live pane", async function () {
    const api = (Zotero as any).LLMForZotero.api;
    const workflow = api.workflowTest as WorkflowTestApi;
    const pane = Zotero.getActiveZoteroPane();
    const originalMode = getOriginalAgentPermissionMode();
    const libraryID = Zotero.Libraries.userLibraryID;
    const stamp = Date.now();
    const tag = `action-card-tag-${stamp}`;
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = libraryID;
    parent.setField("title", `Mixed turn paper ${stamp}`);
    await parent.saveTx();
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID;
    collection.name = `Mixed turn collection ${stamp}`;
    await collection.saveTx();
    let root: HTMLElement | null = null;
    try {
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode("yolo");
      const gateway = new ZoteroGateway();
      const contracts = new ActionContractService(gateway);
      const registry = new AgentToolRegistry(contracts);
      // The installed plugin's own tool closures, with its initialized
      // toolkit, persistence and journal — not a test-bundle copy.
      for (const name of ["note_write", "library_update"])
        registry.register(api.agent.getToolDefinition(name));
      const context: AgentToolContext = {
        request: {
          conversationKey: parent.id,
          mode: "agent",
          userText: "Note this paper, tag it, and file it",
          activeItemId: parent.id,
          libraryID,
          executionContext: {
            version: 1,
            executionId: `mixed-turn:${stamp}`,
            conversationKey: parent.id,
            conversationGeneration: 0,
            chatLibraryID: libraryID,
            permissionOwner: "original_agent",
            workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
            configuredAccess: {
              libraryIDs: [libraryID],
              outputDirectories: [],
            },
          },
        },
        item: parent,
        modelName: "workflow",
        currentAnswerText: "",
        runId: `mixed-turn-run:${stamp}`,
      };
      let callCount = 0;
      async function call(
        name: string,
        args: Record<string, unknown>,
      ): Promise<AgentToolResult> {
        let execution = await registry.prepareExecution(
          { id: `${name}-${++callCount}`, name, arguments: args },
          context,
          { callerKind: "model" },
        );
        if (execution.kind === "confirmation")
          execution = await execution.execute({ approved: true });
        assert.equal(execution.kind, "result", `${name} must reach a result`);
        if (execution.kind !== "result")
          throw new Error(`${name} did not execute`);
        const result = execution.execution.result;
        assert.isTrue(result.ok, JSON.stringify(result.content));
        return result;
      }
      async function waitFor<T>(
        read: () => T | null | undefined | false,
        what: string,
      ): Promise<T> {
        const deadline = Date.now() + 10000;
        for (;;) {
          const value = read();
          if (value) return value as T;
          if (Date.now() > deadline)
            throw new Error(`Timed out waiting for ${what}`);
          await Zotero.Promise.delay(25);
        }
      }

      const noteResult = await call("note_write", {
        mode: "create",
        target: "item",
        targetItemId: parent.id,
        content: "# Mixed turn note\n\nWhat the turn wrote down.",
      });
      const tagResult = await call("library_update", {
        kind: "tags",
        action: "add",
        itemIds: [parent.id],
        tags: [tag],
      });
      await parent.reload(undefined, true);
      assert.lengthOf(parent.getNotes(), 1, "the turn wrote one child note");
      const note = Zotero.Items.get(parent.getNotes()[0]);
      await note.reload(undefined, true);
      assert.include(
        parent.getTags().map((entry) => entry.tag),
        tag,
        "the turn tagged the real paper",
      );

      const panel = await workflow.renderPanelForItem(parent.id);
      root = workflow.renderToolResultForPanel(panel.panelId, tagResult, {
        priorResults: [noteResult],
        userText: "Note this paper and tag it",
      });
      const mixed = root!.querySelectorAll<HTMLElement>(
        ".llm-agent-action-summary-card",
      );
      assert.lengthOf(mixed, 1, "a turn states what it did once");
      const card = mixed[0];
      assert.equal(
        card.dataset.mode,
        "action",
        "a note beside another action is one of the things the turn did",
      );
      assert.equal(
        card.querySelector(".llm-plan-header .llm-plan-status")?.textContent,
        "2 actions",
      );
      assert.lengthOf(
        root!.querySelectorAll(".llm-saved-note-card, .llm-note-change-card"),
        0,
        "the note is inside the card, not beside it",
      );
      const rows = card.querySelectorAll<HTMLDetailsElement>(
        "details.llm-agent-action-row",
      );
      assert.lengthOf(rows, 1, "the note write is the row with a body");
      const row = rows[0];
      assert.isFalse(row.open, "a row beside other actions starts folded");
      assert.isNull(
        card.querySelector(".llm-note-preview"),
        "a folded row reads nothing back from disk",
      );
      assert.include(
        [...card.querySelectorAll(".llm-note-context-chip")].map(
          (chip) => chip.textContent,
        ),
        note.getNoteTitle(),
        "the row names the note it wrote",
      );
      const tagTitle = [
        ...card.querySelectorAll<HTMLElement>(".llm-tag-chip-title"),
      ].find((chip) => chip.textContent === tag)!;
      assert.exists(tagTitle, "the row names the tag it applied");
      // A chip is a link only where this window can take the reader. The tag's
      // destination is Zotero's own tag selector, which exists only while the
      // tag pane is mounted, so the chip follows what the live window offers.
      assert.equal(
        tagTitle
          .closest(".llm-tag-context-chip")!
          .classList.contains("llm-agent-action-link"),
        typeof (pane as any).tagSelector?.handleTagSelected === "function",
        "the tag chip links exactly when the live tag selector can be filtered",
      );

      row.querySelector("summary")!.click();
      const preview = await waitFor(
        () => card.querySelector<HTMLElement>(".llm-note-preview"),
        "the note preview the opened row builds",
      );
      assert.isTrue(row.open, "clicking the row's summary opens it");
      assert.isAbove(
        preview.getBoundingClientRect().height,
        0,
        "the opened row shows the note on screen",
      );
      assert.include(preview.textContent, "What the turn wrote down.");

      root.remove();
      root = null;
      const moveResult = await call("library_update", {
        kind: "collections",
        action: "add",
        itemIds: [parent.id],
        targetCollectionId: collection.id,
      });
      await parent.reload(undefined, true);
      assert.include(
        parent.getCollections(),
        collection.id,
        "the turn filed the real paper",
      );

      root = workflow.renderToolResultForPanel(panel.panelId, moveResult, {
        priorResults: [noteResult, tagResult],
        userText: "Note this paper, tag it, and file it",
      });
      const filed = root!.querySelector<HTMLElement>(
        ".llm-agent-action-summary-card",
      )!;
      const pill = filed.querySelector<HTMLElement>(
        ".llm-plan-header .llm-plan-status",
      )!;
      assert.equal(pill.textContent, "3 actions");

      const paperChip = filed.querySelector<HTMLElement>(
        ".llm-paper-context-chip.llm-agent-action-link",
      )!;
      assert.exists(paperChip, "the paper the turn acted on is a way in");
      assert.include(
        paperChip.textContent,
        `Mixed turn paper ${stamp}`,
        "the chip names the paper by what the library calls it",
      );
      paperChip.click();
      await waitFor(
        () => pane.getSelectedItems().some((item) => item.id === parent.id),
        "the items pane to select the paper the chip names",
      );

      const collectionChip = filed.querySelector<HTMLElement>(
        ".llm-collection-context-chip",
      )!;
      assert.exists(collectionChip, "the turn's destination has a chip");
      assert.include(
        collectionChip.className,
        "llm-agent-action-link",
        "a collection the receipt identified is a way in",
      );
      assert.include(collectionChip.textContent, collection.name);
      collectionChip.click();
      await waitFor(
        () => pane.getSelectedCollection(true) === collection.id,
        "the collection tree to select the collection the chip names",
      );
      assert.equal(pane.getSelectedCollection(true), collection.id);
      assert.notEqual(
        pill.dataset.status,
        "error",
        `a live navigation must not report a missing target: ${pill.textContent}`,
      );
    } finally {
      root?.remove();
      setOriginalAgentPermissionMode(originalMode);
      await workflow.reset();
      try {
        await (pane.collectionsView as any)?.selectLibrary?.(libraryID);
      } catch {
        /* The reader's own view is restored where the tree allows it. */
      }
      await parent.eraseTx();
      await collection.eraseTx();
      try {
        const tagID = Zotero.Tags.getID(tag);
        if (tagID) await Zotero.Tags.removeFromLibrary(libraryID, tagID);
      } catch {
        /* Leave no fixture tag behind, but never fail the run over one. */
      }
    }
  });
});
