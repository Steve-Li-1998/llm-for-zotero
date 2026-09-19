/** Native behavior checks for the ordinary Chat rendering path. */
import {
  buildAgentEngineDepsForTests,
  ensureConversationLoaded,
  getConversationKey,
  requestChatScrollFollowBottom,
} from "./chat";
import {
  chatHistory,
  nextRequestId,
  tryBeginRequest,
  finishRequest,
} from "./state";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import { persistChatScrollSnapshotForConversationKey } from "./chatScrollSnapshots";
import type { Message } from "./types";

export async function exerciseChatRenderingLifecycle(panel: {
  body: HTMLElement;
  item: Zotero.Item;
}) {
  const { body, item } = panel;
  const doc = body.ownerDocument;
  const win = doc.defaultView!;
  const previousStyle = body.getAttribute("style");
  if (body.hasAttribute("data-llm-workflow-test")) {
    body.style.left = "0";
    body.style.zIndex = "99999";
  }
  await ensureConversationLoaded(item);
  const key = getConversationKey(item);
  const timestamp = Date.now();
  const message: Message = {
    role: "assistant",
    text: "",
    timestamp: timestamp + 3,
    runMode: "chat",
    streaming: true,
    modelName: "Replay model",
    reasoningSummary: "Original **thinking**.",
    reasoningOpen: true,
  };
  chatHistory.set(key, [
    { role: "user", text: "Earlier question", timestamp },
    {
      role: "assistant",
      text: "A completed historical paragraph with retained evidence.\n\n".repeat(
        40,
      ),
      timestamp: timestamp + 1,
    },
    { role: "user", text: "New question", timestamp: timestamp + 2 },
    message,
  ]);
  const requestId = nextRequestId();
  if (!tryBeginRequest(key, requestId, null))
    throw new Error("Replay conversation is busy");
  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const ui = deps.getPanelRequestUI(body);
  const helpers = deps.createPanelUpdateHelpers(body, item, key, ui);
  const box = body.querySelector<HTMLDivElement>("#llm-chat-box")!;
  const wrapper = () =>
    box.querySelector<HTMLElement>(
      `.llm-message-wrapper[data-message-timestamp="${message.timestamp}"]`,
    )!;
  const settle = () => Zotero.Promise.delay(160);
  try {
    helpers.refreshChatSafely();
    await settle();
    const initialWrapper = wrapper();
    message.text =
      "# Stable heading\n\nStable paragraph for selection.\n\nSecond paragraph.\n\nUnfinished tail";
    helpers.refreshAssistantMessageSafely(message);
    await settle();
    const heading = wrapper().querySelector("h1,h2,h3,h4");
    const paragraph = wrapper().querySelector(".llm-assistant-answer p")!;
    const thinking = wrapper().querySelector<HTMLDetailsElement>(
      ".llm-agent-reasoning",
    )!;
    const composer = ui.inputBox!;
    composer.value = "Preserved draft";
    composer.focus({ preventScroll: true });
    const historicalParagraph = box.querySelector(
      ".llm-message-wrapper.assistant .llm-assistant-answer p",
    )!;
    box.dispatchEvent(
      new win.WheelEvent("wheel", { deltaY: -100, bubbles: true }),
    );
    box.scrollTop = 10;
    persistChatScrollSnapshotForConversationKey(key, box);
    const before =
      historicalParagraph.getBoundingClientRect().top -
      box.getBoundingClientRect().top;
    for (let n = 0; n < 4; n++) {
      message.text += ` with evidence ${n}.`;
      helpers.refreshAssistantMessageSafely(message);
      await settle();
    }
    const stableWrapper = wrapper() === initialWrapper;
    const stableHeading = wrapper().querySelector("h1,h2,h3,h4") === heading;
    const thinkingPreserved =
      wrapper().querySelector(".llm-agent-reasoning") === thinking &&
      thinking.open;
    const composerPreserved =
      composer.value === "Preserved draft" && doc.activeElement === composer;
    const manualScrollDelta =
      historicalParagraph.getBoundingClientRect().top -
      box.getBoundingClientRect().top -
      before;
    const selection = win.getSelection()!;
    const range = doc.createRange();
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
    const selectedText = selection.toString();
    message.text += " More streaming text.";
    helpers.refreshAssistantMessageSafely(message);
    await settle();
    const selectionPreserved =
      Boolean(selectedText) &&
      selection.toString() === selectedText &&
      paragraph.isConnected;
    selection.removeAllRanges();
    requestChatScrollFollowBottom(body, item, box);
    for (let n = 0; n < 3; n++) {
      message.text += "\n\nFollowing additional content at the bottom. ".repeat(
        8,
      );
      helpers.refreshAssistantMessageSafely(message);
      await settle();
    }
    const followBottomGap = box.scrollHeight - box.clientHeight - box.scrollTop;
    message.reasoningSummary = "Updated thinking remains visible.";
    message.modelName = "Updated model";
    helpers.refreshAssistantMessageSafely(message);
    await settle();
    const thinkingUpdated =
      wrapper().textContent?.includes("Updated thinking remains visible.") &&
      wrapper().textContent?.includes("Updated model");
    const quote = "The quotation remains readable throughout streaming.";
    message.text = `# Final answer\n\n> ${quote}\n>\n> (Workflow, 2026)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[source][ref]\n\n[ref]: https://example.org/paper`;
    helpers.refreshAssistantMessageSafely(message);
    await settle();
    const streamingQuoteReadable =
      wrapper().textContent?.includes(quote) &&
      !wrapper().textContent?.includes("[[quote-occurrence:");
    message.streaming = false;
    helpers.refreshAssistantMessageSafely(message);
    await settle();
    const finalQuoteReadable =
      wrapper()
        .querySelector(".llm-quote-card")
        ?.textContent?.includes(quote) &&
      !wrapper().textContent?.includes("[[quote-occurrence:");
    const finalControlsPresent = Boolean(
      wrapper().querySelector(".llm-message-action-copy"),
    );
    const canonicalFinal =
      Boolean(wrapper().querySelector("table")) &&
      Boolean(wrapper().querySelector('a[href="https://example.org/paper"]'));
    // Queue one incremental update, then finalize before its frame can run.
    message.streaming = true;
    message.text = "Before cancellation";
    helpers.refreshChatSafely();
    message.text += " stale queued text";
    helpers.refreshAssistantMessageSafely(message);
    message.text = "Preserved cancelled answer";
    message.streaming = false;
    message.interrupted = true;
    helpers.refreshChatSafely();
    await settle();
    const cancellationPreserved =
      wrapper().textContent?.includes("Preserved cancelled answer") &&
      !wrapper().textContent?.includes("stale queued text");
    return {
      stableWrapper,
      stableHeading,
      thinkingPreserved,
      composerPreserved,
      selectionPreserved,
      manualScrollDelta,
      followBottomGap,
      thinkingUpdated: Boolean(thinkingUpdated),
      streamingQuoteReadable: Boolean(streamingQuoteReadable),
      finalQuoteReadable: Boolean(finalQuoteReadable),
      finalControlsPresent,
      canonicalFinal,
      cancellationPreserved: Boolean(cancellationPreserved),
    };
  } finally {
    finishRequest(key, requestId);
    if (previousStyle === null) body.removeAttribute("style");
    else body.setAttribute("style", previousStyle);
  }
}
