import { assert } from "chai";
import { readFileSync } from "node:fs";
import {
  areExternalMcpWritesEnabled,
  setExternalMcpWritesEnabled,
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
      setExternalMcpWritesEnabled(true);
      assert.isTrue(areExternalMcpWritesEnabled());
      setExternalMcpWritesEnabled(false);
      assert.isFalse(areExternalMcpWritesEnabled());
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
    assert.include(
      readFileSync("addon/prefs.js", "utf8"),
      'pref("externalMcpWritesEnabled", false)',
    );
  });
});
