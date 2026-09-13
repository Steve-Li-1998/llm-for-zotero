import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";

describe("workflow: dedicated native chat pane", function () {
  this.timeout(45000);
  let api: WorkflowTestApi;
  let win: any;
  let fixtures: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >[];
  const readers: any[] = [];

  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 10000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
    assert.isTrue(
      check(),
      `${message}; selected=${win.Zotero_Tabs.selectedID}; panels=${JSON.stringify(Array.from(win.document.querySelectorAll("#llm-main")).map((node: any) => ({ ...node.dataset })))}`,
    );
  }

  function activeDetails(): any {
    const readerPane = getReaderContextPanelForTab(
      win.document,
      win.Zotero_Tabs.selectedID,
    );
    if (readerPane) return readerPane;
    return Array.from(win.document.querySelectorAll("item-details")).find(
      (node: any) =>
        node.tabType === "library" && node.getBoundingClientRect().width > 0,
    );
  }

  async function clickPane(pane: string) {
    const details = activeDetails();
    assert.isOk(details, "native item details is visible");
    const paneID =
      pane === "llm-context-panel"
        ? details.querySelector(".llm-dedicated-chat-pane")?.dataset.pane
        : pane;
    const button: any = Array.from(
      details.sidenav.querySelectorAll("[data-pane]"),
    ).find((node: any) => node.getAttribute("data-pane") === paneID);
    assert.isOk(button, `native ${pane} icon exists`);
    button.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
    );
    await Zotero.Promise.delay(300);
    return details;
  }

  async function captureWindow(target: any, filename: string) {
    const canvas = target.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    const scale = target.devicePixelRatio || 1;
    canvas.width = target.innerWidth * scale;
    canvas.height = target.innerHeight * scale;
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawWindow(
      target,
      0,
      0,
      target.innerWidth,
      target.innerHeight,
      "#ffffff",
    );
    const binary = target.atob(canvas.toDataURL("image/png").split(",")[1]);
    await win.IOUtils.write(
      `${Zotero.DataDirectory.dir}/${filename}`,
      Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
    );
  }

  before(async function () {
    // Native runner always launches an isolated .scaffold/test profile/data.
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    win = Zotero.getMainWindow();
    fixtures = [];
    for (const title of ["Dedicated pane A", "Dedicated pane B"])
      fixtures.push(
        await api.createPaperWithPdfFixture({ title, pdfTitle: title }),
      );
    await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
  });

  after(async function () {
    for (const reader of readers) reader.close();
    for (const fixture of fixtures || []) await api.cleanupFixture(fixture);
    await api.reset();
  });

  it("opens from the rail without a selection and keeps Library chat locked", async function () {
    win.ZoteroPane.itemsView.selection.clearSelection();
    await Zotero.Promise.delay(400);
    const details = win.document.getElementById("zotero-item-details");
    const section = details.querySelector(".llm-dedicated-chat-pane");
    const paneID = section?.dataset.pane;
    const icon = Array.from(
      details.sidenav.querySelectorAll("[data-pane]"),
    ).find((node: any) => node.dataset.pane === paneID) as any;
    assert.isOk(icon, "plugin icon exists before selecting a paper");
    assert.isAbove(
      icon.getBoundingClientRect().height,
      0,
      "plugin icon is visible with no selection",
    );
    assert.isFalse(
      icon.hasAttribute("disabled"),
      "plugin icon remains enabled",
    );
    icon.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
    );
    await until(
      () =>
        Boolean(
          section.querySelector("#llm-main")?.dataset.handlersInitialized,
        ),
      "empty chat opens",
    );
    assert.isAbove(section.getBoundingClientRect().height, 100);
    assert.isNull(section.item, "empty chat has no stale selected paper");
    const emptyTitle = section.querySelector(".llm-docked-title-row");
    assert.isOk(
      emptyTitle,
      "empty sidebar preserves the approved branded title row",
    );
    assert.isBelow(
      emptyTitle.getBoundingClientRect().bottom,
      section.querySelector(".llm-header-top").getBoundingClientRect().top,
      "classic toolbar remains in its own second row",
    );

    await Zotero.Promise.delay(500);
    assert.equal(
      section.querySelector("#llm-title-static").getBoundingClientRect().height,
      0,
      "no duplicate title appears in the empty chat toolbar after history refresh",
    );

    assert.isOk(
      section.querySelector(".llm-start-page-title"),
      "no-selection view preserves the branded starter page",
    );
    assert.include(
      section.querySelector(".llm-start-page-title").textContent,
      "LLM-for-Zotero",
    );
    assert.isOk(section.querySelector(".llm-start-page-subtitle"));
    assert.isOk(section.querySelector(".llm-start-page-desc"));
    assert.isNull(
      section.querySelector(".llm-welcome"),
      "legacy placeholder is absent",
    );
    assert.isAtLeast(
      section.querySelector("#llm-shortcuts").children.length,
      5,
      "classic starter shortcuts remain present without a paper",
    );
    assert.isAtLeast(
      section.querySelector(".llm-start-page-title").getBoundingClientRect()
        .top,
      section.querySelector("#llm-chat-box").getBoundingClientRect().top,
      "starter title is visible from the top rather than inheriting the old bottom position",
    );
    win.resizeBy(1280 - win.innerWidth, 1000 - win.innerHeight);
    await Zotero.Promise.delay(250);
    await captureWindow(win, "empty-library-sidebar.png");
    assert.isFalse(
      section.querySelector("#llm-mode-chip").disabled,
      "empty mode control is enabled",
    );
    (section.querySelector("#llm-mode-chip") as HTMLElement).click();
    await until(
      () =>
        section.querySelector("#llm-main")?.dataset.conversationKind ===
        "global",
      "Library chat is available without a paper",
    );
    const key = section.querySelector("#llm-main").dataset.itemId;
    await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
    await until(
      () => section.querySelector("#llm-main")?.dataset.itemId === key,
      "selection preserves Library chat",
    );
    win.ZoteroPane.itemsView.selection.clearSelection();
    await Zotero.Promise.delay(400);
    await until(
      () => section.querySelector("#llm-main")?.dataset.itemId === key,
      "clearing selection preserves Library chat",
    );
    (section.querySelector(".llm-docked-close") as HTMLElement).click();
    assert.isAbove(
      icon.getBoundingClientRect().height,
      0,
      "icon stays visible after closing",
    );
    await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
    await clickPane("llm-context-panel");
    (section.querySelector("#llm-mode-chip") as HTMLElement).click();
    await until(
      () =>
        section.querySelector("#llm-main")?.dataset.conversationKind !==
        "global",
      "return to Paper chat",
    );
  });

  it("uses the whole native pane and restores details through their icon", async function () {
    const details = await clickPane("llm-context-panel");
    const section = details.querySelector(
      "item-pane-custom-section.llm-dedicated-chat-pane",
    );
    await until(
      () => Boolean(section.querySelector("#llm-main")),
      "chat rendered",
    );
    assert.equal(
      win.document.documentElement.getAttribute("data-llm-pane-view"),
      "chat",
    );
    const header = details.querySelector("item-pane-header");
    assert.equal(
      header.getBoundingClientRect().height,
      0,
      "item header is outside chat view",
    );
    for (const other of details.getPanes()) {
      if (other !== section)
        assert.equal(
          other.getBoundingClientRect().height,
          0,
          "other sections are outside chat view",
        );
    }
    const viewport = details
      .querySelector(".zotero-view-item")
      .getBoundingClientRect();
    const chat = section.getBoundingClientRect();
    assert.isAbove(chat.height, 200);
    assert.closeTo(chat.top, viewport.top, 2);
    assert.closeTo(
      chat.height,
      viewport.height,
      2,
      "chat occupies the pane height",
    );
    const input = section.querySelector("#llm-input") as HTMLTextAreaElement;
    assert.isOk(input);
    input.value = "Unsent draft remains in this conversation";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.isAtMost(
      input.getBoundingClientRect().bottom,
      viewport.bottom + 2,
      "composer stays in the pane",
    );
    const root = section.querySelector("#llm-main");
    const titleRow = section.querySelector(".llm-docked-title-row");
    assert.isOk(titleRow, "dedicated panel has its own title row");
    assert.include(titleRow.textContent, "LLM-for-Zotero");
    assert.isOk(titleRow.querySelector("img"), "title uses the plugin logo");
    const close = titleRow.querySelector(".llm-docked-close");
    assert.isOk(close, "title row has a close control");
    const toolbar = section.querySelector(".llm-header-top");
    assert.isAtLeast(
      toolbar.getBoundingClientRect().top,
      titleRow.getBoundingClientRect().bottom,
      "classic toolbar sits below the title",
    );
    assert.isNull(
      section.querySelector("[data-chat-mode]"),
      "segmented toggle is removed",
    );
    assert.isNull(
      section.querySelector(".llm-docked-more"),
      "overflow toolbar is removed",
    );
    for (const id of [
      "llm-history-new",
      "llm-history-toggle",
      "llm-mode-chip",
      "llm-popout",
      "llm-settings",
      "llm-export",
      "llm-clear",
    ]) {
      const action = toolbar.querySelector(`#${id}`);
      assert.isAbove(
        action.getBoundingClientRect().width,
        0,
        `${id} is visible in the classic toolbar`,
      );
    }
    close.click();
    await Zotero.Promise.delay(100);
    assert.isTrue(
      details.sidenav._collapsed,
      "close collapses the native sidebar",
    );
    const icon: any = Array.from(
      details.sidenav.querySelectorAll("[data-pane]"),
    ).find(
      (node: any) => node.getAttribute("data-pane") === section.dataset.pane,
    );
    icon.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
    );
    await Zotero.Promise.delay(300);
    assert.isFalse(
      details.sidenav._collapsed,
      "plugin icon reopens the sidebar",
    );
    assert.equal(
      section.querySelector("#llm-input").value,
      "Unsent draft remains in this conversation",
      "closing preserves the draft",
    );
    await clickPane("info");
    assert.equal(section.getBoundingClientRect().height, 0);
    assert.isAbove(header.getBoundingClientRect().height, 0);
    await clickPane("llm-context-panel");
    assert.strictEqual(
      section.querySelector("#llm-main"),
      root,
      "navigation preserves the mounted conversation",
    );
    assert.equal(
      (section.querySelector("#llm-input") as HTMLTextAreaElement).value,
      "Unsent draft remains in this conversation",
    );

    // Keep a native rendering artifact beside the disposable test database.
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas
      .getContext("2d")
      .drawWindow(
        win,
        viewport.left,
        viewport.top,
        canvas.width,
        canvas.height,
        "#ffffff",
      );
    const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
    await (win.IOUtils as any).write(
      `${Zotero.DataDirectory.dir}/dedicated-chat-pane.png`,
      Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
    );
  });

  it("switches sidebar layout from Customization without replacing the chat", async function () {
    let preferences: any;
    const prefKey = "extensions.zotero.llmforzotero.sidebarLayout";
    const original = Zotero.Prefs.get(prefKey, true);
    const details = await clickPane("llm-context-panel");
    const section = details.querySelector(".llm-dedicated-chat-pane");
    const root = section.querySelector("#llm-main");
    const input = section.querySelector("#llm-input");
    input.value = "Keep this draft across layout changes";
    const openPreferences = async () => {
      preferences = (Zotero.Utilities.Internal as any).openPreferences(
        "llmforzotero-preferences",
      );
      await until(
        () =>
          preferences.document.querySelector("#llmforzotero-sidebar-layout")
            ?.dataset.preferenceBound === "true",
        "sidebar layout setting exists",
      );
      preferences.document
        .querySelector('[data-pref-tab="customization"]')
        .click();
      return preferences.document.querySelector("#llmforzotero-sidebar-layout");
    };
    const choose = (select: any, value: string) => {
      select.value = value;
      const event = preferences.document.createEvent("Event");
      event.initEvent("change", true, false);
      select.dispatchEvent(event);
    };
    try {
      let select = await openPreferences();
      assert.equal(select.value, "independent", "Independent is the default");
      assert.isAbove(
        select.getBoundingClientRect().height,
        0,
        "setting is in Customization",
      );
      await captureWindow(preferences, "sidebar-layout-customization.png");
      choose(select, "stacked");
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "stacked",
        "stacked layout applies immediately",
      );
      assert.isAbove(
        details.querySelector("item-pane-header").getBoundingClientRect()
          .height,
        0,
        "native details return",
      );
      assert.equal(
        section.querySelector(".llm-docked-title-row").getBoundingClientRect()
          .height,
        0,
        "dedicated title is absent in stacked layout",
      );
      assert.isTrue(
        section.querySelector("collapsible-section").collapsible,
        "stacked section is collapsible",
      );
      assert.strictEqual(
        section.querySelector("#llm-main"),
        root,
        "layout switch preserves the mounted chat",
      );
      assert.equal(input.value, "Keep this draft across layout changes");
      preferences.close();
      await until(() => preferences.closed, "preferences close");
      await clickPane("llm-context-panel");
      assert.isAbove(
        section.getBoundingClientRect().height,
        100,
        "stacked chat is visible after clicking its rail icon",
      );
      await captureWindow(win, "stacked-sidebar.png");
      select = await openPreferences();
      assert.equal(select.value, "stacked", "layout choice is remembered");
      choose(select, "independent");
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "chat",
        "independent layout returns",
      );
      assert.isAbove(
        section.querySelector(".llm-docked-title-row").getBoundingClientRect()
          .height,
        0,
      );
      assert.equal(
        details.querySelector("item-pane-header").getBoundingClientRect()
          .height,
        0,
      );
      assert.strictEqual(section.querySelector("#llm-main"), root);
      assert.equal(input.value, "Keep this draft across layout changes");
    } finally {
      preferences?.close();
      Zotero.Prefs.set(prefKey, original || "independent", true);
    }
  });

  it("follows reader tabs and preserves an explicitly selected Library chat", async function () {
    for (const fixture of fixtures) {
      const reader = await Zotero.Reader.open(fixture.pdfAttachmentId);
      readers.push(reader);
      await reader._initPromise;
      await reader._waitForReader();
    }
    await clickPane("llm-context-panel");
    const title = activeDetails().querySelector(".llm-docked-title-row");
    const titleBounds = title.getBoundingClientRect();
    const dividerBounds = activeDetails()
      .sidenav.querySelector(".divider")
      .getBoundingClientRect();
    assert.closeTo(
      titleBounds.top,
      activeDetails().getBoundingClientRect().top,
      1,
      "title starts at the native toolbar top",
    );
    assert.closeTo(
      titleBounds.bottom,
      dividerBounds.bottom,
      1,
      "title separator aligns with the native side navigation separator",
    );
    for (const selector of [".llm-docked-brand", ".llm-docked-close"]) {
      const bounds = title.querySelector(selector).getBoundingClientRect();
      assert.closeTo(
        (bounds.top + bounds.bottom) / 2,
        (titleBounds.top + titleBounds.bottom - 1) / 2,
        0.5,
        `${selector} is vertically centered inside the title border`,
      );
    }
    const panel = () =>
      activeDetails().querySelector("#llm-main") as HTMLElement;
    await until(
      () =>
        panel()?.dataset.contextOwnerItemId ===
        String(fixtures[1].parentItemId),
      `paper B context follows its tab; selected=${win.Zotero_Tabs.selectedID}, roots=${JSON.stringify(Array.from(win.document.querySelectorAll("#llm-main")).map((node: any) => ({ ...node.dataset })))}`,
    );
    win.Zotero_Tabs.select(readers[0].tabID);
    await until(
      () =>
        panel()?.dataset.contextOwnerItemId ===
        String(fixtures[0].parentItemId),
      "paper A context follows its tab",
    );
    assert.equal(
      win.document.documentElement.getAttribute("data-llm-pane-view"),
      "chat",
    );
    (panel().querySelector("#llm-mode-chip") as HTMLElement).click();
    await until(
      () => panel()?.dataset.conversationKind === "global",
      "Library chat is selected",
    );
    const conversation = panel().dataset.itemId;
    (panel().querySelector(".llm-docked-close") as HTMLButtonElement).click();
    await clickPane("llm-context-panel");
    await until(
      () =>
        panel()?.dataset.conversationKind === "global" &&
        panel()?.dataset.itemId === conversation,
      "Library chat survives closing and reopening",
    );
    win.Zotero_Tabs.select(readers[1].tabID);
    await until(
      () =>
        panel()?.dataset.conversationKind === "global" &&
        panel()?.dataset.itemId === conversation,
      "Library chat stays locked across tabs",
    );
    (panel().querySelector("#llm-mode-chip") as HTMLElement).click();
    await until(
      () =>
        panel()?.dataset.conversationKind === "paper" &&
        panel()?.dataset.contextOwnerItemId ===
          String(fixtures[1].parentItemId),
      "Paper chat resumes with the active paper",
    );
  });
  it("keeps stacked reader contexts and no-selection rail access working", async function () {
    const key = "extensions.zotero.llmforzotero.sidebarLayout";
    try {
      Zotero.Prefs.set(key, "stacked", true);
      await clickPane("llm-context-panel");
      const panel = () => activeDetails().querySelector("#llm-main");
      assert.equal(
        win.document.documentElement.getAttribute("data-llm-pane-view"),
        "stacked",
      );
      assert.isTrue(
        activeDetails().querySelector(
          ".llm-dedicated-chat-pane > collapsible-section",
        ).collapsible,
      );
      (panel().querySelector("#llm-mode-chip") as HTMLElement).click();
      await until(
        () => panel().dataset.conversationKind === "global",
        "Library chat opens in stacked reader",
      );
      const conversation = panel().dataset.itemId;
      win.Zotero_Tabs.select(readers[0].tabID);
      await until(
        () => panel().dataset.itemId === conversation,
        "stacked reader tabs preserve Library lock",
      );
      await Zotero.Promise.delay(300);
      (panel().querySelector("#llm-mode-chip") as HTMLElement).click();
      await until(
        () =>
          panel().dataset.contextOwnerItemId ===
            String(fixtures[0].parentItemId) &&
          panel().dataset.conversationKind === "paper",
        "stacked Paper chat follows active reader",
      );
      win.Zotero_Tabs.select("zotero-pane");
      await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
      win.ZoteroPane.itemsView.selection.clearSelection();
      await Zotero.Promise.delay(300);
      await clickPane("llm-context-panel");
      await until(
        () => Boolean(panel().querySelector(".llm-start-page-title")),
        "stacked preference still provides chat with no selection",
      );
      assert.equal(
        win.document.documentElement.getAttribute("data-llm-pane-view"),
        "chat",
      );
      assert.isAbove(
        panel().querySelector(".llm-docked-title-row").getBoundingClientRect()
          .height,
        0,
      );
      await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "stacked",
        "selecting a paper restores the chosen stacked layout",
      );
    } finally {
      Zotero.Prefs.set(key, "independent", true);
    }
  });
});
