import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";

describe("workflow: grounding line under an agent answer", function () {
  this.timeout(120000);

  it("reports the cited share of an agent answer and stays away from chat answers", async function () {
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
      title: "Answer grounding fixture",
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
      let grounding: HTMLElement | null = null;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        grounding = win.document.querySelector(".llm-message-grounding");
        if (grounding) break;
        await Zotero.Promise.delay(50);
      }
      assert.isOk(
        grounding,
        `agent answer should carry a grounding line; meta=${Array.from(
          win.document.querySelectorAll(".llm-message-meta"),
          (node) => node.outerHTML,
        ).join("\n")}`,
      );
      assert.equal(
        (grounding!.textContent || "").trim(),
        "Cited: 1 of 2 sentences",
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
        win.document.querySelectorAll(".llm-message-grounding"),
        0,
        "a chat answer carries no grounding line",
      );
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
