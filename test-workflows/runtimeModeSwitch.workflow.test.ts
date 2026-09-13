import "./hostSurfaceBootstrap";
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";

/**
 * The author's report: after switching the chat panel from Codex mode back to
 * the original Agent mode, "everything is stuck and unusable" and Zotero cannot
 * even be quit.
 *
 * The mechanism these tests pin is not a busy main thread. The panel installs a
 * capture-phase ownership fence over pointerdown/mousedown/click/command/
 * keydown/input/change/paste/drop (`enforcePanelOwnershipForEvent` in
 * setupHandlers.ts). When the fence decides the panel no longer owns its own
 * conversation it calls `preventDefault()` + `stopImmediatePropagation()`, so
 * every click and keystroke aimed at the panel is destroyed before any handler
 * -- including the Codex toggle's own -- ever sees it. With focus inside the
 * panel that also eats Cmd+Q, which is why quitting appears impossible.
 *
 * So the assertions below are about input still reaching the panel, not about
 * what it renders.
 */
const AGENT_AND_CODEX_PREFS = {
  enableAgentMode: true,
  enableClaudeCodeMode: false,
  enableCodexAppServerMode: true,
  conversationSystem: "upstream",
  agentLibraryWriteMode: "auto",
};

async function withPrefs<T>(
  prefs: Record<string, unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(prefs)) {
    const fullKey = `${PREF_PREFIX}.${key}`;
    previous.set(fullKey, Zotero.Prefs.get(fullKey, true));
    Zotero.Prefs.set(fullKey, value, true);
  }
  try {
    return await task();
  } finally {
    for (const [fullKey, value] of previous) {
      if (value === undefined) {
        Zotero.Prefs.clear?.(fullKey, true);
      } else {
        Zotero.Prefs.set(fullKey, value, true);
      }
    }
  }
}

/**
 * One completed native Codex turn: a stage bracketing a tool call that started
 * and completed. This is what a Codex conversation the user actually worked in
 * leaves behind for the panel to re-render after a runtime switch.
 */
function buildCodexNativeTraceEvents(
  runId: string,
): import("../src/agent/types").AgentRunEventRecord[] {
  const createdAt = Date.now();
  const record = (
    seq: number,
    payload: import("../src/agent/types").AgentEvent,
  ): import("../src/agent/types").AgentRunEventRecord => ({
    runId,
    seq,
    eventType: payload.type,
    payload,
    createdAt: createdAt + seq,
  });
  return [
    record(0, {
      type: "agent_stage",
      stage: "write",
      status: "started",
      toolName: "zotero_tag",
    } as import("../src/agent/types").AgentEvent),
    record(1, {
      type: "codex_tool_activity",
      itemId: "call-1",
      phase: "started",
      toolName: "zotero_tag",
      toolLabel: "Tag items",
      args: { itemIds: [1], tag: "native-review" },
      workCategory: "write",
      mutability: "write",
    } as import("../src/agent/types").AgentEvent),
    record(2, {
      type: "codex_tool_activity",
      itemId: "call-1",
      phase: "completed",
      toolName: "zotero_tag",
      toolLabel: "Tag items",
      ok: true,
      text: "Tagged 1 item",
      workCategory: "write",
      mutability: "write",
    } as import("../src/agent/types").AgentEvent),
    record(3, {
      type: "agent_stage",
      stage: "write",
      status: "completed",
      toolName: "zotero_tag",
    } as import("../src/agent/types").AgentEvent),
  ];
}

/**
 * A turn recorded before the runtime emitted stages at all: tool work with no
 * `agent_stage` event anywhere, which is what forces the stage projection to
 * reconstruct stages while rendering.
 */
function buildLegacyAgentTraceEvents(
  runId: string,
): import("../src/agent/types").AgentRunEventRecord[] {
  const createdAt = Date.now();
  const record = (
    seq: number,
    payload: import("../src/agent/types").AgentEvent,
  ): import("../src/agent/types").AgentRunEventRecord => ({
    runId,
    seq,
    eventType: payload.type,
    payload,
    createdAt: createdAt + seq,
  });
  return [
    record(0, {
      type: "tool_call",
      callId: "legacy-1",
      name: "zotero_search",
      args: { query: "brain" },
    } as import("../src/agent/types").AgentEvent),
    record(1, {
      type: "tool_result",
      callId: "legacy-1",
      name: "zotero_search",
      ok: true,
      actionReceipts: [],
      content: { summary: "3 items" },
    } as import("../src/agent/types").AgentEvent),
    record(2, {
      type: "tool_call",
      callId: "legacy-2",
      name: "zotero_tag",
      args: { tag: "x" },
    } as import("../src/agent/types").AgentEvent),
    record(3, {
      type: "tool_result",
      callId: "legacy-2",
      name: "zotero_tag",
      ok: true,
      actionReceipts: [],
      content: { summary: "tagged" },
    } as import("../src/agent/types").AgentEvent),
    record(4, {
      type: "final",
      text: "Done.",
    } as import("../src/agent/types").AgentEvent),
  ];
}

/**
 * A native turn the user abandoned by switching runtimes: a stage that opened
 * and a tool call that started, with nothing closing either.
 */
function buildUnfinishedCodexTraceEvents(
  runId: string,
): import("../src/agent/types").AgentRunEventRecord[] {
  const createdAt = Date.now();
  const record = (
    seq: number,
    payload: import("../src/agent/types").AgentEvent,
  ): import("../src/agent/types").AgentRunEventRecord => ({
    runId,
    seq,
    eventType: payload.type,
    payload,
    createdAt: createdAt + seq,
  });
  return [
    record(0, {
      type: "agent_stage",
      stage: "retrieval",
      status: "started",
      toolName: "zotero_search",
    } as import("../src/agent/types").AgentEvent),
    record(1, {
      type: "codex_tool_activity",
      itemId: "open-call",
      phase: "started",
      toolName: "zotero_search",
      toolLabel: "Search library",
      args: { query: "unfinished" },
      workCategory: "retrieval",
      mutability: "read",
    } as import("../src/agent/types").AgentEvent),
    record(2, {
      type: "codex_progress",
      itemId: "open-call",
      text: "Still searching",
      status: "running",
    } as import("../src/agent/types").AgentEvent),
  ];
}

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

/**
 * A `setTimeout(0)` round trip on the panel's own window, so a genuinely busy
 * main thread is reported as such instead of stalling the suite forever.
 */
async function assertMainThreadResponsive(
  label: string,
  budgetMs = 2000,
): Promise<number> {
  const win = Zotero.getMainWindow();
  const started = Date.now();
  const roundTrip = await new Promise<number | null>((resolve) => {
    let settled = false;
    win.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(Date.now() - started);
    }, 0);
    win.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, budgetMs);
  });
  assert.isNotNull(
    roundTrip,
    `${label}: a setTimeout(0) round trip did not complete within ${budgetMs}ms`,
  );
  return roundTrip as number;
}

function getPanelRoot(panelId: string): HTMLElement {
  const doc = Zotero.getMainWindow().document;
  const root = doc.querySelector<HTMLElement>(
    `[data-workflow-panel-id="${panelId}"]`,
  );
  assert.isOk(root, "workflow panel root should be in the document");
  return root as HTMLElement;
}

/**
 * Does a click aimed at the panel still reach a listener on its target?
 *
 * The ownership fence runs at capture on the panel body, so a blocked click
 * never reaches any listener on the element the user aimed at. Probing with an
 * own listener separates "the button's handler decided to do nothing" from
 * "the event was destroyed before the button saw it".
 */
function clickReachesPanelTarget(panelId: string, selector: string): boolean {
  const root = getPanelRoot(panelId);
  const target = root.querySelector<HTMLElement>(selector);
  assert.isOk(target, `panel should render ${selector}`);
  let reached = 0;
  const probe = () => {
    reached += 1;
  };
  target!.addEventListener("click", probe);
  try {
    const eventCtor = (root.ownerDocument.defaultView as any)?.MouseEvent;
    target!.dispatchEvent(
      new eventCtor("click", { bubbles: true, cancelable: true }),
    );
  } finally {
    target!.removeEventListener("click", probe);
  }
  return reached > 0;
}

async function assertComposerAcceptsInput(panelId: string): Promise<void> {
  const root = getPanelRoot(panelId);
  const doc = root.ownerDocument;
  const input = root.querySelector<HTMLTextAreaElement>("#llm-input");
  assert.isOk(input, "composer should be rendered after the switch");
  const typed = `responsive ${Date.now()}`;
  input!.value = typed;
  input!.dispatchEvent(
    new (doc.defaultView as any).Event("input", { bubbles: true }),
  );
  await Zotero.Promise.delay(50);
  assert.equal(
    input!.value,
    typed,
    "composer must keep the text the user typed after the mode switch",
  );
  input!.value = "";
  input!.dispatchEvent(
    new (doc.defaultView as any).Event("input", { bubbles: true }),
  );
}

/** A keystroke aimed at the composer must not be destroyed at capture. */
function keydownReachesComposer(panelId: string): boolean {
  const root = getPanelRoot(panelId);
  const input = root.querySelector<HTMLTextAreaElement>("#llm-input");
  assert.isOk(input, "composer should be rendered");
  let reached = 0;
  const probe = () => {
    reached += 1;
  };
  input!.addEventListener("keydown", probe);
  try {
    input!.dispatchEvent(
      new (root.ownerDocument.defaultView as any).KeyboardEvent("keydown", {
        key: "q",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  } finally {
    input!.removeEventListener("keydown", probe);
  }
  return reached > 0;
}

describe("workflow: runtime mode switch", function () {
  this.timeout(120000);

  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
    Zotero.Prefs.clear?.(`${PREF_PREFIX}.lastUsedRuntimeMode`, true);
  });

  afterEach(async function () {
    while (fixtures.length) {
      await api.cleanupFixture(fixtures.pop()!);
    }
    await api.reset();
    Zotero.Prefs.clear?.(`${PREF_PREFIX}.lastUsedRuntimeMode`, true);
  });

  async function createPaper(title: string): Promise<WorkflowTestFixture> {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
    });
    fixtures.push(fixture);
    return fixture;
  }

  it("stays responsive returning to Agent mode from an empty Codex conversation", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Empty");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      const agent = await api.clickPanelRuntimeModeToggle(panel.panelId);
      assert.equal(agent.runtimeMode, "agent");

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.conversationSystem, "upstream");
      assert.equal(
        back.runtimeMode,
        "agent",
        "returning from Codex restores the agent mode the user had on",
      );

      await assertMainThreadResponsive("empty Codex conversation");
      await assertComposerAcceptsInput(panel.panelId);

      const secondCodex = await api.clickPanelSystemToggle(
        panel.panelId,
        "codex",
      );
      assert.equal(secondCodex.conversationSystem, "codex");
      const secondBack = await api.clickPanelSystemToggle(
        panel.panelId,
        "codex",
      );
      assert.equal(secondBack.conversationSystem, "upstream");
      await assertMainThreadResponsive("second empty switch");
    });
  });

  it("stays responsive returning to Agent mode from a Codex conversation with a completed turn", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Turn");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      const agent = await api.clickPanelRuntimeModeToggle(panel.panelId);
      assert.equal(agent.runtimeMode, "agent");

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");

      const runId = `mode-switch-${Date.now()}`;
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Tag every paper in this collection",
        "Tagged one item.",
        {
          runMode: "agent",
          agentRunId: runId,
          pendingAgentTraceEvents: buildCodexNativeTraceEvents(runId),
        },
      );
      await Zotero.Promise.delay(200);

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.conversationSystem, "upstream");
      assert.equal(back.runtimeMode, "agent");

      await assertMainThreadResponsive("Codex conversation with a turn");
      await assertComposerAcceptsInput(panel.panelId);

      const secondCodex = await api.clickPanelSystemToggle(
        panel.panelId,
        "codex",
      );
      assert.equal(secondCodex.conversationSystem, "codex");
      const secondBack = await api.clickPanelSystemToggle(
        panel.panelId,
        "codex",
      );
      assert.equal(secondBack.conversationSystem, "upstream");
      await assertMainThreadResponsive("second switch after a turn");
    });
  });

  it("stays responsive when the Agent toggle is pressed right after returning from Codex", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Toggle");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.conversationSystem, "upstream");

      const agent = await api.clickPanelRuntimeModeToggle(panel.panelId);
      assert.equal(agent.runtimeMode, "agent");
      await assertMainThreadResponsive("agent toggle after Codex");
      await assertComposerAcceptsInput(panel.panelId);

      const chat = await api.clickPanelRuntimeModeToggle(panel.panelId);
      assert.equal(chat.runtimeMode, "chat");
      await assertMainThreadResponsive("chat toggle after Codex");
    });
  });

  it("stays responsive returning to an Agent conversation whose trace predates stages", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Legacy Trace");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      const agent = await api.clickPanelRuntimeModeToggle(panel.panelId);
      assert.equal(agent.runtimeMode, "agent");

      // The upstream conversation the user comes back to is old: its trace
      // carries no `agent_stage` events, so the stage projection runs on it.
      const legacyRunId = `legacy-trace-${Date.now()}`;
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Summarize this paper and tag it",
        "Done.",
        {
          runMode: "agent",
          agentRunId: legacyRunId,
          pendingAgentTraceEvents: buildLegacyAgentTraceEvents(legacyRunId),
        },
      );
      await Zotero.Promise.delay(200);

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");

      const unfinishedRunId = `unfinished-${Date.now()}`;
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Start a long native run",
        "Working...",
        {
          runMode: "agent",
          agentRunId: unfinishedRunId,
          pendingAgentTraceEvents:
            buildUnfinishedCodexTraceEvents(unfinishedRunId),
        },
      );
      await Zotero.Promise.delay(200);

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.conversationSystem, "upstream");
      assert.equal(back.runtimeMode, "agent");

      await assertMainThreadResponsive("legacy trace after Codex");
      await assertComposerAcceptsInput(panel.panelId);
    });
  });

  // The reproduction of the reported failure. A library conversation switched
  // into Codex keeps the upstream global conversation key, so the panel's DOM
  // scope says "codex" while its own item still resolves to "upstream"; the
  // ownership fence then reads `stale-candidate` and destroys every click and
  // keystroke aimed at the panel, including the one that would switch back.
  it("keeps accepting input after a library conversation enters Codex", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Library");
      const panel = await api.renderPanelForItem(paper.parentItemId);
      const global = await api.togglePanelConversationMode(panel.panelId);
      assert.equal(global.conversationKind, "global");

      const codexToggle =
        ".llm-panel-runtime-system-toggle[data-conversation-system='codex']";
      assert.isTrue(
        keydownReachesComposer(panel.panelId),
        "the panel delivers keystrokes before the switch",
      );

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");
      await assertMainThreadResponsive("library conversation in Codex");
      // The panel settles into the state the reader sees before the fence is
      // probed: the divergence appears once the switch has finished applying.
      await Zotero.Promise.delay(1500);

      assert.isTrue(
        keydownReachesComposer(panel.panelId),
        "the panel must not destroy keystrokes aimed at the composer after entering Codex",
      );
      await assertComposerAcceptsInput(panel.panelId);

      // The click the reader actually makes to go back to the original Agent
      // mode, with a probe on the same element so a swallowed event is told
      // apart from a handler that ran and did nothing.
      assert.isTrue(
        clickReachesPanelTarget(panel.panelId, codexToggle),
        "the click that returns to Agent mode must reach the Codex toggle",
      );
      const deadline = Date.now() + 8000;
      let system = (await api.getDiagnostics(panel.panelId)).conversationSystem;
      while (system !== "upstream" && Date.now() < deadline) {
        await Zotero.Promise.delay(50);
        system = (await api.getDiagnostics(panel.panelId)).conversationSystem;
      }
      assert.equal(
        system,
        "upstream",
        "clicking the Codex toggle again must return to the original Agent mode",
      );
    });
  });
});
