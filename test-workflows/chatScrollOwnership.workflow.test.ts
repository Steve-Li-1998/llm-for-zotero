import { assert } from "chai";
import { bindChatScrollLifecycle } from "../src/modules/contextPanel/chatScrollLifecycle";
import {
  getChatScrollSnapshot,
  clearChatScrollSnapshotsForTests,
  reconcileChatScroll,
  setFollowBottomChatScrollSnapshot,
  writeChatScrollTop,
} from "../src/modules/contextPanel/chatScrollSnapshots";
import { renderRenderedMarkdownInto } from "../src/modules/contextPanel/renderedMarkdown";
import {
  renderStreamingMarkdownInto,
  disposeStreamingMarkdown,
} from "../src/modules/contextPanel/streamingMarkdown";

// Real Gecko layout/events and the production lifecycle/renderers. The mounted
// panel/replay suites separately exercise the plugin's setupHandlers wiring.
describe("workflow: unified chat scroll ownership", function () {
  this.timeout(30000);
  const key = 928401;
  let root: HTMLDivElement;
  let box: HTMLDivElement;
  let answer: HTMLDivElement;
  let release: () => void;
  let doc: Document;
  let win: Window;
  const settle = () => Zotero.Promise.delay(160);
  const paragraphs = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        `Paragraph ${index + 1}. A neural population represents a stimulus through a pattern of activity across many neurons. This paragraph must remain readable while the response and window change.`,
    ).join("\n\n");
  const addMessage = (id: number, source: string) => {
    const wrapper = doc.createElement("div") as HTMLDivElement;
    wrapper.className = "llm-message-wrapper";
    Object.assign(wrapper.dataset, {
      messageRole: "assistant",
      messageTimestamp: String(id),
      messageAnchorKey: `scroll-${id}`,
    });
    const content = doc.createElement("div") as HTMLDivElement;
    content.className = "llm-assistant-answer";
    wrapper.appendChild(content);
    box.appendChild(wrapper);
    renderRenderedMarkdownInto(content, source, doc);
    return content;
  };
  const read = async (paragraph: Element) => {
    box.dispatchEvent(new win.WheelEvent("wheel", { deltaY: -10 }));
    box.scrollTop +=
      paragraph.getBoundingClientRect().top -
      box.getBoundingClientRect().top -
      10;
    box.dispatchEvent(new win.Event("scroll"));
    await settle();
    return (
      paragraph.getBoundingClientRect().top - box.getBoundingClientRect().top
    );
  };
  const offset = (element: Element) =>
    element.getBoundingClientRect().top - box.getBoundingClientRect().top;

  beforeEach(async function () {
    clearChatScrollSnapshotsForTests();
    doc = Zotero.getMainWindow().document;
    win = doc.defaultView!;
    root = doc.createElement("div") as HTMLDivElement;
    root.id = "llm-main";
    root.dataset.itemId = String(key);
    root.style.cssText =
      "position:fixed;left:20px;top:20px;width:540px;height:340px;z-index:99999;background:white";
    box = doc.createElement("div") as HTMLDivElement;
    box.id = "llm-chat-box";
    box.style.cssText =
      "height:320px;width:520px;overflow:auto;overflow-anchor:none;font:14px/1.5 sans-serif";
    root.appendChild(box);
    doc.documentElement.appendChild(root);
    answer = addMessage(1, paragraphs(35));
    release = bindChatScrollLifecycle(
      box,
      () => Number(root.dataset.itemId),
      () => {},
    );
    await settle();
    assert.isAbove(box.scrollHeight, box.clientHeight + 1000);
  });

  afterEach(function () {
    release?.();
    disposeStreamingMarkdown(answer);
    root?.remove();
  });

  it("retains the same paragraph through width/height resize plus content growth below", async function () {
    const paragraph = answer.querySelectorAll("p")[8];
    const before = await read(paragraph);
    const snapshotBefore = getChatScrollSnapshot(key, box);
    box.style.width = "380px";
    box.style.height = "290px";
    addMessage(2, paragraphs(12));
    await settle();
    assert.closeTo(
      offset(paragraph),
      before,
      1,
      JSON.stringify({
        snapshotBefore,
        snapshotAfter: getChatScrollSnapshot(key, box),
      }),
    );
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
  });

  it("preserves an answer through deferred Markdown growth above it", async function () {
    const earlier = answer;
    const later = addMessage(2, paragraphs(30));
    const paragraph = later.querySelectorAll("p")[8];
    const before = await read(paragraph);
    renderStreamingMarkdownInto(earlier, paragraphs(50), doc, () => {});
    await settle();
    assert.include(earlier.textContent || "", "Paragraph 50");
    assert.closeTo(offset(paragraph), before, 1);
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
  });

  it("keeps the answer paragraph in place when preceding thinking content collapses", async function () {
    const thinking = doc.createElement("div");
    thinking.style.height = "280px";
    answer.parentElement!.insertBefore(thinking, answer);
    const paragraph = answer.querySelectorAll("p")[8];
    const before = await read(paragraph);
    thinking.hidden = true;
    await settle();
    assert.closeTo(offset(paragraph), before, 1);
  });

  it("follows action-card growth at the bottom and yields immediately to a tiny scrollbar drag", async function () {
    setFollowBottomChatScrollSnapshot(key, box);
    reconcileChatScroll(key, box);
    const card = doc.createElement("div");
    card.className = "llm-action-inline-card";
    card.style.height = "200px";
    box.appendChild(card);
    await settle();
    assert.closeTo(box.scrollHeight - box.clientHeight - box.scrollTop, 0, 1);
    // Deliver native scroll events after an application write and a new drag.
    writeChatScrollTop(box, box.scrollHeight);
    box.scrollTop -= 2;
    card.style.height = "400px";
    await settle();
    const manualTop = box.scrollTop;
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
    card.style.height = "600px";
    await settle();
    assert.closeTo(box.scrollTop, manualTop, 1);
    box.scrollTop = box.scrollHeight;
    await settle();
    card.style.height = "700px";
    await settle();
    assert.closeTo(box.scrollHeight - box.clientHeight - box.scrollTop, 0, 1);
  });
});
