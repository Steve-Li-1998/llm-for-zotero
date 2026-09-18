import { assert } from "chai";
import { mergeAgentToolResultQuoteCitations } from "../src/modules/contextPanel/agentMode/agentEngine";
import {
  buildQuoteCitation,
  selectUsedQuoteCitations,
} from "../src/services/quotes/quoteCitations";
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

describe("used quote anchor selection", function () {
  const buildCitation = (
    quoteText: string,
    citationLabel: string,
    extra: Record<string, unknown> = {},
  ): QuoteCitation => {
    const citation = buildQuoteCitation({
      quoteText,
      citationLabel,
      contextItemId: 22,
      itemId: 11,
      ...extra,
    });
    assert.isDefined(citation);
    return citation!;
  };

  const MECHANISM_QUOTE =
    "Elastic weight consolidation slows learning on important weights.";
  const TRAINING_QUOTE =
    "The network was trained for two hundred epochs on each task.";
  const HIGHLIGHT_QUOTE = "The reader highlighted this passage in the PDF.";
  const LABEL = "(Kirkpatrick et al., 2017)";

  it("keeps a citation the reply references with a quote token", function () {
    const used = buildCitation(MECHANISM_QUOTE, LABEL);
    const unused = buildCitation(TRAINING_QUOTE, LABEL);

    const selected = selectUsedQuoteCitations({
      text: `The method protects prior tasks [[quote:${used.id}]].`,
      quoteCitations: [used, unused],
    });

    assert.deepEqual(
      selected.map((citation) => citation.id),
      [used.id],
    );
  });

  it("keeps a citation quoted as a Markdown blockquote", function () {
    const used = buildCitation(MECHANISM_QUOTE, LABEL);
    const unused = buildCitation(TRAINING_QUOTE, LABEL);

    const selected = selectUsedQuoteCitations({
      text: [
        "The paper states:",
        "",
        "> Elastic weight consolidation slows learning",
        "> on important weights.",
        "",
        "That is the core mechanism.",
      ].join("\n"),
      quoteCitations: [used, unused],
    });

    assert.deepEqual(
      selected.map((citation) => citation.id),
      [used.id],
    );
  });

  it("keeps selected-text citations the reply never quotes", function () {
    const selectedText = buildCitation(HIGHLIGHT_QUOTE, LABEL, {
      sourceMatchKind: "selected-text",
      sourceMatchSource: "pdf-page-text",
    });
    const unused = buildCitation(TRAINING_QUOTE, LABEL);

    const selected = selectUsedQuoteCitations({
      text: "Here is an answer that quotes nothing at all.",
      quoteCitations: [selectedText, unused],
    });

    assert.deepEqual(
      selected.map((citation) => citation.id),
      [selectedText.id],
    );
  });

  it("drops every anchor an unquoting reply never used", function () {
    const first = buildCitation(MECHANISM_QUOTE, LABEL);
    const second = buildCitation(TRAINING_QUOTE, LABEL);

    assert.isEmpty(
      selectUsedQuoteCitations({
        text: "The paper argues that forgetting is avoidable.",
        quoteCitations: [first, second],
      }),
    );
  });

  it("keeps only selected-text citations when the reply text is empty", function () {
    const selectedText = buildCitation(HIGHLIGHT_QUOTE, LABEL, {
      sourceMatchKind: "selected-text",
      sourceMatchSource: "pdf-page-text",
    });
    const toolAnchor = buildCitation(MECHANISM_QUOTE, LABEL);

    assert.deepEqual(
      selectUsedQuoteCitations({
        text: "",
        quoteCitations: [selectedText, toolAnchor],
      }).map((citation) => citation.id),
      [selectedText.id],
    );
    assert.deepEqual(
      selectUsedQuoteCitations({
        text: undefined as unknown as string,
        quoteCitations: [selectedText, toolAnchor],
      }).map((citation) => citation.id),
      [selectedText.id],
    );
  });

  it("returns used anchors once, in their original order", function () {
    const first = buildCitation(MECHANISM_QUOTE, LABEL);
    const second = buildCitation(TRAINING_QUOTE, LABEL);

    const selected = selectUsedQuoteCitations({
      text: [
        `Training detail [[quote:${second.id}]] and mechanism.`,
        "",
        `> ${MECHANISM_QUOTE}`,
      ].join("\n"),
      quoteCitations: [first, second, first],
    });

    assert.deepEqual(
      selected.map((citation) => citation.id),
      [first.id, second.id],
    );
  });

  it("tolerates a reply with no anchors at all", function () {
    assert.isEmpty(
      selectUsedQuoteCitations({
        text: "Anything.",
        quoteCitations: undefined,
      }),
    );
  });
});
