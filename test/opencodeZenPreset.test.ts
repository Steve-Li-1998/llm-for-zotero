import { assert } from "chai";
import {
  detectProviderPreset,
  getProviderPreset,
} from "../src/utils/providerPresets";
import {
  buildProviderTransportHeaders,
  providerWantsSessionId,
} from "../src/utils/providerTransport";
import { callLLM } from "../src/utils/llmClient";

/**
 * OpenCode Zen is an ordinary OpenAI-compatible gateway with one unusual
 * requirement: it wants a stable session id per conversation on the envelope
 * so consecutive turns reuse the same backend's prompt cache. Requests without
 * it started failing with `MissingSessionID` (#439).
 */
describe("OpenCode Zen preset", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  beforeEach(function () {
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
      originalToolkit;
  });

  it("claims both the standard and the go tier", function () {
    for (const apiBase of [
      "https://opencode.ai/zen/v1",
      "https://opencode.ai/zen/v1/chat/completions",
      "https://opencode.ai/zen/go/v1",
      "https://opencode.ai/zen/go/v1/chat/completions",
      "https://opencode.ai/zen/v1/messages",
    ]) {
      assert.equal(detectProviderPreset(apiBase), "opencode", apiBase);
    }
  });

  it("leaves the rest of opencode.ai alone", function () {
    // The docs and the agent's own server live on the same host; only the Zen
    // gateway paths are a model endpoint.
    for (const apiBase of [
      "https://opencode.ai",
      "https://opencode.ai/docs/zen",
    ]) {
      assert.notEqual(detectProviderPreset(apiBase), "opencode", apiBase);
    }
  });

  it("defaults to the OpenAI-compatible protocol it publishes", function () {
    const preset = getProviderPreset("opencode");
    assert.equal(preset?.defaultApiBase, "https://opencode.ai/zen/v1");
    assert.equal(preset?.defaultProtocol, "openai_chat_compat");
    assert.includeMembers(preset?.supportedProtocols || [], [
      "openai_chat_compat",
      "anthropic_messages",
      "responses_api",
    ]);
  });

  it("sends the session id and identifies the client", function () {
    const headers = buildProviderTransportHeaders({
      protocol: "openai_chat_compat",
      apiKey: "zen-key",
      apiBase: "https://opencode.ai/zen/go/v1",
      sessionId: "abc123",
    });
    assert.equal(headers["x-opencode-session"], "abc123");
    // OpenCode asks clients to name themselves rather than appear as a
    // generic SDK, which is how the reporter's traffic was misattributed.
    assert.match(headers["User-Agent"] || "", /llm-for-zotero/);
    assert.equal(headers.Authorization, "Bearer zen-key");
  });

  it("omits the session header when there is no conversation", function () {
    const headers = buildProviderTransportHeaders({
      protocol: "openai_chat_compat",
      apiKey: "zen-key",
      apiBase: "https://opencode.ai/zen/v1",
    });
    assert.notProperty(headers, "x-opencode-session");
  });

  it("contributes nothing to other providers", function () {
    const headers = buildProviderTransportHeaders({
      protocol: "openai_chat_compat",
      apiKey: "sk-test",
      apiBase: "https://api.openai.com/v1",
      sessionId: "abc123",
    });
    assert.notProperty(headers, "x-opencode-session");
  });

  it("carries the session id from the chat request to the wire", async function () {
    // The header builder is only useful if the conversation's id actually
    // reaches it; nothing carried conversation identity down before this.
    let capturedHeaders: Record<string, string> = {};
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name === "fetch") {
          return async (_url: string, init?: RequestInit) => {
            capturedHeaders = (init?.headers || {}) as Record<string, string>;
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({
                choices: [{ message: { content: "OK" } }],
              }),
              text: async () => "",
            };
          };
        }
        return undefined;
      },
      log: () => undefined,
    };

    await callLLM({
      prompt: "Say hi.",
      model: "opencode/gpt-5.6-sol",
      apiBase: "https://opencode.ai/zen/go/v1",
      apiKey: "zen-test",
      sessionId: "conversation-digest",
    });

    assert.equal(capturedHeaders["x-opencode-session"], "conversation-digest");
  });

  it("asks for a session id only where one is wanted", function () {
    // Everyone else never derives an id, so no salt is minted for a user who
    // does not use this gateway.
    assert.isTrue(providerWantsSessionId("https://opencode.ai/zen/go/v1"));
    for (const apiBase of [
      "https://api.openai.com/v1",
      "https://api.anthropic.com/v1",
      "http://localhost:11434/v1",
      undefined,
    ]) {
      assert.isFalse(providerWantsSessionId(apiBase), String(apiBase));
    }
  });

  it("cannot let a preset overwrite the headers that carry credentials", function () {
    const headers = buildProviderTransportHeaders({
      protocol: "anthropic_messages",
      apiKey: "zen-key",
      apiBase: "https://opencode.ai/zen/v1",
      sessionId: "abc123",
    });
    // The Anthropic-compatible endpoint still authenticates the Anthropic way.
    assert.equal(headers["x-api-key"], "zen-key");
    assert.property(headers, "anthropic-version");
    assert.equal(headers["x-opencode-session"], "abc123");
  });
});
