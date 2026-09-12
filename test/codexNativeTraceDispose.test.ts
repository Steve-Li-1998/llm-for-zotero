import { assert } from "chai";
import { createCodexNativeActivityTraceControllerForTests } from "../src/modules/contextPanel/codexNativeTrace/controller";

/**
 * End of life for one native Codex turn's trace controller.
 *
 * The controller buffers agent-message text in per-item coalescers that each
 * hold a pending timer, and it writes the turn's events straight onto the
 * assistant message it was built for. When the turn ends both have to stop:
 * a timer that fires afterwards would rewrite a message the panel has already
 * finalized and persisted, and a caller that keeps the handle must not be able
 * to reopen the trace.
 */
describe("codex native trace controller disposal", function () {
  it("drops buffered progress text instead of letting a timer deliver it after the turn", async function () {
    this.timeout(5000);
    const message: any = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
    };
    let refreshes = 0;
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {
        refreshes += 1;
      },
    );

    // Short enough to stay in the coalescer's buffer behind its flush timer.
    controller.appendAgentMessageDelta({
      itemId: "assistant-commentary",
      delta: "still buffered",
    });
    assert.isUndefined(
      message.pendingAgentTraceEvents,
      "the delta is buffered, not yet delivered",
    );

    controller.dispose();
    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.isUndefined(
      message.pendingAgentTraceEvents,
      "a disposed controller has no coalescer left to flush",
    );
    assert.equal(refreshes, 0, "and asks for no panel refresh after the turn");
  });

  it("detaches from its assistant message so later events cannot rewrite it", function () {
    const message: any = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
    };
    let refreshes = 0;
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {
        refreshes += 1;
      },
    );
    controller.appendNativePlanProgress([
      { content: "Inspect the scope", status: "completed" },
    ]);
    const delivered = message.pendingAgentTraceEvents;
    assert.equal(refreshes, 1);
    assert.deepEqual(
      delivered.map((entry: any) => entry.eventType),
      ["codex_progress"],
    );

    controller.dispose();
    controller.appendNativePlanProgress([
      { content: "Inspect the scope again", status: "running" },
    ]);
    controller.finish("final answer");

    assert.strictEqual(
      message.pendingAgentTraceEvents,
      delivered,
      "the message keeps the events it had when the turn ended",
    );
    assert.equal(refreshes, 1, "and no further refresh is requested");
  });

  it("is safe to call twice", function () {
    const message: any = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
    };
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {},
    );
    controller.dispose();
    controller.dispose();
    assert.isUndefined(message.pendingAgentTraceEvents);
  });
});
