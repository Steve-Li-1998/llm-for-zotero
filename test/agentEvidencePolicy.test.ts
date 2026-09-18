import { assert } from "chai";
import { resolveReadStopGuidance } from "../src/agent/context/evidencePolicy";

describe("read stop guidance", function () {
  const targeted = { coverage: "targeted" as const, readBudget: 2 };
  const exhaustive = {
    coverage: "exhaustive" as const,
    readBudget: Number.POSITIVE_INFINITY,
  };

  it("asks for a draft-based self-check after the first targeted read", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "advanced",
      readsThisTurn: 1,
    });
    assert.equal(guidance.recommendation, "answer_or_self_check");
    assert.include(
      guidance.reason,
      "Answer from the held and delivered evidence",
    );
    assert.include(guidance.reason, "specifically named claim in your draft");
    assert.notInclude(guidance.reason, "missing dimension");
  });

  it("points a targeted read that adds nothing new at the outline", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "unchanged",
      readsThisTurn: 2,
    });
    assert.equal(guidance.recommendation, "answer_now");
    assert.equal(
      guidance.reason,
      "This read added no new source text. If a specific claim still lacks support, read one unread section by sectionId from the outline; otherwise answer now from the delivered evidence.",
    );
  });

  it("keeps the stop-now wording for overview reads that add nothing new", function () {
    const guidance = resolveReadStopGuidance(
      { coverage: "overview", readBudget: 1 },
      { frontier: "unchanged", readsThisTurn: 1 },
    );
    assert.equal(guidance.recommendation, "answer_now");
    assert.include(guidance.reason, "do not retrieve again for this question");
    assert.notInclude(guidance.reason, "sectionId");
  });

  it("stops targeted retrieval once the read budget is used", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "advanced",
      readsThisTurn: 2,
    });
    assert.equal(guidance.recommendation, "answer_now");
    assert.include(guidance.reason, "read budget");
    assert.include(guidance.reason, "disclose");
  });

  it("keeps gap hunting for exhaustive coverage", function () {
    const unchanged = resolveReadStopGuidance(exhaustive, {
      frontier: "unchanged",
      readsThisTurn: 5,
    });
    assert.equal(unchanged.recommendation, "name_a_specific_missing_dimension");
    const advanced = resolveReadStopGuidance(exhaustive, {
      frontier: "advanced",
      readsThisTurn: 5,
    });
    assert.equal(advanced.recommendation, "answer_or_self_check");
    assert.include(advanced.reason, "missing dimension");
  });

  it("reports source unavailability regardless of coverage", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "unavailable",
      readsThisTurn: 1,
    });
    assert.equal(guidance.recommendation, "answer_with_source_limitation");
  });
});
