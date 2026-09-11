import { assert } from "chai";
import type { AgentRunEventRecord } from "../src/agent/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: Plan trace presentation", function () {
  this.timeout(30000);

  it("hides continuation bookkeeping and keeps the Resume label centered inside a properly sized button", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Plan trace presentation fixture",
      pages: ["Disposable trace presentation fixture."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const doc = Zotero.getMainWindow().document;
      const events: AgentRunEventRecord[] = [
        {
          runId: "presentation",
          seq: 1,
          eventType: "status",
          createdAt: 1,
          payload: {
            type: "status",
            text: "Continuing agent (segment 2, 6/32)",
          },
        },
        {
          runId: "presentation",
          seq: 2,
          eventType: "status",
          createdAt: 2,
          payload: {
            type: "status",
            text: "Checkpointed agent segment 2; continuing",
          },
        },
        {
          runId: "presentation",
          seq: 3,
          eventType: "plan_execution_updated",
          createdAt: 3,
          payload: {
            type: "plan_execution_updated",
            ledger: {
              executionId: "presentation",
              status: "interrupted",
              tasks: [],
            } as any,
          },
        },
      ];
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Execute the approved plan",
        "",
        {
          runMode: "agent",
          pendingAgentTraceEvents: events,
        },
      );
      const messages = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"] .llm-messages`,
      )!;
      assert.notInclude(messages.textContent || "", "Continuing agent");
      assert.notInclude(messages.textContent || "", "Checkpointed agent");
      const card = messages.querySelector<HTMLElement>(
        ".llm-plan-recovery-card",
      )!;
      assert.exists(card, "the latest interrupted execution offers recovery");
      const button = card.querySelector("button")!;
      const label = button.querySelector(".llm-plan-action-label-full")!;
      const root = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"] .llm-panel`,
      )!;
      const oldScale = root.style.getPropertyValue("--llm-font-scale");
      try {
        for (const [width, scale] of [
          [280, 1.5],
          [390, 1],
          [520, 1],
        ]) {
          card.style.width = `${width}px`;
          root.style.setProperty("--llm-font-scale", `${scale}`);
          await Zotero.Promise.delay(50);
          const action = button.getBoundingClientRect();
          const copy = label.getBoundingClientRect();
          assert.closeTo(
            copy.left + copy.width / 2,
            action.left + action.width / 2,
            1,
            `label horizontally centered inside the button at ${width}px`,
          );
          assert.closeTo(
            copy.top + copy.height / 2,
            action.top + action.height / 2 - 1,
            1,
            `label vertically centered with the existing Plan optical offset at ${width}px`,
          );
          const style = doc.defaultView!.getComputedStyle(button);
          assert.closeTo(
            parseFloat(style.fontSize),
            11 * scale,
            0.1,
            "the font scale changes the rendered button label size",
          );
          assert.equal(style.borderRadius, "7px");
          assert.equal(style.appearance, "none");
          assert.isAtLeast(
            action.height,
            copy.height + 8,
            `label retains vertical button padding: ${JSON.stringify({
              height: style.height,
              minHeight: style.minHeight,
              maxHeight: style.maxHeight,
              padding: style.padding,
              lineHeight: style.lineHeight,
              boxSizing: style.boxSizing,
            })}`,
          );
          assert.isAtLeast(
            action.width,
            copy.width + 20,
            "label retains horizontal button padding",
          );
          assert.equal(
            doc.defaultView!.getComputedStyle(button).alignItems,
            "center",
          );
          assert.equal(
            doc.defaultView!.getComputedStyle(button).justifyContent,
            "center",
          );
          assert.isAtMost(
            card.scrollWidth,
            card.clientWidth + 1,
            `no clipped recovery content at ${width}px`,
          );
        }
      } finally {
        if (oldScale) root.style.setProperty("--llm-font-scale", oldScale);
        else root.style.removeProperty("--llm-font-scale");
      }
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
