import { assert } from "chai";
import { mergeAgentToolResultQuoteCitations } from "../src/modules/contextPanel/agentMode/agentEngine";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import type { QuoteCitation } from "../src/shared/types";

describe("agent mode quote citations", function () {
  it("merges quote citations from successful tool results into assistant messages", function () {
    const priorCitation = buildQuoteCitation({
      quoteText: "Selected text quote.",
      citationLabel: "(Lee, 2026)",
      contextItemId: 1,
    });
    const toolCitation = buildQuoteCitation({
      quoteText: "Paper read quote.",
      citationLabel: "(Mnih et al., 2014)",
      contextItemId: 22,
      itemId: 11,
    });
    assert.isDefined(priorCitation);
    assert.isDefined(toolCitation);
    const message = { quoteCitations: [priorCitation!] };

    mergeAgentToolResultQuoteCitations(message, {
      ok: true,
      content: {
        mode: "overview",
        quoteCitations: [toolCitation!],
      },
    });

    assert.lengthOf(message.quoteCitations || [], 2);
    assert.deepInclude(message.quoteCitations || [], priorCitation!);
    assert.deepInclude(message.quoteCitations || [], toolCitation!);
  });

  it("ignores failed tool results when merging quote citations", function () {
    const toolCitation = buildQuoteCitation({
      quoteText: "Failed tool quote.",
      citationLabel: "(Mnih et al., 2014)",
      contextItemId: 22,
    });
    assert.isDefined(toolCitation);
    const message: { quoteCitations?: QuoteCitation[] } = {};

    mergeAgentToolResultQuoteCitations(message, {
      ok: false,
      content: {
        quoteCitations: [toolCitation!],
      },
    });

    assert.isUndefined(message.quoteCitations);
  });
});
