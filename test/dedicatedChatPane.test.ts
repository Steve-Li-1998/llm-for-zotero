import { assert } from "chai";
import { installDedicatedChatPane } from "../src/modules/contextPanel/dedicatedChatPane";

function harness() {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, EventListener>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let refreshCount = 0;
  let notify: ((event: string) => void) | undefined;
  let subscribed = false;
  const root = {
    getAttribute: (key: string) => attributes.get(key),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
  };
  const doc = {
    querySelectorAll: () => [],
    defaultView: {
      Zotero_Tabs: { selectedID: "zotero-pane" },
      setTimeout(callback: () => void) {
        timers.set(++nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
    getElementById: () => null,
    querySelector: () => ({
      querySelector: () => ({
        _forceRenderAll: async () => {
          refreshCount++;
        },
      }),
    }),
    documentElement: root,
    addEventListener: (name: string, listener: EventListener) =>
      listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as Document;
  const dispose = installDedicatedChatPane(doc, {
    registerObserver(observer) {
      notify = observer.notify;
      subscribed = true;
      return "test";
    },
    unregisterObserver() {
      subscribed = false;
    },
  });
  return {
    attributes,
    listeners,
    dispose,
    notify: (event: string) => notify?.(event),
    refreshCount: () => refreshCount,
    subscribed: () => subscribed,
    pendingTimers: () => timers.size,
    flush() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
    click(pane: string, options: { button?: number; nav?: boolean } = {}) {
      const nav = {
        container: {
          getPane: (id: string) => ({
            classList: { contains: () => id === "plugin-namespaced-chat" },
          }),
        },
      };
      const target = {
        getAttribute: () => pane,
        closest: (selector: string) =>
          selector === "item-pane-sidenav"
            ? options.nav === false
              ? null
              : nav
            : target,
      };
      listeners.get("click")?.({
        target,
        button: options.button || 0,
      } as unknown as Event);
    },
  };
}

describe("dedicated chat pane navigation", function () {
  it("starts with Zotero details and opens chat through its icon", function () {
    const h = harness();
    assert.equal(h.attributes.get("data-llm-pane-view"), "details");
    h.click("plugin-namespaced-chat");
    assert.equal(h.attributes.get("data-llm-pane-view"), "chat");
    h.click("plugin-namespaced-chat");
    assert.equal(h.attributes.get("data-llm-pane-view"), "chat");
  });

  it("returns to details or reader notes through their native icons", function () {
    const h = harness();
    for (const pane of ["info", "abstract", "context-notes"]) {
      h.click("plugin-namespaced-chat");
      h.click(pane);
      assert.equal(h.attributes.get("data-llm-pane-view"), "details");
    }
  });

  it("ignores context clicks and similarly marked content outside navigation", function () {
    const h = harness();
    h.click("plugin-namespaced-chat", { button: 2 });
    h.click("plugin-namespaced-chat", { nav: false });
    assert.equal(h.attributes.get("data-llm-pane-view"), "details");
  });

  it("removes presentation and listeners when the window closes", function () {
    const h = harness();
    h.click("plugin-namespaced-chat");
    h.dispose();
    h.dispose();
    assert.isFalse(h.attributes.has("data-llm-pane-view"));
    assert.equal(h.listeners.size, 0);
    assert.isFalse(h.subscribed());
    assert.equal(h.pendingTimers(), 0);
  });

  it("rechecks the native conversation on tab selection only while chat is active", function () {
    const h = harness();
    h.notify("select");
    h.flush();
    assert.equal(h.refreshCount(), 0);
    h.click("plugin-namespaced-chat");
    h.flush();
    assert.equal(h.refreshCount(), 1);
    h.notify("select");
    h.notify("select");
    assert.equal(h.refreshCount(), 1, "wait for native deck selection");
    h.flush();
    assert.equal(h.refreshCount(), 2, "coalesce rapid tab changes");
    h.click("info");
    h.notify("select");
    h.flush();
    assert.equal(h.refreshCount(), 2);
  });
});
