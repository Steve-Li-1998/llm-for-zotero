import { assert } from "chai";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

const SETUP_HANDLERS_PATH = "src/modules/contextPanel/setupHandlers.ts";
const SETUP_HANDLERS_DIR = "src/modules/contextPanel/setupHandlers";

function collectTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir).sort();
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTypeScriptFiles(full));
      continue;
    }
    if (full.endsWith(".ts")) files.push(full);
  }
  return files;
}

/**
 * The panel's WebChat code may live in `setupHandlers.ts` or in a module under
 * `setupHandlers/`; these characterization tests pin behaviour of the surface
 * as a whole so that moving a feature out of the monolith does not silently
 * change it.
 */
function panelSurface(): string {
  const files = collectTypeScriptFiles(
    resolve(testDir, "..", SETUP_HANDLERS_DIR),
  );
  return [
    source(SETUP_HANDLERS_PATH),
    ...files.map((file) => readFileSync(file, "utf8")),
  ].join("\n");
}

function occurrences(haystack: string, pattern: RegExp): number {
  return haystack.match(pattern)?.length ?? 0;
}

/**
 * The WebChat connection dot runs on a 5s setInterval owned by the panel's
 * setupHandlers closure. Detaching the panel body (switching Zotero items)
 * runs cleanupSetupHandlers — if that path does not stop the interval and
 * abort the preload token, every detached WebChat panel leaks a permanent
 * timer that retains its whole DOM subtree.
 */
describe("WebChat teardown", function () {
  function cleanupBody(): string {
    const setupHandlers = source(SETUP_HANDLERS_PATH);
    const start = setupHandlers.indexOf("const cleanupSetupHandlers = () => {");
    const end = setupHandlers.indexOf(
      "setupHandlersCleanupByBody.set(body, cleanupSetupHandlers);",
    );
    assert.isAbove(start, -1, "cleanupSetupHandlers not found");
    assert.isAbove(end, start, "cleanup registration not found");
    return setupHandlers.slice(start, end);
  }

  /** Effectful statements of cleanupSetupHandlers, comments stripped. */
  function cleanupStatements(): string[] {
    return cleanupBody()
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith("//") &&
          !line.startsWith("/*") &&
          !line.startsWith("*"),
      );
  }

  function indexOfStatement(match: RegExp | string, label: string): number {
    const statements = cleanupStatements();
    const index = statements.findIndex((line) =>
      typeof match === "string" ? line.includes(match) : match.test(line),
    );
    assert.isAbove(index, -1, `${label} not found in cleanupSetupHandlers`);
    return index;
  }

  it("stops the connection check when the panel body is torn down", function () {
    assert.include(cleanupBody(), "stopWebChatConnectionCheck();");
  });

  it("aborts any in-flight webchat preload when the panel body is torn down", function () {
    assert.include(cleanupBody(), "abortWebChatPreload();");
  });

  it("tears WebChat down first, before any other cleanup step", function () {
    const guard = indexOfStatement(
      "setupHandlersCleaned = true;",
      "re-entry guard",
    );
    const firstWebChat = indexOfStatement(/webchat/i, "WebChat teardown");
    assert.strictEqual(
      firstWebChat,
      guard + 1,
      "WebChat teardown must be the first effectful statement after the guard",
    );
    assert.isAbove(
      indexOfStatement("disconnectObserverCleanup?.();", "observer teardown"),
      firstWebChat,
    );
    assert.isAbove(
      indexOfStatement("disposeChatRendering(body);", "chat rendering dispose"),
      firstWebChat,
    );
  });

  it("deletes the eight panel body properties it published", function () {
    const body = cleanupBody();
    for (const property of [
      "delete (body as any).__llmApplyResolvedClaudeEffort;",
      "delete (body as any).__llmRefreshContextSourceForCurrentItem;",
      "delete (body as any)[SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY];",
      "delete (body as any)[SCHEDULE_QUEUED_FOLLOW_UP_THREAD_DRAIN_PROPERTY];",
      "delete (body as any).__llmScheduleClaudeQueueDrain;",
      "delete (body as any).__llmScheduleClaudeThreadQueueDrain;",
      "delete (body as any).__llmQueueTurnDeletion;",
      "delete (body as any).__llmSearchPanelHistory;",
    ]) {
      assert.include(body, property);
    }
  });
});

describe("WebChat connection check ownership", function () {
  it("runs exactly one five-second connection poll for the panel", function () {
    const surface = panelSurface();
    assert.strictEqual(
      occurrences(surface, /setInterval\(check, 5000\)/g),
      1,
      "expected a single connection-check interval",
    );
    assert.strictEqual(
      occurrences(surface, /clearInterval\(\w*[cC]onnectionTimer\)/g),
      1,
      "expected a single connection-check clearInterval",
    );
  });

  it("starts the poll only where the connection dot is shown", function () {
    const setupHandlers = source(SETUP_HANDLERS_PATH);
    assert.strictEqual(
      occurrences(setupHandlers, /ConnectionCheck\(dot\)/g),
      1,
      "the connection check must be started from exactly one place",
    );

    const applyStart = setupHandlers.indexOf(
      "const applyWebChatModeUI = () => {",
    );
    assert.isAbove(applyStart, -1, "applyWebChatModeUI not found");
    const applyEnd = setupHandlers.indexOf(
      "// Initialize model and preview state",
      applyStart,
    );
    assert.isAbove(applyEnd, applyStart, "applyWebChatModeUI end not found");
    const applyBody = setupHandlers.slice(applyStart, applyEnd);

    const dotAttached = applyBody.indexOf("modeChipBtn.appendChild(dot);");
    const startCall = applyBody.search(/ConnectionCheck\(dot\)/);
    assert.isAbove(dotAttached, -1, "mode chip dot attachment not found");
    assert.isAbove(
      startCall,
      dotAttached,
      "the poll must start after the dot is attached to the mode chip",
    );

    const dotRemoved = applyBody.indexOf("oldDot.remove();");
    const stopCall = applyBody.search(/stop\w*ConnectionCheck\(\);/);
    assert.isAbove(dotRemoved, -1, "mode chip dot removal not found");
    assert.isAbove(
      stopCall,
      dotRemoved,
      "the poll must stop where the dot is removed",
    );
  });
});

describe("WebChat preload ownership", function () {
  it("keeps exactly two preload launch sites, each with its own abort token", function () {
    const surface = panelSurface();
    assert.strictEqual(
      occurrences(surface, /await showWebChatPreloadScreen\(/g),
      2,
      "expected two preload launch sites",
    );
    assert.strictEqual(
      occurrences(
        surface,
        /const token = (\{ aborted: false \}|[\w.]*beginPreload\(\));/g,
      ),
      2,
      "each preload launch site must take a fresh abort token",
    );
  });

  it("shows the cold-start preload only for a WebChat panel with no session yet", function () {
    const surface = panelSurface();
    assert.match(
      surface,
      /isWebChatMode\(\) &&\s*!\w*[hH]asExistingWebChatSession\w*\(\)/,
      "cold-start preload guard not found",
    );
  });
});
