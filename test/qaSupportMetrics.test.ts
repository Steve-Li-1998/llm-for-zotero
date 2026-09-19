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
});
