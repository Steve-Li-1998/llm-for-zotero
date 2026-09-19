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

  it("turns a press into verdict rows, and says when no model is configured", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    await api.reset();
    const firstLine =
      "Median animal accuracy was 84% on day 1 and 85% on day 10.";
    const secondLine =
      "The population correlation fell from 0.92 to 0.61 over the same sessions.";
    const fixture = await api.createPaperWithPdfFixture({
      title: "Answer check click fixture",
      pdfTitle: "Accuracy source",
      pages: [`${firstLine}\n${secondLine}`],
    });
    try {
      await api.openStandaloneForItem(fixture.parentItemId);
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
      const cite = (id: string, quoteText: string) => {
        const citation = buildQuoteCitation({
          id,
          quoteText,
          citationLabel: "(Fixture, 2024)",
          contextItemId: fixture.pdfAttachmentId,
          itemId: fixture.parentItemId,
          sourceMatchKind: "exact",
          sourceMatchSource: "context-text",
        });
        assert.isOk(citation, `the fixture quote ${id} builds a citation`);
        return citation!;
      };
      const waitFor = async <T>(
        read: () => T | null,
        what: string,
      ): Promise<T> => {
        const deadline = Date.now() + 20000;
        for (;;) {
          const value = read();
          if (value) return value;
          assert.isBelow(Date.now(), deadline, `timed out waiting for ${what}`);
          await Zotero.Promise.delay(50);
        }
      };
      const statusText = () =>
        (win.document.querySelector("#llm-status")?.textContent || "").trim();

      const first = cite("q1", firstLine);
      const second = cite("q2", secondLine);
      await api.seedStandaloneConversation([
        { role: "user", text: "How stable was accuracy across sessions?" },
        {
          role: "assistant",
          text: `Accuracy barely moved between the two days [[quote:${first.id}]]. The correlation dropped sharply over the same sessions [[quote:${second.id}]].`,
          runMode: "agent",
          quoteCitations: [first, second],
        },
      ]);
      let seenPrompt = "";
      api.setAnswerCheckLlmCallForTests(async (request) => {
        seenPrompt = request.prompt;
        return {
          ok: true,
          text: '{"claims":[{"index":1,"verdict":"supported","note":"matches"},{"index":2,"verdict":"not_supported","note":"differs"}]}',
        };
      });
      const button = await waitFor(
        () =>
          win.document.querySelector(
            ".llm-message-action-check",
          ) as HTMLElement | null,
        "the answer check button",
      );
      button.click();
      await waitFor(
        () =>
          win.document.querySelectorAll(".llm-answer-check-row").length === 2
            ? true
            : null,
        "two verdict rows",
      );
      const rows = Array.from(
        win.document.querySelectorAll(".llm-answer-check-row"),
      ) as HTMLElement[];
      assert.deepEqual(
        rows.map((row) => row.dataset.verdict),
        ["supported", "not_supported"],
      );
      assert.include(rows[0].textContent || "", "matches");
      assert.include(
        rows[0].textContent || "",
        "Accuracy barely moved between the two days",
      );
      assert.include(rows[1].textContent || "", "differs");
      assert.include(seenPrompt, "Claim 2: The correlation dropped sharply");
      assert.include(seenPrompt, `Quoted: "${secondLine}"`);
      await waitFor(
        () => (statusText().includes("Checked 2 claims") ? true : null),
        `the status to report the check, last seen "${statusText()}"`,
      );

      // A provider the panel cannot reach must say so and draw nothing.
      api.setAnswerCheckLlmCallForTests(async () => ({
        ok: false,
        reason: "not_configured",
      }));
      await api.startNewStandaloneConversation();
      const third = cite("q3", firstLine);
      await api.seedStandaloneConversation([
        { role: "user", text: "Ask the same thing again, unconfigured." },
        {
          role: "assistant",
          text: `Accuracy barely moved between the two days [[quote:${third.id}]].`,
          runMode: "agent",
          quoteCitations: [third],
        },
      ]);
      const secondButton = await waitFor(
        () =>
          win.document.querySelector(
            ".llm-message-action-check",
          ) as HTMLElement | null,
        "the answer check button of the new conversation",
      );
      secondButton.click();
      await waitFor(
        () =>
          statusText() === "Answer check needs a configured model"
            ? true
            : null,
        `the unconfigured status, last seen "${statusText()}"`,
      );
      assert.lengthOf(
        win.document.querySelectorAll(".llm-answer-check-row"),
        0,
        "a refused check draws no rows",
      );
    } finally {
      api.setAnswerCheckLlmCallForTests(null);
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
