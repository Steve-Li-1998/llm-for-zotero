import { assert } from "chai";
import {
  detectProviderPreset,
  getProviderPreset,
} from "../src/utils/providerPresets";

describe("OpenCode Zen preset", function () {
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
});
