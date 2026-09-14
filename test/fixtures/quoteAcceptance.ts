/** Extracted Cohen passage plus synthetic variations for general acceptance. */
export const COHEN_QUOTE =
  "However, there was a significant reward level by age interaction (χ²₍₁, N=89₎ = 9.41; p = 0.002)";
export const COHEN_WORKER_TEXT =
  "However, there was a significant reward level by age interaction (χ(21, N = 89) = 9.41; p = 0.002), such that high-reward paired associates showed relatively greater encoding-retrieval similarity.";
export const COHEN_READER_TEXT =
  "However, there was a signi\u0003ﬁ\u0003cant reward level by age\n\u0003interaction (\u0003χ\u00032\n\u0003(1,\u0003 \u0003N\u0003 \u0003= 89)\u0003 \u0003= 9.41;\u0003 \u0003p\u0003 \u0003= 0.002), such that high-reward paired associates showed relatively greater encoding-retrieval similarity.";

export const GENUINE_QUOTE_ACCEPTANCE_CASES = [
  {
    name: "flattened statistical scripts",
    quote: COHEN_QUOTE,
    source: COHEN_WORKER_TEXT,
  },
  {
    name: "native PDF item boundaries",
    quote: COHEN_QUOTE,
    source: COHEN_READER_TEXT,
  },
  {
    name: "long statistical suffix after a unique prose anchor",
    quote:
      "Reward-related pattern similarity increased reliably across the adolescent participants (F₂,₆₈ = 4.72; p = 0.012; η² = 0.18)",
    source:
      "Reward-related pattern similarity increased reliably across the adolescent participants (F(268) = 4.72; p = 0.012; η2 = 0.18), supporting the reported developmental effect.",
  },
  {
    name: "ligatures and item-separated sentence punctuation",
    quote:
      "The final analysis confirmed a reliable influence of training on population stability.",
    source:
      "The ﬁnal analysis conﬁrmed a reliable inﬂuence of training on population stability\u0003.",
  },
  {
    name: "wrapped prose with a separate numeric citation",
    quote:
      "They learned to associate the presentation of a sound with a mild foot shock.",
    source:
      "They learned to associate the presenta-\n\u0003tion of a sound with a mild foot shock\u0003[12]\u0003.",
  },
  {
    name: "inline formatting inside ordinary prose",
    quote:
      "The neuronal population maintained a stable representation throughout the experimental session.",
    source:
      "The neuronal population maintained a <em>stable representation</em> throughout the experimental session.",
  },
] as const;

export const ALTERED_QUOTE_ACCEPTANCE_CASES = [
  {
    name: "changed probability",
    quote: COHEN_QUOTE.replace("0.002", "0.02"),
    source: COHEN_WORKER_TEXT,
  },
  {
    name: "changed sample size",
    quote: COHEN_QUOTE.replace("N=89", "N=98"),
    source: COHEN_WORKER_TEXT,
  },
  {
    name: "changed exponent",
    quote: COHEN_QUOTE.replace("χ²", "χ³"),
    source: COHEN_WORKER_TEXT,
  },
  {
    name: "changed comparison operator",
    quote: COHEN_QUOTE.replace("p =", "p <"),
    source: COHEN_WORKER_TEXT,
  },
  {
    name: "removed negation beside a formula",
    quote: COHEN_QUOTE,
    source: COHEN_WORKER_TEXT.replace("there was", "there was not"),
  },
  {
    name: "unmarked omission between matched phrases",
    quote:
      "The population response increased consistently after training across all experimental sessions (p = 0.002)",
    source:
      "The population response increased consistently after training only in the control group across all experimental sessions (p = 0.002).",
  },
  {
    name: "invented ending",
    quote: `${COHEN_QUOTE}. This proves that every child remembered every reward.`,
    source: COHEN_WORKER_TEXT,
  },
  {
    name: "invented beginning",
    quote: `All adults performed perfectly. ${COHEN_QUOTE}`,
    source: COHEN_WORKER_TEXT,
  },
  {
    name: "changed direction",
    quote:
      "The population response decreased consistently after training across all experimental sessions.",
    source:
      "The population response increased consistently after training across all experimental sessions.",
  },
  {
    name: "removed negation",
    quote:
      "The population response did increase consistently after training across all experimental sessions.",
    source:
      "The population response did not increase consistently after training across all experimental sessions.",
  },
] as const;
