/**
 * The on-demand check of a finished agent answer against the lines it quoted.
 *
 * The reader asks for it from the answer's footer; nothing here ever runs on
 * its own. Each cited sentence is sent to the utility model together with the
 * quoted line(s) that sentence cites, and the model is asked only whether
 * those lines support it. The verdicts live in this module's memory for as
 * long as the session does — they are never written to the conversation, the
 * database or a preference — so a restart simply loses them and the reader can
 * ask again.
 */

import type { ModelProfileOverride } from "../../modelCapabilities";
import { extractClaimSentences } from "../../services/quotes/claimAnchoring";
import type { QuoteCitation } from "../../shared/types";
import type { ChatParams } from "../../utils/llmClient";
import {
  callUtilityLLM,
  logUtilityLLMFailure,
  type UtilityLLMParams,
} from "../../utils/utilityLLM";

export type AnswerCheckVerdict = "supported" | "not_supported" | "unclear";

export type AnswerCheckClaim = {
  sentence: string;
  quotes: string[];
  verdict: AnswerCheckVerdict;
  note: string;
};

export type AnswerCheckResult = {
  claims: AnswerCheckClaim[];
  model: string;
  checkedAt: number;
};

/** One claim as it goes to the model: the sentence and the lines it cites. */
export type CheckableClaim = { sentence: string; quotes: string[] };

/**
 * Most claims one check may cover. The request is a single bounded call, and
 * a long answer would otherwise grow both its input and its JSON without end.
 */
export const MAX_ANSWER_CHECK_CLAIMS = 12;

/**
 * Longest the check may run. The reader is waiting on it with a status line,
 * and the call is small, but the answer's quotes can be long enough to make a
 * slow provider take a while.
 */
export const ANSWER_CHECK_TIMEOUT_MS = 45_000;

export const ANSWER_CHECK_SYSTEM_MESSAGE =
  "You verify whether quoted source lines support claims. Judge only from the quoted lines. Return JSON only.";

const ANSWER_CHECK_INSTRUCTION =
  'For each claim, decide whether the quoted line(s) alone support it. Reply with {"claims":[{"index":1,"verdict":"supported"|"not_supported"|"unclear","note":"<= 20 words"}]}.';

/** Longest note kept from the model, so one row stays one row. */
const MAX_NOTE_CHARS = 160;

/** Longest claim sentence drawn in a card row. */
export const MAX_CARD_SENTENCE_CHARS = 160;

/** How many turns' verdicts stay in memory before the oldest is dropped. */
const MAX_STORED_RESULTS = 20;

const VERDICT_LABELS: Record<AnswerCheckVerdict, string> = {
  supported: "Supported",
  not_supported: "Not supported",
  unclear: "Unclear",
};

const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Every cited prose sentence of the answer with the lines it cites.
 *
 * The sentence a citation belongs to is the one `claimAnchoring` bound its
 * token to, so a token written after the full stop still names the sentence
 * in front of it. Citations that share a sentence share a row: the reader
 * asked about the claim, not about each token on it.
 */
export function collectCheckableClaims(
  text: string,
  quoteCitations: readonly QuoteCitation[],
): CheckableClaim[] {
  const quoteById = new Map<string, string>();
  for (const citation of quoteCitations || []) {
    const id = citation?.id?.trim();
    const quote = (citation?.quoteText || "").trim();
    if (id && quote && !quoteById.has(id)) quoteById.set(id, quote);
  }
  if (!quoteById.size) return [];
  const bySentence = new Map<string, string[]>();
  for (const [id, claimSentence] of extractClaimSentences(text || "")) {
    const quote = quoteById.get(id);
    const sentence = claimSentence.trim();
    if (!quote || !sentence) continue;
    const quotes = bySentence.get(sentence);
    if (quotes) {
      if (!quotes.includes(quote)) quotes.push(quote);
      continue;
    }
    // Past the cap a new sentence is dropped, but a further quote on a
    // sentence already being checked still counts toward its verdict.
    if (bySentence.size >= MAX_ANSWER_CHECK_CLAIMS) continue;
    bySentence.set(sentence, [quote]);
  }
  return [...bySentence].map(([sentence, quotes]) => ({ sentence, quotes }));
}

/** The single request the check makes: its instruction, claims and quotes. */
export function buildAnswerCheckPrompt(claims: readonly CheckableClaim[]): {
  prompt: string;
  systemMessages: string[];
  jsonBudget: number;
} {
  const blocks = claims.map((claim, index) =>
    [
      `Claim ${index + 1}: ${claim.sentence}`,
      ...claim.quotes.map((quote) => `Quoted: "${quote}"`),
    ].join("\n"),
  );
  return {
    prompt: [ANSWER_CHECK_INSTRUCTION, ...blocks].join("\n\n"),
    systemMessages: [ANSWER_CHECK_SYSTEM_MESSAGE],
    jsonBudget: 120 + 60 * claims.length,
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = (text || "").trim();
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || "",
    trimmed.match(/\{[\s\S]*\}/)?.[0] || "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next extraction shape.
    }
  }
  return null;
}

function normalizeVerdict(value: unknown): AnswerCheckVerdict {
  const normalized = `${value ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "supported" || normalized === "not_supported") {
    return normalized;
  }
  return "unclear";
}

function normalizeNote(value: unknown): string {
  const note = `${value ?? ""}`.replace(/\s+/g, " ").trim();
  return note.length > MAX_NOTE_CHARS
    ? `${note.slice(0, MAX_NOTE_CHARS - 1)}…`
    : note;
}

/**
 * The model's verdicts laid back over the claims that were sent.
 *
 * The claims own the shape of the answer: a claim the model skipped, an index
 * it invented, a verdict word nobody defined and a reply that is not JSON at
 * all all end as "unclear" rather than as a missing or mislabelled row.
 */
export function parseAnswerCheckResponse(
  text: string,
  claims: readonly CheckableClaim[],
): AnswerCheckClaim[] {
  const parsed = extractJsonObject(text);
  const entries = Array.isArray(parsed?.claims)
    ? (parsed!.claims as unknown[])
    : [];
  const byIndex = new Map<
    number,
    { verdict: AnswerCheckVerdict; note: string }
  >();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const index = Number(record.index);
    if (!Number.isFinite(index)) continue;
    const position = Math.floor(index);
    if (position < 1 || position > claims.length) continue;
    if (byIndex.has(position)) continue;
    byIndex.set(position, {
      verdict: normalizeVerdict(record.verdict),
      note: normalizeNote(record.note),
    });
  }
  return claims.map((claim, index) => {
    const entry = byIndex.get(index + 1);
    return {
      sentence: claim.sentence,
      quotes: [...claim.quotes],
      verdict: entry?.verdict || "unclear",
      note: entry?.note || "",
    };
  });
}

export type AnswerCheckLLMConfig = {
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: ChatParams["authMode"];
  providerProtocol?: ChatParams["providerProtocol"];
  profileOverride?: ModelProfileOverride;
  /** Test seam: replaces the actual model call. */
  llmCall?: UtilityLLMParams["llmCall"];
};

export type AnswerCheckOutcome =
  | { ok: true; result: AnswerCheckResult }
  | { ok: false; reason: string };

/**
 * Ask the utility model whether each cited sentence is supported by its
 * quoted line(s). Called only from the footer action — never on its own.
 */
export async function runAnswerCheck(params: {
  text: string;
  quoteCitations: readonly QuoteCitation[];
  llmConfig: AnswerCheckLLMConfig;
}): Promise<AnswerCheckOutcome> {
  const claims = collectCheckableClaims(params.text, params.quoteCitations);
  if (!claims.length) return { ok: false, reason: "no_claims" };
  const request = buildAnswerCheckPrompt(claims);
  const outcome = await callUtilityLLM({
    prompt: request.prompt,
    model: params.llmConfig.model,
    apiBase: params.llmConfig.apiBase,
    apiKey: params.llmConfig.apiKey,
    authMode: params.llmConfig.authMode,
    providerProtocol: params.llmConfig.providerProtocol,
    profileOverride: params.llmConfig.profileOverride,
    temperature: 0,
    jsonBudget: request.jsonBudget,
    timeoutMs: ANSWER_CHECK_TIMEOUT_MS,
    systemMessages: request.systemMessages,
    llmCall: params.llmConfig.llmCall,
  });
  if (!outcome.ok) {
    // The provider's own words stay in the log; the panel shows the category.
    logUtilityLLMFailure("answer check", outcome);
    return { ok: false, reason: outcome.reason };
  }
  return {
    ok: true,
    result: {
      claims: parseAnswerCheckResponse(outcome.text, claims),
      model: (params.llmConfig.model || "").trim(),
      checkedAt: Date.now(),
    },
  };
}

/**
 * Session-only verdicts, keyed by conversation and assistant turn. Nothing
 * here is persisted: a restart loses every check, by design.
 */
const answerCheckResults = new Map<string, AnswerCheckResult>();

export function answerCheckKey(
  conversationKey: number,
  assistantTimestamp: number,
): string {
  return `${Math.floor(conversationKey)}:${Math.floor(assistantTimestamp)}`;
}

export function getAnswerCheckResult(
  key: string,
): AnswerCheckResult | undefined {
  return answerCheckResults.get(key);
}

export function storeAnswerCheckResult(
  key: string,
  result: AnswerCheckResult,
): void {
  answerCheckResults.delete(key);
  answerCheckResults.set(key, result);
  while (answerCheckResults.size > MAX_STORED_RESULTS) {
    const oldest = answerCheckResults.keys().next();
    if (oldest.done) break;
    answerCheckResults.delete(oldest.value);
  }
}

/** Drops every stored verdict; also the tests' reset seam. */
export function clearAnswerCheckResults(): void {
  answerCheckResults.clear();
}

function truncateSentence(sentence: string): string {
  const flat = sentence.replace(/\s+/g, " ").trim();
  return flat.length > MAX_CARD_SENTENCE_CHARS
    ? `${flat.slice(0, MAX_CARD_SENTENCE_CHARS - 1)}…`
    : flat;
}

/**
 * The card drawn under the answer: one row per checked claim, carrying its
 * verdict word, the claim itself and whatever the model said about it. The
 * row frame is the agent action card's, so the check reads as one of the
 * cards the turn already shows.
 */
export function renderAnswerCheckCard(
  doc: Document,
  result: AnswerCheckResult,
): HTMLElement {
  const card = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  card.className = "llm-answer-check";
  for (const claim of result.claims) {
    const row = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    row.className = "llm-agent-action-row llm-answer-check-row";
    row.dataset.verdict = claim.verdict;
    const body = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    body.className = "llm-agent-action-row-body";
    const verdict = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    // The border colour alone would leave the verdict unreadable to anyone who
    // cannot see it, so the row says it in words as well.
    verdict.className = "llm-answer-check-verdict";
    verdict.textContent = VERDICT_LABELS[claim.verdict];
    const sentence = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    sentence.className = "llm-answer-check-claim";
    sentence.textContent = truncateSentence(claim.sentence);
    sentence.setAttribute("title", claim.sentence);
    body.appendChild(verdict);
    body.appendChild(sentence);
    if (claim.note) {
      const note = doc.createElementNS(HTML_NS, "span") as HTMLElement;
      note.className = "llm-answer-check-note";
      note.textContent = claim.note;
      body.appendChild(note);
    }
    row.appendChild(body);
    card.appendChild(row);
  }
  return card;
}
