import { assert } from "chai";
import { PassageCitationCollector } from "../src/agent/context/passageCitationCollector";

describe("PassageCitationCollector", function () {
  it("maps paper_read passages and library snippets to their citation ids", function () {
    const collector = new PassageCitationCollector();
    collector.collect({
      groups: [
        {
          passages: [
            {
              text: "Passage one text long enough to matter here.",
              quoteCitationIds: ["q1"],
            },
            { text: "Passage two text.", quoteCitationId: "q2" },
          ],
        },
      ],
      quoteCitations: [
        {
          id: "q1",
          quoteText: "Passage one text long enough to matter here.",
          citationLabel: "A 2020",
        },
        { id: "q2", quoteText: "Passage two text.", citationLabel: "A 2020" },
      ],
    });
    collector.collect({
      snippets: [
        {
          snippet: "Snippet body.",
          surroundingText: "Before. Snippet body. After.",
          quoteCitationId: "q3",
        },
      ],
      quoteCitations: [
        { id: "q3", quoteText: "Snippet body.", citationLabel: "B 2021" },
      ],
    });
    assert.equal(
      collector.passageTextByCitationId.get("q1"),
      "Passage one text long enough to matter here.",
    );
    assert.equal(
      collector.passageTextByCitationId.get("q2"),
      "Passage two text.",
    );
    assert.equal(
      collector.passageTextByCitationId.get("q3"),
      "Before. Snippet body. After.",
    );
    assert.deepEqual(
      collector.quoteCitations.map((c) => c.id),
      ["q1", "q2", "q3"],
    );
  });
});
