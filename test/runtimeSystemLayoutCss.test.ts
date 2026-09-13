import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "mocha";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

function extractCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    css.match(
      new RegExp(`^[ \t]*${escapedSelector}\\s*\\{[^}]*\\}`, "m"),
    )?.[0] || ""
  );
}

describe("runtime system control layout", function () {
  it("scales the mode chip label with the plugin font setting at every width", function () {
    const css = source("addon/content/zoteroPane.css");
    const modeChipRule = extractCssRule(css, ".llm-mode-chip");

    // The label follows --llm-font-scale like the rest of the plugin's text.
    // A static chip, or one frozen behind a width breakpoint, is a downgrade at
    // the sidebar widths people actually use — it stops responding to the font
    // size shortcuts.
    assert.include(modeChipRule, "font-size: var(--llm-fs-12)");

    // No width breakpoint may pin it either: the compact header shrinks buttons
    // to icons, but the chip keeps scaling.
    const compactBlock =
      css.match(/@container \(max-width: 380px\) \{[\s\S]*?\n\}/)?.[0] || "";
    assert.notEqual(compactBlock, "", "compact header block must still exist");
    assert.notInclude(compactBlock, ".llm-mode-chip");
  });

  it("uses the shared mask assets instead of inline runtime glyph markup", function () {
    const css = source("addon/content/zoteroPane.css");
    const sidebarSource = source("src/modules/contextPanel/buildUI.ts");
    const standaloneSource = source(
      "src/modules/contextPanel/standaloneWindow.ts",
    );

    assert.include(css, 'mask-image: url("icons/claude-code.svg")');
    assert.include(sidebarSource, "createRuntimeSystemControls");
    assert.include(standaloneSource, "createRuntimeSystemControls");
    assert.notInclude(sidebarSource, "<svg");
    assert.notInclude(standaloneSource, "20.998 10.949");
  });

  it("uses the existing compact trash icon at every sidebar width", function () {
    const css = source("addon/content/zoteroPane.css");
    const sidebarSource = source("src/modules/contextPanel/buildUI.ts");
    const handlerSource = source("src/modules/contextPanel/setupHandlers.ts");
    const standaloneSource = source(
      "src/modules/contextPanel/standaloneWindow.ts",
    );
    const deleteButtonRule = extractCssRule(css, ".llm-clear-btn");
    const deleteIconRule = extractCssRule(css, ".llm-clear-btn::before");

    assert.include(sidebarSource, "llm-btn-icon llm-clear-btn");
    assert.include(sidebarSource, 'title: t("Delete conversation")');
    assert.include(
      sidebarSource,
      'clearBtn.setAttribute("aria-label", t("Delete conversation"))',
    );
    assert.notInclude(sidebarSource, 'textContent: t("Clear")');
    assert.include(deleteButtonRule, "width: 28px");
    assert.include(deleteButtonRule, "font-size: 0");
    assert.include(deleteIconRule, "display: block");
    assert.notInclude(css, '.llm-clear-btn[data-compact="true"]');
    assert.include(css, "@container (max-width: 380px)");
    assert.equal(
      css.split('url("icons/action-clear.svg")').length - 1,
      4,
      "the sidebar and standalone masks must share the existing trash asset",
    );
    assert.notInclude(handlerSource, "syncResponsiveHeaderClearButton");
    assert.notInclude(handlerSource, "shouldCompactHeaderClearButton");
    assert.include(handlerSource, 'clearBtn.textContent = ""');
    assert.include(handlerSource, 't("Delete conversation")');
    assert.include(
      standaloneSource,
      'iconClear.title = t("Delete conversation")',
    );
    assert.notInclude(standaloneSource, 'iconClear.title = t("Clear")');
  });
});
