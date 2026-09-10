import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "mocha";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

/**
 * The AI Providers tab used to stack always-open cards, each with its own
 * inline card/label/input style constants, a hand-drawn divider, an uppercase
 * "MODEL NAMES" heading and a destructive × in the title bar. These
 * assertions pin the shape that replaced it: the Agent tab's collapsible row,
 * rendered from the Agent tab's own stylesheet.
 */

describe("AI Providers tab layout", function () {
  it("shares one stylesheet with the Agent tab instead of a second card look", function () {
    const markup = source("addon/content/preferences.xhtml");
    const flat = markup.replace(/\s+/g, " ");

    // Both panels wear the class the row rules are scoped to, so there is one
    // definition of a row rather than one per tab.
    assert.include(
      flat,
      'id="__addonRef__-pref-panel-agent" class="llm-pref-panel"',
    );
    assert.include(
      flat,
      'id="__addonRef__-pref-panel-models" class="llm-pref-panel"',
    );
    assert.notInclude(markup, "#__addonRef__-pref-panel-agent .llm-pref-row");
    assert.include(flat, ".llm-pref-panel .llm-pref-row {");

    // Every modifier must be scoped like the rule it overrides. A bare
    // `.llm-pref-row-head--plain` loses to `.llm-pref-panel .llm-pref-row-head`
    // on specificity, and the chevron silently lands in the wrong grid column.
    for (const modifier of [
      ".llm-pref-row-head--plain",
      ".llm-pref-row-icon--provider",
      ".llm-pref-row-icon--webchat",
    ]) {
      assert.notMatch(
        flat,
        new RegExp(`(^|[;}] )\\${modifier} \\{`),
        `${modifier} must be scoped to .llm-pref-panel`,
      );
      assert.include(flat, `.llm-pref-panel ${modifier} {`, modifier);
    }

    // The provider-only pieces are declared once, in that same stylesheet.
    for (const rule of [
      ".llm-pref-panel .llm-pref-section-head",
      ".llm-pref-panel .llm-pref-model-row",
      ".llm-pref-panel .llm-pref-advanced-panel",
      ".llm-pref-panel .llm-pref-button--danger",
    ]) {
      assert.include(flat, `${rule} {`, rule);
    }

    // The inline card tokens the provider cards used are gone from the script.
    const preferenceScript = source("src/modules/preferenceScript.ts");
    for (const token of [
      "ADV_ROW_STYLE",
      "SECTION_LABEL_STYLE",
      "INPUT_MODE_SELECT_SM_STYLE",
      "PROTOCOL_SELECT_SM_STYLE",
    ]) {
      assert.notInclude(preferenceScript, token, token);
    }
  });

  it("renders every provider as one collapsible row", function () {
    const preferenceScript = source("src/modules/preferenceScript.ts");

    assert.include(preferenceScript, '"llm-pref-row"');
    assert.include(
      preferenceScript,
      '"llm-pref-row-head llm-pref-row-head--plain"',
    );
    assert.include(preferenceScript, '"llm-pref-row-toggle"');
    assert.include(preferenceScript, '"llm-pref-row-body"');
    assert.include(preferenceScript, 'cardToggle.setAttribute("aria-expanded"');
    assert.include(preferenceScript, 'cardToggle.setAttribute("aria-controls"');
    assert.include(preferenceScript, "llm-pref-row-chevron");

    // The horizontal strip was prototyped and dropped; nothing of it survives.
    for (const gone of [
      "llm-pref-strip",
      "focusedProviderId",
      "Previous provider",
    ]) {
      assert.notInclude(preferenceScript, gone, gone);
    }
    assert.notInclude(
      source("addon/content/preferences.xhtml"),
      "llm-pref-strip",
    );
  });

  it("keeps a row open across the rerenders its own controls trigger", function () {
    const preferenceScript = source("src/modules/preferenceScript.ts");

    // `rerender` replaces the whole list, so the open set has to outlive it —
    // otherwise adding a model or changing auth mode would slam the row shut.
    const rerenderStart = preferenceScript.indexOf("const rerender = () => {");
    const openSetDeclaration = preferenceScript.indexOf(
      "const openProviderIds = new Set<string>(",
    );
    assert.isAtLeast(openSetDeclaration, 0, "open set is declared");
    assert.isAbove(rerenderStart, openSetDeclaration, "declared before render");

    // A provider that still needs setting up starts open; a finished one does not.
    assert.include(
      preferenceScript,
      "groups\n      .filter((group) => !describeProviderRow(group).configured)",
    );
    // A provider the user just added is the one they want to fill in.
    assert.include(preferenceScript, "openProviderIds.add(added.id)");
  });

  it("adds a provider from a slot shaped like a collapsed row", function () {
    const preferenceScript = source("src/modules/preferenceScript.ts");
    const flat = source("addon/content/preferences.xhtml").replace(/\s+/g, " ");

    assert.include(preferenceScript, '"llm-pref-row llm-pref-add-card"');
    assert.include(preferenceScript, '"llm-pref-add-card-plus"');
    assert.include(preferenceScript, 't("Add provider")');
    assert.include(preferenceScript, "wrap.appendChild(addCard)");
    assert.notInclude(preferenceScript, 't("+ Add Provider")');

    // It matches a collapsed provider row: full width, same 42px head height.
    const cardStart = flat.indexOf(".llm-pref-panel .llm-pref-add-card {");
    const cardRule = flat.slice(cardStart, flat.indexOf("}", cardStart));
    assert.include(cardRule, "min-height: 42px");
    assert.include(cardRule, "border-style: dashed");
    // It must LOOK like the collapsed row it is shaped like — filled with the
    // head colour, which is all a collapsed row shows. Left transparent it
    // reads as a hole cut in the list rather than an empty card.
    assert.include(cardRule, "background: var(--llm-pref-head)");
    assert.notInclude(cardRule, "background: transparent");
    assert.notInclude(cardRule, "aspect-ratio");
    assert.notInclude(cardRule, "align-self");
    const headStart = flat.indexOf(".llm-pref-panel .llm-pref-row-head {");
    const headRule = flat.slice(headStart, flat.indexOf("}", headStart));
    assert.include(headRule, "min-height: 42px");

    // Contents centre on both axes — and the button is taken out of flow to
    // get there. Gecko gives a <button> an anonymous inner box with its own
    // intrinsic height, so a flex button does NOT fill its parent and its
    // centred content lands above the middle. `inset: 0` makes the button's
    // box the slot exactly, whatever the engine thinks a button measures.
    const btnStart = flat.indexOf(".llm-pref-panel .llm-pref-add-card-btn {");
    const btnRule = flat.slice(btnStart, flat.indexOf("}", btnStart));
    assert.include(btnRule, "place-content: center");
    assert.include(btnRule, "align-items: center");
    assert.notInclude(btnRule, "flex: 1");
    assert.notInclude(btnRule, "position: absolute");
    assert.include(cardRule, "display: grid");

    // It must not be a <button>. Measured in the real pane, Gecko sized one
    // 25px tall inside a 44px slot and refused to resolve its height from
    // top/bottom, leaving the label 8px above centre. A div has no such box.
    assert.include(
      preferenceScript,
      'createElement(doc, "div", "llm-pref-add-card-btn"',
    );
    assert.include(preferenceScript, 'setAttribute("role", "button")');
    // A div gets no implicit keyboard activation, so it has to be restored.
    assert.include(preferenceScript, 'key !== "Enter" && key !== " "');

    // Hover fills the slot with the card surface — panel colours, no accent.
    const hoverStart = flat.indexOf(
      ".llm-pref-panel .llm-pref-add-card:hover {",
    );
    const hoverRule = flat.slice(hoverStart, flat.indexOf("}", hoverStart));
    // A gentler scale than the square tile used: this slot is full width, so
    // 1.02 would push ~6px past each edge of the pane.
    assert.include(hoverRule, "transform: scale(1.01)");
    assert.include(
      hoverRule,
      "background-color: color-mix(in srgb, var(--fill-primary, #fff) 7%, var(--llm-pref-head))",
    );
    assert.notInclude(hoverRule, "--color-accent");

    // The cross is a plain large glyph in the label's colour: no ring, no accent.
    const plusStart = flat.indexOf(".llm-pref-panel .llm-pref-add-card-plus {");
    const plusRule = flat.slice(plusStart, flat.indexOf("}", plusStart));
    assert.include(plusRule, "font-size: 20px");
    assert.include(plusRule, "color: inherit");
    assert.notInclude(plusRule, "border");

    assert.include(flat, "@media (prefers-reduced-motion: reduce)");
  });

  it("shows provider state in the head without opening the row", function () {
    const preferenceScript = source("src/modules/preferenceScript.ts");

    assert.include(
      preferenceScript,
      "const description = describeProviderRow(group)",
    );
    assert.include(
      preferenceScript,
      'cardDot.setAttribute("data-on", String(description.configured))',
    );
    assert.include(preferenceScript, "textContent: description.summary");
    assert.include(preferenceScript, "textContent: description.tag");
  });

  it("dresses the rows in icons the plugin already ships", function () {
    const markup = source("addon/content/preferences.xhtml");
    const flat = markup.replace(/\s+/g, " ");

    // Codex reuses the same logo the Agent tab's Codex row wears, and WebChat
    // reuses the globe from the chat context bar — no new artwork.
    assert.include(
      flat,
      '.llm-pref-row-icon--codex { background-image: url("chrome://__addonRef__/content/icons/codex-logo.svg"); }',
    );
    assert.include(
      flat,
      'url("chrome://__addonRef__/content/icons/action-mode-global.svg")',
    );
    assert.include(
      flat,
      'url("chrome://__addonRef__/content/icons/action-model-chip.svg")',
    );
    // Zotero inlines this markup into its own document, so relative URLs die.
    assert.notMatch(markup, /url\("icons\//);

    // Mask-tinted icons sit at full strength in the row title's own colour.
    // Dimmed with an opacity they washed out against the head, and `Field`
    // is the near-black input background in dark chrome, not a light value.
    for (const modifier of ["provider", "webchat", "notes"]) {
      const at = flat.indexOf(`.llm-pref-row-icon--${modifier} {`);
      assert.isAtLeast(at, 0, modifier);
      const rule = flat.slice(at, flat.indexOf("}", at));
      assert.include(rule, "background-color: FieldText", modifier);
      assert.notInclude(rule, "opacity:", modifier);
    }
  });

  it("moves the destructive control out of the row head", function () {
    const preferenceScript = source("src/modules/preferenceScript.ts");

    // The head slot the Agent tab gives to an on/off switch must not carry a
    // delete: Remove provider is a labelled button at the foot of the open body.
    assert.include(
      preferenceScript,
      '"llm-pref-button llm-pref-button--danger"',
    );
    assert.include(preferenceScript, 'textContent: t("Remove provider")');
    assert.include(preferenceScript, "footer.appendChild(removeProvBtn)");
    assert.notInclude(
      preferenceScript,
      'iconBtn(doc, "×", t("Remove provider"))',
    );
  });

  it("paints its cards so they sit above the pane Zotero actually draws", function () {
    // Only the shared stylesheet is in scope here. The Customization and
    // MinerU tabs still carry their own inline `--stroke-secondary` borders;
    // those are pre-existing and untouched.
    const markup = source("addon/content/preferences.xhtml");
    const flat = markup
      .slice(markup.indexOf("<html:style>"), markup.indexOf("</html:style>"))
      // Comments explain why these tokens exist and name the ones they
      // replaced; the assertions below are about declarations, not prose.
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\s+/g, " ");

    // Zotero defines --fill-primary and --fill-secondary but NOT
    // --stroke-secondary, so `var(--stroke-secondary, #c8c8c8)` always
    // resolved to light grey — a harsh border on a dark pane. And the `Field`
    // system colour is near-black in dark chrome, so a card painted with it
    // sank below the pane instead of sitting above it.
    assert.notInclude(flat, "--stroke-secondary");
    assert.notInclude(flat, "background: Field");

    // Zotero paints the preferences content area with
    // `#prefs-outer-container { background-color: var(--material-sidepane) }`
    // — #303030 dark / #f2f2f2 light. A card has to sit ABOVE that, so these
    // are literal values chosen against it: --material-mix-quinary is #2b2b2b
    // dark (darker than the pane) and #f2f2f2 light (identical to it), so a
    // card painted from that token sinks or vanishes.
    // All four tokens live on the prefs root, so every tab draws from them —
    // including the Embedding Provider card on Customization, which mirrors a
    // provider row: head in the chrome colour over a body in the surface.
    assert.include(
      flat,
      "#__addonRef__-prefs { --llm-pref-surface: #f4f4f4; --llm-pref-head: #ffffff; --llm-pref-field: #ffffff; --llm-pref-stroke: #dadada; }",
    );
    assert.include(
      flat,
      "@media (prefers-color-scheme: dark) { #__addonRef__-prefs { --llm-pref-surface: #3a3a3a; --llm-pref-head: #282828; --llm-pref-field: #282828; --llm-pref-stroke: #4f4f4f; } }",
    );
    // The panel itself now carries layout only.
    assert.include(
      flat,
      ".llm-pref-panel { display: flex; flex-direction: column; gap: 14px; }",
    );
    const script = source("src/modules/preferenceScript.ts");
    assert.include(
      script,
      "background: var(--llm-pref-surface); overflow: hidden;",
    );
    assert.include(script, "background: var(--llm-pref-head);");
    assert.include(flat, "#__addonRef__-prefs .llm-pref-fields :is(");
    // Inline styles beat any selector, so no INPUT may declare these itself.
    // (A button and the MinerU context menu still set `background: Field`
    // deliberately — they are not fields and keep Zotero's own chrome.)
    const markupBody = markup.slice(markup.indexOf("</html:style>"));
    const fields =
      markupBody.match(/<html:(?:input|select|textarea)\b[\s\S]*?>/g) || [];
    assert.isAtLeast(fields.length, 40, "found the pane's fields");
    for (const field of fields) {
      assert.notInclude(field, "background: Field");
      assert.notInclude(field, "--stroke-secondary");
    }
    // The script draws its edges from the token too. (A comment there still
    // names --stroke-secondary to explain why it was abandoned, so match the
    // var() call rather than the bare name.)
    assert.notInclude(script, "var(--stroke-secondary");

    // The card body and the fields inside it are separate tokens. Light draws
    // fields lighter than the body so they stand out; dark draws them darker,
    // for the same separation in the direction that suits it. Pointing both
    // at one value, as dark used to, made fields invisible.
    for (const [selector, token] of [
      [".llm-pref-panel .llm-pref-row {", "var(--llm-pref-surface)"],
      [
        ".llm-pref-panel .llm-pref-input, .llm-pref-panel .llm-pref-select {",
        "var(--llm-pref-field)",
      ],
      [".llm-pref-panel .llm-pref-button {", "var(--llm-pref-field)"],
    ] as const) {
      const at = flat.indexOf(selector);
      assert.isAtLeast(at, 0, selector);
      const rule = flat.slice(at, flat.indexOf("}", at));
      assert.include(rule, `background: ${token}`, selector);
    }
    // The card must never be painted from a token that tracks the pane itself.
    assert.notInclude(flat, "--llm-pref-surface: var(--material-mix-quinary");

    // The row head is a darker title bar, like the Embedding Provider card.
    // It is defined on the shared panel scope, so both tabs get it.
    // The head is deliberately NOT tied to the selected tab: the tab keeps
    // Zotero's own `background: Field` so it reads as chrome, while the head
    // belongs to the card. #282828 sits 8 levels below the #303030 pane —
    // darker read as a hole in the card, lighter vanished into the pane.
    assert.include(flat, "--llm-pref-head: #ffffff;");
    assert.include(flat, "--llm-pref-head: #282828;");
    assert.notInclude(flat, "--llm-pref-chrome");
    const preferenceScript = source("src/modules/preferenceScript.ts");
    assert.include(preferenceScript, 'btn.style.background = "Field"');
    const headRule = flat.slice(
      flat.indexOf(".llm-pref-panel .llm-pref-row-head {"),
      flat.indexOf("}", flat.indexOf(".llm-pref-panel .llm-pref-row-head {")),
    );
    assert.include(headRule, "background: var(--llm-pref-head)");

    // Every edge on both tabs comes from the one stroke token.
    for (const rule of [
      ".llm-pref-panel .llm-pref-row {",
      ".llm-pref-panel .llm-pref-input, .llm-pref-panel .llm-pref-select {",
      ".llm-pref-panel .llm-pref-button {",
    ]) {
      const start = flat.indexOf(rule);
      assert.isAtLeast(start, 0, rule);
      const body = flat.slice(start, flat.indexOf("}", start));
      assert.include(body, "var(--llm-pref-stroke)", rule);
    }
  });

  it("keeps per-model tuning behind the gear", function () {
    const preferenceScript = source("src/modules/preferenceScript.ts");
    const markup = source("addon/content/preferences.xhtml").replace(
      /\s+/g,
      " ",
    );

    assert.include(
      preferenceScript,
      'advRow.setAttribute("data-open", "false")',
    );
    assert.include(
      markup,
      ".llm-pref-panel .llm-pref-advanced-panel { display: none;",
    );
    assert.include(
      markup,
      '.llm-pref-panel .llm-pref-advanced-panel[data-open="true"] { display: flex; }',
    );
  });
});
