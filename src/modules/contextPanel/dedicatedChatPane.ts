import { installPersistentLibraryChatPane } from "./persistentLibraryChatPane";
import { getReaderContextPanelForTab } from "./readerPopupPanelRouting";

type TabSelectionObserver = {
  registerObserver: (
    observer: { notify: (event: string) => void },
    types: ["tab"],
    id: string,
  ) => string;
  unregisterObserver: (id: string) => void;
};

/**
 * Keep the native per-tab item-details host (and its render/ownership hooks),
 * but make chat and item details mutually exclusive views of the right pane.
 * Window-level presentation survives reader tab changes without owning chat
 * mode, conversation identity, drafts, or the library-chat lock.
 */
export function installDedicatedChatPane(
  doc: Document,
  notifier?: TabSelectionObserver,
): () => void {
  const root = doc.documentElement;
  const win = doc.defaultView;
  let refreshTimer: number | undefined;
  const refreshSelectedPane = () => {
    if (!win) return;
    if (refreshTimer !== undefined) win.clearTimeout(refreshTimer);
    // Native tab selection first updates its retained deck and skipRender
    // flags. Then ask the existing section lifecycle to reconcile mode/owner;
    // a cached native render otherwise leaves another tab's old Paper chat.
    refreshTimer = win.setTimeout(() => {
      refreshTimer = undefined;
      if (root.getAttribute("data-llm-pane-view") !== "chat") return;
      const tabs = (win as Window & { Zotero_Tabs?: { selectedID?: string } })
        .Zotero_Tabs;
      const host =
        getReaderContextPanelForTab(doc, tabs?.selectedID) ||
        doc.querySelector('item-details[tabType="library"]');
      const section = host?.querySelector(".llm-dedicated-chat-pane") as
        | (Element & { _forceRenderAll?: () => Promise<void> })
        | null;
      void section?._forceRenderAll?.().catch((error: unknown) => {
        Zotero.debug(
          `LLM: dedicated pane reconciliation failed: ${String(error)}`,
        );
      });
    }, 0);
  };
  root.setAttribute("data-llm-pane-view", "details");
  const disposeLibraryPane = installPersistentLibraryChatPane(doc);
  const onClick = (event: Event) => {
    if ((event as MouseEvent).button !== 0) return;
    const target = event.target as Element | null;
    const button = target?.closest?.("[data-pane]");
    const sidenav = button?.closest("item-pane-sidenav") as
      | (Element & { container?: { getPane: (id: string) => Element | null } })
      | null;
    if (!sidenav) return;
    const pane = button?.getAttribute("data-pane");
    if (!pane) return;
    root.setAttribute(
      "data-llm-pane-view",
      sidenav.container
        ?.getPane(pane)
        ?.classList.contains("llm-dedicated-chat-pane")
        ? "chat"
        : "details",
    );
    refreshSelectedPane();
  };
  // Change layout before Zotero scrolls, expands, and focuses its native pane.
  // Keyboard activation also dispatches a click through the native sidenav.
  doc.addEventListener("click", onClick, true);
  const observerID = notifier?.registerObserver(
    {
      notify: (event) => {
        if (event === "select") refreshSelectedPane();
      },
    },
    ["tab"],
    "llm-dedicated-chat-pane",
  );
  return () => {
    disposeLibraryPane();
    if (observerID) notifier?.unregisterObserver(observerID);
    if (refreshTimer !== undefined) win?.clearTimeout(refreshTimer);
    doc.removeEventListener("click", onClick, true);
    root.removeAttribute("data-llm-pane-view");
  };
}

/** Close presentation only; native hosts retain their conversation and draft. */
export function closeDedicatedChatPane(body: Element): void {
  const host = body.closest("item-details") as
    | (Element & { sidenav?: { _collapsed: boolean } })
    | null;
  if (!host?.sidenav) return;
  body.ownerDocument.documentElement.setAttribute(
    "data-llm-pane-view",
    "details",
  );
  host.sidenav._collapsed = true;
}
