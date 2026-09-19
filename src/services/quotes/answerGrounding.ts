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
 * Null when the answer has no citations or no such sentence.
 *
 * Sentence-to-token binding follows `claimSpans`, so a token written after the
 * full stop counts for the sentence in front of it, and a line of nothing but
 * tokens — the shape a quoted block is introduced with — credits the last
 * counted sentence instead of standing as a sentence of its own. Blockquotes
 * are the source's words, not claims of the answer, so they are never counted.
 */
export function measureAnswerGrounding(params: {
  text: string;
  quoteCitations: readonly Pick<QuoteCitation, "id">[];
}): AnswerGrounding | null {
  const ids = new Set(params.quoteCitations.map((c) => c.id));
  if (!ids.size) return null;
  let sentences = 0;
  let cited = 0;
  /** The last sentence counted, so a citation written on a line of its own
   * still credits the claim it was written for. */
  let lastCounted: { cited: boolean } | null = null;
  for (const line of collectProseLines(params.text || "")) {
    for (const sentence of claimSpans(line.text)) {
      const carriesCitation = [
        ...sentence.text.matchAll(QUOTE_TOKEN_PATTERN),
      ].some((match) => ids.has(match[1]));
      const bare = sentence.text.replace(QUOTE_TOKEN_PATTERN, "");
      if (!bare.trim()) {
        // Tokens with no sentence of their own: they cite what came before
        // them, and add no sentence to the count. With nothing counted yet
        // they cite nothing.
        if (carriesCitation && lastCounted && !lastCounted.cited) {
          lastCounted.cited = true;
          cited++;
        }
        continue;
      }
      if (
        tokenizeRetrievalText(bare, { filterStopwords: false }).length <
        MIN_SENTENCE_TOKENS
      ) {
        continue;
      }
      sentences++;
      lastCounted = { cited: carriesCitation };
      if (carriesCitation) cited++;
    }
  }
  return sentences ? { sentences, cited } : null;
}

export function formatAnswerGrounding(grounding: AnswerGrounding): string {
  return `Cited: ${grounding.cited} of ${grounding.sentences} sentences`;
}
