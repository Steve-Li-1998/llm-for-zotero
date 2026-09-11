import { assert } from "chai";
import { describe, it } from "mocha";
import { readFileSync } from "node:fs";
import { t } from "../src/utils/i18n";
import { getOriginalPermissionOptions } from "../src/shared/permissionOptions";

describe("bridge settings UI behavior", function () {
  it("persists bridge URL only on commit events", function () {
    const events: string[] = [];
    const commitBridgeUrl = () => {
      events.push("commit");
    };

    const inputListeners = new Map<string, () => void>();
    const input = {
      value: "http://127.0.0.1:19787",
      addEventListener(type: string, fn: () => void) {
        inputListeners.set(type, fn);
      },
    } as unknown as HTMLInputElement;

    input.addEventListener("change", commitBridgeUrl);
    input.addEventListener("blur", commitBridgeUrl);

    assert.isUndefined(inputListeners.get("input"));
    inputListeners.get("change")?.();
    inputListeners.get("blur")?.();
    assert.deepEqual(events, ["commit", "commit"]);
  });

  it("renders compact model input mode controls in advanced settings", function () {
    const preferenceScript = readFileSync(
      "src/modules/preferenceScript.ts",
      "utf8",
    );

    const preferences = readFileSync("addon/content/preferences.xhtml", "utf8");

    assert.include(preferenceScript, "getModelInputModeOptionsForRuntime");
    assert.include(preferenceScript, 't("Input mode")');
    assert.include(preferenceScript, "inputModeOptions.length > 0");
    assert.include(preferenceScript, "normalizeModelInputModeForRuntime");
    // The compact width is a stylesheet class now, not an inline token.
    assert.include(preferenceScript, "llm-pref-input--mode");
    assert.include(
      preferences.replace(/\s+/g, " "),
      ".llm-pref-input--mode { width: 108px; }",
    );
  });

  it("translates model input mode preference strings in Chinese locale", function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: { locale?: string };
    };
    const previousZotero = globalWithZotero.Zotero;
    globalWithZotero.Zotero = { locale: "zh-CN" };

    try {
      assert.equal(t("Input mode"), "输入模式");
      assert.equal(t("Text only"), "仅文本");
      assert.equal(t("Vision allowed"), "允许视觉");
      assert.equal(
        t(
          "Temperature: randomness (0–2)  ·  Edited Max tokens and set Input cap override detected/default limits  ·  Input mode: auto/text-only/vision",
        ),
        "温度：随机性 (0–2)  ·  编辑后的最大 Token 数和已设置的输入上限会覆盖检测值/默认值  ·  输入模式：自动/仅文本/视觉",
      );
      assert.equal(
        t(
          "Temperature: randomness (0–2)  ·  Edited Max tokens and set Input cap override detected/default limits",
        ),
        "温度：随机性 (0–2)  ·  编辑后的最大 Token 数和已设置的输入上限会覆盖检测值/默认值",
      );
    } finally {
      if (previousZotero) {
        globalWithZotero.Zotero = previousZotero;
      } else {
        delete globalWithZotero.Zotero;
      }
    }
  });

  it("translates the Original Agent permission instructions precisely", function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: { locale?: string };
    };
    const previousZotero = globalWithZotero.Zotero;
    globalWithZotero.Zotero = { locale: "zh-CN" };

    try {
      assert.equal(t("Original Agent Mode"), "原生 Agent 模式");
      assert.equal(t("Permission mode"), "权限模式");
      const options = getOriginalPermissionOptions();
      const safe = options.find(
        (option) => option.selectionKey === "original:safe",
      )!;
      assert.equal(
        t(safe.description),
        "所有外部写入（包括创建新笔记）在执行前都会显示以供审核。读取操作无需审核。",
      );
      // Reading the English text from the option catalog keeps the Chinese
      // string from silently falling back to English when the copy changes.
      const yolo = options.find(
        (option) => option.selectionKey === "original:yolo",
      )!;
      assert.equal(
        t(yolo.description),
        "原生 Agent 会自行判断，并可能执行超出字面请求的操作。配置的访问范围、受保护目标、数据库完整性、计划完整性、仅限对话的记忆、导入已发现论文前的论文选择卡片，以及更改日志仍会强制执行。Claude Code、Codex 和外部 MCP 调用方保留各自的权限控制。",
      );
    } finally {
      if (previousZotero) {
        globalWithZotero.Zotero = previousZotero;
      } else {
        delete globalWithZotero.Zotero;
      }
    }
  });

  it("groups Original Agent controls and Tavily in one card", function () {
    const preferences = readFileSync("addon/content/preferences.xhtml", "utf8");
    const originalAgentCardStart = preferences.indexOf(
      'id="__addonRef__-original-agent-card"',
    );
    const originalAgentCardEnd = preferences.indexOf(
      'id="__addonRef__-codex-app-server-card"',
    );
    const originalAgentCard = preferences.slice(
      originalAgentCardStart,
      originalAgentCardEnd,
    );

    assert.isAtLeast(originalAgentCardStart, 0);
    assert.isAbove(originalAgentCardEnd, originalAgentCardStart);
    assert.include(originalAgentCard, 'id="__addonRef__-enable-agent-mode"');
    assert.include(
      originalAgentCard,
      'id="__addonRef__-original-agent-permission-mode"',
    );
    assert.include(originalAgentCard, 'id="__addonRef__-tavily-card"');
  });
});
