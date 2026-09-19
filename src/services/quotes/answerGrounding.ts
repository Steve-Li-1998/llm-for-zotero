import type { QuoteCitation } from "../../shared/types";
import { tokenizeRetrievalText } from "../retrieval/retrievalTokenizer";
import { claimSpans, QUOTE_TOKEN_PATTERN } from "./claimAnchoring";
import { collectProseLines } from "./sentenceSplit";

/** Sentences shorter than this are headings, labels or stubs rather than
 * claims, so they are not counted either way. */
const MIN_SENTENCE_TOKENS = 6;

export type AnswerGrounding = { sentences: number; cited: number };

/** How much of an answer carries a quote from the source: the substantive
 * prose sentences and how many of them cite one of the answer's citations.
 * Null when the answer has no citations or no such sentence. Sentence-to-token
 * binding follows `claimSpans`, so a token written after the full stop counts
 * for the sentence in front of it. */
export function measureAnswerGrounding(params: {
  text: string;
  quoteCitations: readonly Pick<QuoteCitation, "id">[];
}): AnswerGrounding | null {
  const ids = new Set(params.quoteCitations.map((c) => c.id));
  if (!ids.size) return null;
  let sentences = 0;
  let cited = 0;
  for (const line of collectProseLines(params.text || "")) {
    for (const sentence of claimSpans(line.text)) {
      const bare = sentence.text.replace(QUOTE_TOKEN_PATTERN, "");
      if (
        tokenizeRetrievalText(bare, { filterStopwords: false }).length <
        MIN_SENTENCE_TOKENS
      ) {
        continue;
      }
      sentences++;
      const tokens = [...sentence.text.matchAll(QUOTE_TOKEN_PATTERN)].map(
        (match) => match[1],
      );
      if (tokens.some((id) => ids.has(id))) cited++;
    }
  }
  return sentences ? { sentences, cited } : null;
}

export function formatAnswerGrounding(grounding: AnswerGrounding): string {
  return `Cited: ${grounding.cited} of ${grounding.sentences} sentences`;
}
