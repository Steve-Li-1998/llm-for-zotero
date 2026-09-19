/** Test-side support and grounding metrics. Deliberately independent of the
 * product's claim-anchoring code so before/after runs are scored identically. */
export type EvalSentence = { text: string; start: number; end: number };

const ABBREVIATIONS =
  /(?:\b(?:fig|figs|eq|eqs|et al|e\.g|i\.e|vs|cf|ref|refs|no|approx|dr|prof)|\b[A-Z])\.$/i;
const TOKEN_RE = /\[\[quote:([A-Za-z0-9._:-]+)\]\]/g;
const STOPWORDS = new Set(
  "a an the and or of to in on at by for with from as is are was were be been it its this that these those we they he she their our not no than then which who whom whose what when where how also into over under between during after before about".split(
    " ",
  ),
);

export function splitSentencesForEval(text: string): EvalSentence[] {
  const out: EvalSentence[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const terminal =
      ch === "." ||
      ch === "!" ||
      ch === "?" ||
      ch === "。" ||
      ch === "！" ||
      ch === "？";
    if (!terminal) continue;
    const next = text[i + 1];
    const decimal =
      ch === "." && /\d/.test(text[i - 1] || "") && /\d/.test(next || "");
    if (decimal) continue;
    const boundary =
      next === undefined || /\s/.test(next) || /[。！？]/.test(ch);
    if (!boundary) continue;
    const candidate = text.slice(start, i + 1).trim();
    if (ch === "." && ABBREVIATIONS.test(candidate)) continue;
    if (candidate) out.push({ text: candidate, start, end: i + 1 });
    start = i + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push({ text: tail, start, end: text.length });
  return out;
}

export function tokensForEval(text: string): Set<string> {
  const cleaned = text.replace(TOKEN_RE, " ").toLowerCase();
  const out = new Set<string>();
  for (const match of cleaned.matchAll(
    /[\p{L}\p{N}]+(?:[.'’-][\p{L}\p{N}]+)*/gu,
  )) {
    const token = match[0];
    if (/^[㐀-鿿]+$/u.test(token)) {
      for (let i = 0; i + 1 < token.length; i++) out.add(token.slice(i, i + 2));
      if (token.length === 1) out.add(token);
      continue;
    }
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

type ProseLine = { text: string; offset: number };

/** Prose lines only: no code, headings, blockquotes, tables or HTML. */
function proseLines(markdown: string): ProseLine[] {
  const lines: ProseLine[] = [];
  let offset = 0;
  let inFence = false;
  for (const raw of markdown.split("\n")) {
    const line = raw;
    const start = offset;
    offset += raw.length + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*(#{1,6}\s|>|\||<)/.test(line)) continue;
    const stripped = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
    if (!stripped.trim()) continue;
    lines.push({
      text: stripped,
      offset: start + (line.length - stripped.length),
    });
  }
  return lines;
}

export function measureSupport(
  answer: string,
  citations: Array<{ id: string; quoteText?: string; anchorMatch?: string }>,
) {
  const byId = new Map(citations.map((c) => [c.id, c]));
  const tokens: Array<{
    id: string;
    claimSentence: string;
    quoteText: string;
    overlap: number;
    anchorMatch?: string;
  }> = [];
  for (const line of proseLines(answer)) {
    for (const match of line.text.matchAll(TOKEN_RE)) {
      const id = match[1];
      const citation = byId.get(id);
      if (!citation) continue;
      const sentences = splitSentencesForEval(line.text);
      const position = match.index || 0;
      const claim =
        sentences.find((s) => position >= s.start && position < s.end) ||
        sentences.filter((s) => s.end <= position).pop() ||
        sentences[0];
      const claimSentence = (claim?.text || line.text)
        .replace(TOKEN_RE, "")
        .replace(/\s+([.!?。！？])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
      const claimTokens = tokensForEval(claimSentence);
      const quoteTokens = tokensForEval(citation.quoteText || "");
      let shared = 0;
      for (const token of claimTokens) if (quoteTokens.has(token)) shared++;
      tokens.push({
        id,
        claimSentence,
        quoteText: citation.quoteText || "",
        overlap: claimTokens.size ? shared / claimTokens.size : 0,
        anchorMatch: citation.anchorMatch,
      });
    }
  }
  const overlaps = tokens.map((t) => t.overlap).sort((a, b) => a - b);
  const median = overlaps.length
    ? overlaps[Math.floor((overlaps.length - 1) / 2)]
    : null;
  return {
    tokens,
    medianOverlap: median,
    lowOverlapTokens: tokens.filter((t) => t.overlap < 0.2).length,
    anchorMatchClaim: tokens.filter((t) => t.anchorMatch === "claim").length,
    anchorMatchPassage: tokens.filter((t) => t.anchorMatch === "passage")
      .length,
  };
}

export function measureGrounding(answer: string, citationIds: Set<string>) {
  let sentences = 0;
  let cited = 0;
  for (const line of proseLines(answer)) {
    for (const sentence of splitSentencesForEval(line.text)) {
      const bare = sentence.text.replace(TOKEN_RE, "");
      if (tokensForEval(bare).size < 6) continue;
      sentences++;
      const ids = [...sentence.text.matchAll(TOKEN_RE)].map((m) => m[1]);
      if (ids.some((id) => citationIds.has(id))) cited++;
    }
  }
  if (!sentences || !citationIds.size) return null;
  return { sentences, cited };
}
