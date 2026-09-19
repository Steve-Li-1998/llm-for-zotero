import { assert } from "chai";
import {
  formatAnswerGrounding,
  measureAnswerGrounding,
} from "../src/services/quotes/answerGrounding";

describe("answerGrounding", function () {
  it("counts substantive prose sentences and the cited ones", function () {
    const text = [
      "# Result",
      "Median accuracy was 84% on day 1 and 85% on day 10 [[quote:q1]].",
      "> Median animal accuracy was 84% on day 1 and 85% on day 10.",
      "The population correlation fell from 0.92 to 0.61 over the same sessions.",
      "Short.",
    ].join("\n");
    const grounding = measureAnswerGrounding({
      text,
      quoteCitations: [{ id: "q1" }],
    });
    assert.deepEqual(grounding, { sentences: 2, cited: 1 });
    assert.equal(formatAnswerGrounding(grounding!), "Cited: 1 of 2 sentences");
  });

  it("credits a token written after the full stop to the sentence before it", function () {
    const text =
      "Median accuracy was 84% on day 1 and 85% on day 10. [[quote:q1]] The population correlation fell from 0.92 to 0.61 over the same sessions. [[quote:q2]]";
    assert.deepEqual(
      measureAnswerGrounding({
        text,
        quoteCitations: [{ id: "q1" }, { id: "q2" }],
      }),
      { sentences: 2, cited: 2 },
    );
  });

  it("ignores tokens whose citation is not part of the answer", function () {
    const text =
      "Median accuracy was 84% on day 1 and 85% on day 10 [[quote:missing]].";
    assert.deepEqual(
      measureAnswerGrounding({ text, quoteCitations: [{ id: "q1" }] }),
      { sentences: 1, cited: 0 },
    );
  });

  it("returns null without citations or sentences", function () {
    assert.isNull(
      measureAnswerGrounding({
        text: "A long enough sentence without any anchor at all.",
        quoteCitations: [],
      }),
    );
    assert.isNull(
      measureAnswerGrounding({ text: "", quoteCitations: [{ id: "q1" }] }),
    );
  });
});
