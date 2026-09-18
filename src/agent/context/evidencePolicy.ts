/**
 * One owner for "how much more should this turn read before it answers".
 * Every paper read carries stop guidance rendered from this policy, so the
 * read budget and the wording the model is given can never disagree.
 */

export type EvidenceCoverage = "overview" | "targeted" | "exhaustive";

export type ReadStopPolicy = {
  coverage: EvidenceCoverage;
  /** Reads in this turn after which the model is told to answer with what it has. */
  readBudget: number;
};

export type ReadStopRecommendation =
  | "continue_plan"
  | "answer_now"
  | "answer_or_self_check"
  | "name_a_specific_missing_dimension"
  | "answer_with_source_limitation";

export type ReadStopGuidance = {
  recommendation: ReadStopRecommendation;
  reason: string;
};

export const READ_BUDGET_BY_COVERAGE: Record<EvidenceCoverage, number> = {
  overview: 1,
  targeted: 2,
  exhaustive: Number.POSITIVE_INFINITY,
};

export function resolveReadStopGuidance(
  policy: ReadStopPolicy,
  state: {
    frontier: "advanced" | "unchanged" | "unavailable";
    readsThisTurn: number;
  },
): ReadStopGuidance {
  if (state.frontier === "unavailable") {
    return {
      recommendation: "answer_with_source_limitation",
      reason:
        "The requested textual source was unavailable. Give the best supported answer and disclose the source limitation.",
    };
  }
  if (policy.coverage === "exhaustive") {
    return state.frontier === "advanced"
      ? {
          recommendation: "answer_or_self_check",
          reason:
            "New source occurrences were delivered. Evaluate the accumulated evidence and either answer or identify one concrete missing dimension.",
        }
      : {
          recommendation: "name_a_specific_missing_dimension",
          reason:
            "This read added no new source occurrence. Do not repeat it; retrieve again only for a specifically named unresolved method, result, qualification, section, or comparison dimension.",
        };
  }
  if (state.frontier === "unchanged") {
    return {
      recommendation: "answer_now",
      reason:
        policy.coverage === "targeted"
          ? "This read added no new source text. If a specific claim still lacks support, read one unread section by sectionId from the outline; otherwise answer now from the delivered evidence."
          : "This read added no new source text. Answer now from the evidence already held and delivered; do not retrieve again for this question.",
    };
  }
  if (state.readsThisTurn >= policy.readBudget) {
    return {
      recommendation: "answer_now",
      reason: `The ${policy.coverage} read budget for this turn (${policy.readBudget}) is used. Answer now from the held and delivered evidence and disclose any claim it does not support instead of retrieving again.`,
    };
  }
  return {
    recommendation: "answer_or_self_check",
    reason:
      "New source text was delivered. Answer from the held and delivered evidence. Retrieve again only for one specifically named claim in your draft that this evidence does not support.",
  };
}
