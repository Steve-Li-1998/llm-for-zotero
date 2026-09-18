import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { collectReaderSelectionDocuments } from "../src/modules/contextPanel/readerSelection";

describe("workflow: quote acceptance from unique passage evidence", function () {
  this.timeout(120000);

  it("revalidates a stored statistical quote and navigates its native PDF anchor", async function () {
    assert.isTrue(
      Zotero.DataDirectory.dir.endsWith("/zotero-dev") ||
        Zotero.DataDirectory.dir.endsWith("/.scaffold/test/data"),
    );
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    await api.reset();
    const prose =
      "Reward-related pattern similarity increased reliably across the adolescent participants";
    const quote = `${prose} (F₂,₆₈ = 4.72; p = 0.012; N = 89)`;
    const source = `${prose} (F(268) = 4.72; p = 0.012; N = 89).`;
    const markdown = `> ${quote}\n\n(Fixture, 2024)`;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Quote acceptance fixture",
      pdfTitle: "Statistical source",
      pages: [source],
    });
    const diagnosticLog: string[] = [];
    const onDebug = (message: string) => {
      if (/quote-locator|quote validation|quote source/i.test(message))
        diagnosticLog.push(message);
    };
    Zotero.Debug.addListener(onDebug);
    let reader: any;
    try {
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setCreators([
        { creatorType: "author", firstName: "Test", lastName: "Fixture" },
      ]);
      item.setField("date", "2024");
      await item.saveTx();
      reader = await Zotero.Reader.open(fixture.pdfAttachmentId);
      await reader._initPromise;
      await reader._waitForReader();
      const pageReady = () =>
        collectReaderSelectionDocuments(reader).some((doc) =>
          doc
            .querySelector('.page[data-page-number="1"] .textLayer')
            ?.textContent?.includes("Reward-related"),
        );
      const pageDeadline = Date.now() + 15000;
      while (!pageReady() && Date.now() < pageDeadline)
        await Zotero.Promise.delay(25);
      assert.isTrue(
        pageReady(),
        "native PDF page is loaded before reopening chat",
      );
      await api.openStandaloneForItem(item.id);
      const context = {
        itemId: item.id,
        contextItemId: fixture.pdfAttachmentId,
        title: "Quote acceptance fixture",
        firstCreator: "Fixture",
        year: "2024",
      };
      await api.seedStandaloneConversation([
        { role: "user", text: "Explain the reported interaction." },
        { role: "assistant", text: markdown },
      ]);
      const conversationKey = (await api.getStandaloneDiagnostics())
        .conversationKey!;
      // The seed helper stores plain turns. Restore the durable paper context
      // of a historical user turn directly in the native fixture database.
      await Zotero.DB.queryAsync(
        "UPDATE llm_for_zotero_chat_messages SET paper_contexts_json = ?, full_text_paper_contexts_json = ? WHERE conversation_key = ? AND role = 'user'",
        [JSON.stringify([context]), JSON.stringify([context]), conversationKey],
      );
      const readStoredText = async () =>
        Zotero.DB.columnQueryAsync(
          "SELECT text FROM llm_for_zotero_chat_messages WHERE conversation_key = ? AND role = 'assistant' ORDER BY id",
          [conversationKey],
        );
      assert.deepEqual(await readStoredText(), [markdown]);

      // Clear the runtime history and reload the actual persisted answer.
      await api.reset();
      await api.openStandaloneForItem(item.id);
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
      let card: HTMLElement | null = null;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        card = win.document.querySelector(
          '.llm-quote-card[data-quote-status="verified"]',
        );
        if (card) break;
        await Zotero.Promise.delay(50);
      }
      assert.isOk(
        card,
        `stored quote should become verified; visibility=${win.document.visibilityState}; readers=${Zotero.Reader._readers.map((reader: any) => reader.itemID)}; ${diagnosticLog.join("\n")}; ${Array.from(win.document.querySelectorAll(".llm-quote-card"), (node) => node.outerHTML).join("\n")}`,
      );
      assert.lengthOf(win.document.querySelectorAll(".llm-quote-card"), 1);
      assert.include(card!.textContent || "", prose);
      const button = card!.querySelector<HTMLElement>(".llm-citation-icon")!;
      assert.isOk(button, "verified quote has a source-navigation control");
      const navigation = await api.observeCitationNavigationFocus(button);
      assert.isTrue(navigation.started);
      assert.isTrue(navigation.finished, JSON.stringify(navigation));
      assert.equal(reader.itemID, fixture.pdfAttachmentId);
      const documents = collectReaderSelectionDocuments(reader);
      assert.isTrue(
        documents.some((doc) =>
          doc
            .querySelector('.page[data-page-number="1"] .textLayer')
            ?.textContent?.includes("Reward-related"),
        ),
        "the opened native PDF contains the expected passage",
      );
      assert.isTrue(
        documents.some(
          (doc) =>
            doc.querySelector(".highlight.selected, .highlight") !== null,
        ),
        "native PDF search independently highlights the located source",
      );
      assert.deepEqual(
        await readStoredText(),
        [markdown],
        "display revalidation preserves the stored answer",
      );
    } finally {
      Zotero.Debug.removeListener(onDebug);
      await reader?.close();
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
