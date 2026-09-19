export type SentenceSpan = { text: string; start: number; end: number };
export type ProseLine = { text: string; offset: number };

const ABBREVIATION_TAIL =
  /(?:\b(?:fig|figs|eq|eqs|et al|e\.g|i\.e|vs|cf|ref|refs|no|approx|dr|prof)|\b[A-Z])\.$/i;
const TERMINATORS = new Set([".", "!", "?", "。", "！", "？"]);
/** Characters that may close a sentence after its terminator and still belong
 * to it: a quoted or parenthesised sentence ends at the closing mark, not at
 * the full stop inside it. */
const CLOSERS = new Set(['"', "'", "”", "’", ")", "]", "」", "』", "》"]);
/** A citation token written with no space in front of it still follows a
 * finished sentence, so it ends one the way whitespace does. */
const TOKEN_OPENER = "[[quote:";

/** Sentence spans with offsets into the input. Decimal points and common
 * abbreviations do not end a sentence; CJK terminators always do. A run of
 * closing quotes or brackets after the terminator is part of the sentence,
 * and a citation token right after it starts the next one. */
export function splitSentences(text: string): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!TERMINATORS.has(ch)) continue;
    const prev = text[i - 1] || "";
    if (ch === "." && /\d/.test(prev) && /\d/.test(text[i + 1] || "")) continue;
    let end = i + 1;
    while (end < text.length && CLOSERS.has(text[end])) end++;
    const next = text[end];
    const cjk = ch === "。" || ch === "！" || ch === "？";
    const breaks =
      next === undefined ||
      /\s/.test(next) ||
      text.startsWith(TOKEN_OPENER, end);
    if (!cjk && !breaks) continue;
    const candidate = text.slice(start, i + 1);
    if (ch === "." && ABBREVIATION_TAIL.test(candidate.trim())) continue;
    push(out, text, start, end);
    start = end;
    i = end - 1;
  }
  push(out, text, start, text.length);
  return out;
}

function push(out: SentenceSpan[], text: string, start: number, end: number) {
  const raw = text.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  const trimmed = raw.trim();
  if (!trimmed) return;
  out.push({
    text: trimmed,
    start: start + leading,
    end: start + leading + trimmed.length,
  });
}

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const NON_PROSE = /^\s*(?:#{1,6}\s|>|\||<)/;

/** Lines that hold prose: fenced code, headings, blockquotes, table rows and
 * HTML lines are skipped; list markers are stripped. `offset` is the index of
 * the returned text inside the input. */
export function collectProseLines(markdown: string): ProseLine[] {
  const lines: ProseLine[] = [];
  let offset = 0;
  let inFence = false;
  for (const line of markdown.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || NON_PROSE.test(line)) continue;
    const stripped = line.replace(LIST_MARKER, "");
    if (!stripped.trim()) continue;
    lines.push({
      text: stripped,
      offset: lineStart + (line.length - stripped.length),
    });
  }
  return lines;
}
