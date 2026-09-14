import { assert } from "chai";
import { readFileSync } from "node:fs";
import {
  areExternalMcpCommandsEnabled,
  areExternalMcpFilesEnabled,
  areExternalMcpWritesEnabled,
  getExternalMcpReadDirectories,
  getExternalMcpWriteDirectories,
  setExternalMcpCommandsEnabled,
  setExternalMcpFilesEnabled,
  setExternalMcpReadDirectories,
  setExternalMcpWritesEnabled,
  setExternalMcpWriteDirectories,
} from "../src/agent/mcp/prefs";

describe("external MCP write preference", function () {
  it("is disabled by default and only accepts explicit boolean opt-in", function () {
    const original = globalThis.Zotero;
    const values = new Map<string, unknown>();
    globalThis.Zotero = {
      Prefs: {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value),
      },
    } as never;
    try {
      assert.isFalse(areExternalMcpWritesEnabled());
      assert.isFalse(areExternalMcpFilesEnabled());
      assert.isFalse(areExternalMcpCommandsEnabled());
      setExternalMcpWritesEnabled(true);
      setExternalMcpFilesEnabled(true);
      setExternalMcpCommandsEnabled(true);
      assert.isTrue(areExternalMcpWritesEnabled());
      assert.isTrue(areExternalMcpFilesEnabled());
      assert.isTrue(areExternalMcpCommandsEnabled());
      setExternalMcpReadDirectories(["/papers", "/papers", ""]);
      setExternalMcpWriteDirectories(["/exports"]);
      assert.deepEqual(getExternalMcpReadDirectories(), ["/papers"]);
      assert.deepEqual(getExternalMcpWriteDirectories(), ["/exports"]);
      setExternalMcpWritesEnabled(false);
      setExternalMcpFilesEnabled(false);
      setExternalMcpCommandsEnabled(false);
      assert.isFalse(areExternalMcpWritesEnabled());
      assert.isFalse(areExternalMcpFilesEnabled());
      assert.isFalse(areExternalMcpCommandsEnabled());
    } finally {
      globalThis.Zotero = original;
    }
  });
  it("exposes the opt-in in a provider-neutral localized section", function () {
    const markup = readFileSync("addon/content/preferences.xhtml", "utf8");
    const section = markup.indexOf('id="__addonRef__-external-mcp-settings"');
    // The opt-in is library-wide rather than a runtime setting, so it closes
    // the Agent tab below the runtime rows instead of opening it.
    assert.isAbove(section, markup.indexOf('data-pref-panel="agent"'));
    assert.isAbove(
      section,
      markup.indexOf('id="__addonRef__-original-agent-card"'),
    );
    assert.isBelow(section, markup.indexOf('data-pref-panel="mineru"'));
    assert.include(markup, 'data-l10n-id="pref-external-mcp-writes"');
    assert.include(markup, 'data-l10n-id="pref-external-mcp-files"');
    assert.include(markup, 'data-l10n-id="pref-external-mcp-commands"');
    assert.include(markup, 'id="__addonRef__-external-mcp-read-directories"');
    assert.include(markup, 'id="__addonRef__-external-mcp-write-directories"');
    assert.include(
      readFileSync("addon/prefs.js", "utf8"),
      'pref("externalMcpWritesEnabled", false)',
    );
    assert.include(
      readFileSync("addon/prefs.js", "utf8"),
      'pref("externalMcpFilesEnabled", false)',
    );
    assert.include(
      readFileSync("addon/prefs.js", "utf8"),
      'pref("externalMcpCommandsEnabled", false)',
    );
  });
});
