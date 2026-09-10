import { assert } from "chai";
import { describe, it } from "mocha";
import { describeProviderRow } from "../src/modules/preferences/providerCards/providerRowHeader";
import type { ModelProviderGroup } from "../src/utils/modelProviders";

/**
 * A provider card is now the same collapsible row the Agent tab uses, so the
 * collapsed head has to answer "is this set up, and as what?" on its own.
 * These are the answers it gives.
 */

function model(name: string) {
  return {
    id: `m-${name || "blank"}`,
    model: name,
    temperature: 0.7,
    outputTokenLimit: { mode: "auto" as const },
  };
}

function apiKeyGroup(
  overrides: Partial<Record<string, unknown>> = {},
): ModelProviderGroup {
  return {
    id: "g1",
    authMode: "api_key",
    apiBase: "https://api.openai.com/v1/responses",
    apiKey: "sk-live",
    providerProtocol: "responses_api",
    models: [model("gpt-5.1")],
    ...overrides,
  } as ModelProviderGroup;
}

describe("provider row header", function () {
  it("names an API-key provider by its preset and lists its models", function () {
    const row = describeProviderRow(
      apiKeyGroup({ models: [model("gpt-5.1"), model("gpt-5.1-mini")] }),
    );

    // The head has room for the actual names, which say far more than a count.
    assert.equal(row.summary, "OpenAI · gpt-5.1, gpt-5.1-mini");
    assert.equal(row.tag, "API Key");
    assert.equal(row.iconModifier, "provider");
    assert.isTrue(row.configured);
  });

  it("names a single model without any count", function () {
    assert.equal(
      describeProviderRow(apiKeyGroup()).summary,
      "OpenAI · gpt-5.1",
    );
  });

  it("truncates a long list rather than letting it push the row wide", function () {
    const row = describeProviderRow(
      apiKeyGroup({
        models: [
          model("claude-sonnet-5-20260401"),
          model("claude-opus-5-20260401"),
          model("claude-haiku-4-5-20251001"),
          model("claude-sonnet-4-5"),
        ],
      }),
    );

    assert.match(
      row.summary,
      /^OpenAI · claude-sonnet-5-20260401, .* \+2 more$/,
    );
    // Short enough to stay on one line in the head's 1fr column.
    assert.isBelow(row.summary.length, 75);
  });

  it("keeps at least one name even when that name alone is long", function () {
    const row = describeProviderRow(
      apiKeyGroup({
        models: [
          model("an-extremely-long-model-identifier-that-exceeds-the-budget"),
          model("gpt-5.1"),
        ],
      }),
    );

    assert.equal(
      row.summary,
      "OpenAI · an-extremely-long-model-identifier-that-exceeds-the-budget +1 more",
    );
  });

  it("reports an untouched provider as not configured", function () {
    const row = describeProviderRow(
      apiKeyGroup({ apiBase: "", apiKey: "", models: [model("")] }),
    );

    assert.equal(row.summary, "Not configured");
    assert.isFalse(row.configured);
  });

  it("treats a keyed provider with no model name as still unfinished", function () {
    const row = describeProviderRow(apiKeyGroup({ models: [model("")] }));

    assert.equal(row.summary, "OpenAI · no models yet");
    assert.isFalse(row.configured);
  });

  it("does not demand a key from a local runtime that serves unauthenticated", function () {
    const row = describeProviderRow(
      apiKeyGroup({
        apiBase: "http://127.0.0.1:11434/api",
        apiKey: "",
        models: [model("llama3.2")],
      }),
    );

    assert.isTrue(row.configured);
  });

  it("wears the shipped Codex icon in both Codex modes", function () {
    const direct = describeProviderRow({
      id: "g2",
      authMode: "codex_auth",
      apiBase: "",
      apiKey: "",
      providerProtocol: "openai_chat_compat",
      models: [model("gpt-5.6-luna"), model("gpt-5.6-sol")],
    } as unknown as ModelProviderGroup);

    assert.equal(direct.iconModifier, "codex");
    assert.equal(direct.tag, "Codex CLI");
    assert.equal(direct.summary, "Codex Direct · gpt-5.6-luna, gpt-5.6-sol");
    assert.isTrue(direct.configured);

    const appServer = describeProviderRow(
      apiKeyGroup({
        authMode: "codex_app_server",
        apiKey: "",
        apiBase: "",
        models: [model("gpt-5.6-codex")],
      }),
    );

    assert.equal(appServer.iconModifier, "codex");
    assert.equal(appServer.summary, "Codex App Server · gpt-5.6-codex");
  });

  it("wears the globe icon for WebChat and lists the open tabs by name", function () {
    const row = describeProviderRow({
      id: "g3",
      authMode: "webchat",
      apiBase: "",
      apiKey: "",
      providerProtocol: "webchat_bridge",
      models: [model("chatgpt.com"), model("chat.deepseek.com")],
    } as unknown as ModelProviderGroup);

    assert.equal(row.iconModifier, "webchat");
    assert.equal(row.tag, "Browser extension");
    assert.equal(row.summary, "WebChat · ChatGPT, DeepSeek");
    assert.isTrue(row.configured);
  });

  it("holds Copilot at grey until the device login has actually returned a token", function () {
    const loggedOut = describeProviderRow(
      apiKeyGroup({
        authMode: "copilot_auth",
        apiKey: "",
        models: [model("gpt-5.1")],
      }),
    );
    assert.isFalse(loggedOut.configured);
    assert.equal(loggedOut.tag, "GitHub Copilot");

    const loggedIn = describeProviderRow(
      apiKeyGroup({
        authMode: "copilot_auth",
        apiKey: "ghu_token",
        models: [model("gpt-5.1")],
      }),
    );
    assert.isTrue(loggedIn.configured);
    assert.equal(loggedIn.summary, "GitHub Copilot · gpt-5.1");
  });
});
