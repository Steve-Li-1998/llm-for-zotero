import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";

describe("workflow: answer check action on an agent answer", function () {
  this.timeout(120000);

  it("offers the check only where there are cited lines to check", async function () {
    assert.isTrue(
      Zotero.DataDirectory.dir.endsWith("/zotero-dev") ||
        Zotero.DataDirectory.dir.endsWith("/.scaffold/test/data"),
    );
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    await api.reset();
    const quoteText =
      "Median animal accuracy was 84% on day 1 and 85% on day 10.";
    const fixture = await api.createPaperWithPdfFixture({
      title: "Answer check fixture",
      pdfTitle: "Accuracy source",
      pages: [quoteText],
    });
    try {
      await api.openStandaloneForItem(fixture.parentItemId);
      const citation = buildQuoteCitation({
        id: "q1",
        quoteText,
        citationLabel: "(Fixture, 2024)",
        contextItemId: fixture.pdfAttachmentId,
        itemId: fixture.parentItemId,
        sourceMatchKind: "exact",
        sourceMatchSource: "context-text",
      });
      assert.isOk(citation, "the fixture quote builds a citation");
      const answer = `Median accuracy was 84% on day 1 and 85% on day 10 [[quote:${citation!.id}]]. The correlation fell from 0.92 to 0.61 across sessions.`;
      await api.seedStandaloneConversation([
        { role: "user", text: "How stable was accuracy across sessions?" },
        {
          role: "assistant",
          text: answer,
          runMode: "agent",
          quoteCitations: [citation!],
        },
      ]);
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
      let checkButton: HTMLElement | null = null;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        checkButton = win.document.querySelector(".llm-message-action-check");
        if (checkButton) break;
        await Zotero.Promise.delay(50);
      }
      assert.isOk(
        checkButton,
        `an agent answer with a citation offers the check; actions=${Array.from(
          win.document.querySelectorAll(".llm-message-actions"),
          (node) => node.outerHTML,
        ).join("\n")}`,
      );
      assert.equal(
        checkButton!.getAttribute("title"),
        "Check this answer against its sources",
      );
      assert.equal(
        (checkButton as HTMLElement & { dataset: DOMStringMap }).dataset
          .responseAction,
        "check",
      );
      // Pressing it is the only way a check ever runs, so nothing may have
      // drawn a result card before the reader asks for one.
      assert.lengthOf(
        win.document.querySelectorAll(".llm-answer-check"),
        0,
        "no check runs on its own",
      );

      const chatQuestion = "Same question, answered outside the agent runtime.";
      await api.startNewStandaloneConversation();
      await api.seedStandaloneConversation([
        { role: "user", text: chatQuestion },
        { role: "assistant", text: answer, quoteCitations: [citation!] },
      ]);
      // The standalone window is XUL, so it has a documentElement and no body.
      const renderedText = () =>
        win.document.documentElement?.textContent || "";
      const renderedDeadline = Date.now() + 20000;
      while (Date.now() < renderedDeadline) {
        if (renderedText().includes(chatQuestion)) break;
        await Zotero.Promise.delay(50);
      }
      assert.include(
        renderedText(),
        chatQuestion,
        "the chat conversation is rendered",
      );
      assert.lengthOf(
        win.document.querySelectorAll(".llm-message-action-check"),
        0,
        "a chat answer offers no answer check",
      );
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
