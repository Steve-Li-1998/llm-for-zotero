import { assert } from "chai";
import {
  measureGrounding,
  measureSupport,
  splitSentencesForEval,
} from "./helpers/qaSupportMetrics";

describe("qaSupportMetrics", function () {
  it("splits prose into sentences and keeps CJK terminators", function () {
    const parts = splitSentencesForEval(
      "The decoder fell to 62%. Accuracy stayed at 85%! 恢复到81%。Fig. 1 shows it.",
    ).map((s) => s.text);
    assert.deepEqual(parts, [
      "The decoder fell to 62%.",
      "Accuracy stayed at 85%!",
      "恢复到81%。",
      "Fig. 1 shows it.",
    ]);
  });

  it("scores a token by overlap between its claim sentence and its quote", function () {
    const answer =
      "The fixed decoder declined from 80% to 62% by day 10 [[quote:q1]]. Behavior stayed stable [[quote:q2]].";
    const result = measureSupport(answer, [
      {
        id: "q1",
        quoteText:
          "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.",
      },
      {
        id: "q2",
        quoteText:
          "We recorded 200 tracked neurons in visual cortex from 10 adult mice.",
        anchorMatch: "passage",
      },
    ]);
    assert.equal(result.tokens.length, 2);
    assert.isAbove(result.tokens[0].overlap, 0.6);
    assert.isBelow(result.tokens[1].overlap, 0.2);
    assert.equal(result.lowOverlapTokens, 1);
    assert.equal(result.anchorMatchPassage, 1);
    assert.equal(result.anchorMatchClaim, 0);
    assert.equal(result.tokens[1].claimSentence, "Behavior stayed stable.");
  });

  it("counts substantive sentences and those carrying a known token", function () {
    const answer = [
      "# Heading",
      "Median accuracy was 84% on day 1 and 85% on day 10 [[quote:q1]].",
      "> quoted line that is excluded",
      "This second sentence has no anchor but is long enough to count.",
      "Short.",
    ].join("\n");
    assert.deepEqual(measureGrounding(answer, new Set(["q1"])), {
      sentences: 2,
      cited: 1,
    });
    assert.isNull(measureGrounding("Nothing here.", new Set()));
  });

  it("ends a sentence on a standalone No.", function () {
    assert.deepEqual(
      splitSentencesForEval("No. The decoder fell to 62%.").map((s) => s.text),
      ["No.", "The decoder fell to 62%."],
    );
  });

  it("binds a token written after the terminal punctuation to that sentence", function () {
    const result = measureSupport(
      "The fixed decoder declined from 80% to 62% by day 10. [[quote:q1]] Behavior stayed stable.",
      [
        {
          id: "q1",
          quoteText:
            "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.",
        },
      ],
    );
    assert.equal(result.tokens.length, 1);
    assert.equal(
      result.tokens[0].claimSentence,
      "The fixed decoder declined from 80% to 62% by day 10.",
    );
    assert.isAbove(result.tokens[0].overlap, 0.6);
  });

  it("binds a token alone on its own line to the preceding sentence", function () {
    const result = measureSupport(
      "Opening explanation with several words in it here.\n\n[[quote:q2]]",
      [
        {
          id: "q2",
          quoteText: "Opening explanation with several words in it here.",
        },
      ],
    );
    assert.equal(result.tokens.length, 1);
    assert.equal(
      result.tokens[0].claimSentence,
      "Opening explanation with several words in it here.",
    );
    assert.isAbove(result.tokens[0].overlap, 0.9);
  });

  it("credits the sentence a trailing token follows", function () {
    assert.deepEqual(
      measureGrounding(
        "Median accuracy was 84% on day 1 and 85% on day 10. [[quote:q1]]",
        new Set(["q1"]),
      ),
      { sentences: 1, cited: 1 },
    );
  });

  it("excludes fenced code and table rows from the sentence count", function () {
    const answer = [
      "```",
      "const value = compute(alpha, beta, gamma, delta, epsilon, zeta);",
      "```",
      "| column one | column two | column three | column four | column five |",
      "This prose sentence is long enough to be counted on its own [[quote:q1]].",
    ].join("\n");
    assert.deepEqual(measureGrounding(answer, new Set(["q1"])), {
      sentences: 1,
      cited: 1,
    });
  });
});
