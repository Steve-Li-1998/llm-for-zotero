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

  it("credits a citation written on its own line under the quoted block", function () {
    const text =
      "The paper states that accuracy remained approximately stable across all sessions:\n\n> Median animal accuracy was 84% on day 1 and 85% on day 10.\n\n[[quote:q1]]";
    assert.deepEqual(
      measureAnswerGrounding({ text, quoteCitations: [{ id: "q1" }] }),
      { sentences: 1, cited: 1 },
    );
  });

  it("credits a citation written on its own line with no quoted block", function () {
    const text =
      "The paper states that accuracy remained approximately stable across all sessions:\n\n[[quote:q1]]";
    assert.deepEqual(
      measureAnswerGrounding({ text, quoteCitations: [{ id: "q1" }] }),
      { sentences: 1, cited: 1 },
    );
  });

  it("counts the three Chinese sentences and credits the one carrying the token", function () {
    // Every sentence here passes the six-token minimum: CJK text is tokenized
    // into character bigrams, so even the short opening sentence has twelve.
    const text =
      "该论文报告了两个结果。第一个结果是准确率保持稳定，从第1天到第10天几乎没有变化 [[quote:q1]]。第二个结果是相关性下降到0.61。";
    assert.deepEqual(
      measureAnswerGrounding({ text, quoteCitations: [{ id: "q1" }] }),
      { sentences: 3, cited: 1 },
    );
  });

  it("reports nothing for an answer that is only a quoted block", function () {
    // A blockquote is the source speaking, not a claim of the answer, so an
    // answer that only quotes has no sentence to ground.
    const text =
      "> Median animal accuracy was 84% on day 1 and 85% on day 10. [[quote:q1]]";
    assert.isNull(
      measureAnswerGrounding({ text, quoteCitations: [{ id: "q1" }] }),
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
    // A citation with no claim in front of it has nothing to credit.
    assert.isNull(
      measureAnswerGrounding({
        text: "[[quote:q1]]",
        quoteCitations: [{ id: "q1" }],
      }),
    );
  });
});
