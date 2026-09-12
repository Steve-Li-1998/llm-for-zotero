import { assert } from "chai";
import { createCodexNativeActivityTraceControllerForTests } from "../src/modules/contextPanel/codexNativeTrace/controller";
import {
  getAgentRunTrace,
  initAgentTraceStore,
} from "../src/agent/store/traceStore";
import { installMockDb } from "./helpers/agentRuntimeMockDb";

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

/**
 * A turn that is cancelled or fails never reaches finish(), so nothing flushes
 * the agent-message coalescers on the way out. The text they hold is real
 * commentary the model already sent, so the flows flush it before they persist
 * the turn -- otherwise the panel would show text the store never received, or
 * (after disposal) lose it entirely.
 */
describe("codex native trace controller flush before persisting", function () {
  let uninstallDb: (() => void) | null = null;

  before(async function () {
    uninstallDb = installMockDb();
    await initAgentTraceStore();
  });

  after(function () {
    uninstallDb?.();
    uninstallDb = null;
  });

  it("persists commentary that was still buffered when the turn was cancelled", async function () {
    const message: any = {
      role: "assistant",
      text: "[Cancelled]",
      timestamp: 1,
      runMode: "agent",
      agentRunId: "cancelled-native-turn",
      modelName: "gpt-5-codex",
    };
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {},
    );
    controller.appendAgentMessageDelta({
      itemId: "commentary",
      delta: "Half a sentence the model had already sent",
    });

    // The turn was interrupted: finish() never runs, so the cancel path has to
    // flush before it persists.
    controller.flushBufferedProgress("cancel");
    await controller.persist(9012, 0, "cancelled");

    const saved = await getAgentRunTrace("cancelled-native-turn");
    assert.equal(saved.run?.status, "cancelled");
    assert.deepEqual(
      saved.events.map((event: any) => event.payload.type),
      ["codex_progress"],
      "the buffered commentary reached the store",
    );
    assert.include(
      (saved.events[0].payload as any).text,
      "Half a sentence the model had already sent",
    );
    assert.deepEqual(
      message.pendingAgentTraceEvents.map((event: any) => event.payload),
      saved.events.map((event: any) => event.payload),
      "what the panel renders and what the store holds agree",
    );
  });
});
