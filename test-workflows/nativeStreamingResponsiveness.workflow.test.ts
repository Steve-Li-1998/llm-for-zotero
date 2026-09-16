import { assert } from "chai";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: streaming in actual native chat hosts", function () {
  this.timeout(120000);
  let api: WorkflowTestApi;
  let win: any;
  const fixtures: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >[] = [];
  const readers: any[] = [];
  const measurements: unknown[] = [];
  const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
  let originalLayout: unknown;

  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 15000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
    assert.isTrue(check(), message);
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    win = Zotero.getMainWindow();
    originalLayout = Zotero.Prefs.get(layoutPref, true);
  });

  after(async function () {
    await api.closeStandalone();
    for (const reader of readers) reader.close();
    await api.reset();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    if (originalLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
    else Zotero.Prefs.set(layoutPref, originalLayout as string, true);
    await Zotero.File.putContentsAsync(
      `${Zotero.DataDirectory.dir}/native-streaming-measurements.json`,
      JSON.stringify(measurements, null, 2),
    );
  });

  for (const tabCount of [1, 4]) {
    for (const surface of ["independent", "stacked", "standalone"] as const) {
      it(`keeps streaming interactive in ${surface} with ${tabCount} retained reader tabs`, async function () {
        await api.closeStandalone();
        Zotero.Prefs.set(
          layoutPref,
          surface === "stacked" ? "stacked" : "independent",
          true,
        );
        while (readers.length < tabCount) {
          const fixture = await api.createPaperWithPdfFixture({
            title: `Native stream ${readers.length + 1}`,
            pdfTitle: `Native stream PDF ${readers.length + 1}`,
          });
          fixtures.push(fixture);
          const reader = await Zotero.Reader.open(fixture.pdfAttachmentId);
          await reader._initPromise;
          await reader._waitForReader();
          readers.push(reader);
        }
        let root: HTMLElement;
        if (surface === "standalone") {
          await api.openStandaloneForItem(fixtures[0].parentItemId);
          root = (
            Zotero as any
          ).LLMForZotero.data.standaloneWindow.document.querySelector(
            "#llm-main",
          );
        } else {
          win.Zotero_Tabs.select(readers[0].tabID);
          await until(
            () =>
              Boolean(
                getReaderContextPanelForTab(win.document, readers[0].tabID),
              ),
            "reader sidebar host exists",
          );
          const details: any = getReaderContextPanelForTab(
            win.document,
            readers[0].tabID,
          );
          await until(
            () => Boolean(details.querySelector(".llm-dedicated-chat-pane")),
            "chat section exists",
          );
          const section = details.querySelector(".llm-dedicated-chat-pane");
          if (
            details.sidenav._collapsed ||
            !["chat", "stacked"].includes(
              win.document.documentElement.getAttribute("data-llm-pane-view"),
            )
          ) {
            const button = Array.from(
              details.sidenav.querySelectorAll("[data-pane]"),
            ).find(
              (node: any) =>
                node.getAttribute("data-pane") === section.dataset.pane,
            ) as Element;
            button.dispatchEvent(
              new win.MouseEvent("click", { bubbles: true, button: 0 }),
            );
          }
          await until(
            () => !details._disableScrollHandler,
            "native pane navigation settles",
          );
          await section._forceRenderAll();
          await until(
            () =>
              Boolean(
                section.querySelector("#llm-main")?.dataset.handlersInitialized,
              ) &&
              section.querySelector("#llm-main")?.getBoundingClientRect()
                .height > 0,
            "native chat is initialized and visible",
          );
          root = section.querySelector("#llm-main");
        }
        const body = root.parentElement!;
        const styleBefore = body.getAttribute("style");
        const result = await api.exerciseNativeStreamingReplay({
          surface: surface === "standalone" ? "standalone" : "embedded",
          historyTurns: 60,
          chunks: 30,
        });
        measurements.push({ ...result, surface, tabCount });
        assert.strictEqual(
          body.querySelector("#llm-main"),
          root,
          "native lifecycle finished before replay",
        );
        assert.equal(
          body.getAttribute("style"),
          styleBefore,
          "replay preserves the actual host layout",
        );
        assert.equal(result.wrapperReplacements, 0);
        assert.equal(result.progressReplacements, 0);
        assert.equal(result.progressMutations, 0);
        assert.equal(result.ledgerReadsDuringText, 0);
        assert.isTrue(result.focusPreserved);
        assert.closeTo(result.manualScrollDelta, 0, 2);
        assert.isTrue(result.composerPreserved);
        assert.isTrue(result.exactReasoning);
        assert.isTrue(result.answerVisibleBeforeFinal);
        assert.isTrue(result.finalAnswerVisible);
        assert.isTrue(result.statusVisible);
        const inputDelays = [...result.inputFrameMs, ...result.typingFrameMs];
        assert.isNotEmpty(inputDelays);
        // A coarse freeze alarm, not a frame-rate claim on shared CI hardware.
        assert.isBelow(
          Math.max(...inputDelays),
          1000,
          "input reaches a frame without a one-second stall",
        );
        Zotero.debug(
          `NATIVE_STREAMING ${JSON.stringify({ surface, tabCount, inputDelays, renderMs: result.renderMs })}`,
          1,
        );
      });
    }
  }
});
