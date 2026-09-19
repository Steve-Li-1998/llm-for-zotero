/** Questions addressed to the user's own library.
 *
 * These cases are only meaningful against a snapshot of the real Zotero data
 * directory (`LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT`): the harness creates nothing
 * and erases nothing, so every collection and paper named here must already
 * exist in that snapshot. Evidence fragments are chosen by reading the source
 * before the flight, exactly as for the authored corpus.
 */
export type RealCase = {
  id: string;
  category:
    | "clarification"
    | "factual"
    | "synthesis"
    | "verification"
    | "reasoning";
  question: string;
  provided?: string;
  /** Exact source fragments selected independently of retrieval. */
  evidence: string[];
  rubric: string[];
  /** How the turn is addressed: one named collection, the whole library, or
   * one paper looked up by its exact title. */
  scope:
    | { collectionName: string }
    | { library: true }
    | { paperTitle: string };
  history?: Array<{ role: "user" | "assistant"; content: string }>;
};

export const realCases: RealCase[] = [
  // {
  //   id: "r1",
  //   category: "factual",
  //   question: "Which stimulation protocol did the review recommend?",
  //   evidence: ["intermittent theta-burst stimulation"],
  //   rubric: ["Names iTBS and the paper it comes from"],
  //   scope: { collectionName: "Stimulation" },
  // },
];
