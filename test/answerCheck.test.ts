import { assert } from "chai";
import type { QuoteCitation } from "../src/shared/types";
import {
  ANSWER_CHECK_SYSTEM_MESSAGE,
  ANSWER_CHECK_TIMEOUT_MS,
  MAX_ANSWER_CHECK_CLAIMS,
  answerCheckKey,
  buildAnswerCheckPrompt,
  clearAnswerCheckResults,
  collectCheckableClaims,
  getAnswerCheckResult,
  parseAnswerCheckResponse,
  renderAnswerCheckCard,
  runAnswerCheck,
  storeAnswerCheckResult,
} from "../src/modules/contextPanel/answerCheck";
import { collectFakeText, fakeDocument } from "./helpers/fakeDom";
import type { FakeElement } from "./helpers/fakeDom";

function citation(id: string, quoteText: string): QuoteCitation {
  return { id, quoteText, citationLabel: "(Fixture, 2024)" };
}

const CONFIG = {
  model: "gpt-5.4",
  apiBase: "https://api.openai.com/v1",
  apiKey: "key",
  providerProtocol: "openai_chat_compat" as const,
};

describe("answerCheck", function () {
  afterEach(function () {
    clearAnswerCheckResults();
  });

  describe("collectCheckableClaims", function () {
    it("pairs each cited sentence with every quote cited on it", function () {
      const text = [
        "Accuracy held steady across sessions [[quote:q1]][[quote:q2]].",
        "",
        "The correlation fell over the same sessions [[quote:q3]].",
      ].join("\n");
      assert.deepEqual(
        collectCheckableClaims(text, [
          citation("q1", "Median accuracy was 84% on day 1."),
          citation("q2", "Median accuracy was 85% on day 10."),
          citation("q3", "The correlation fell from 0.92 to 0.61."),
        ]),
        [
          {
            sentence: "Accuracy held steady across sessions.",
            quotes: [
              "Median accuracy was 84% on day 1.",
              "Median accuracy was 85% on day 10.",
            ],
          },
          {
            sentence: "The correlation fell over the same sessions.",
            quotes: ["The correlation fell from 0.92 to 0.61."],
          },
        ],
      );
    });

    it("ignores a token whose citation is not part of the answer", function () {
      assert.deepEqual(
        collectCheckableClaims(
          "Accuracy held steady across sessions [[quote:missing]].",
          [citation("q1", "Median accuracy was 84% on day 1.")],
        ),
        [],
      );
    });

    it("stops at twelve claims and keeps answer order", function () {
      const citations: QuoteCitation[] = [];
      const lines: string[] = [];
      for (let i = 1; i <= 14; i += 1) {
        citations.push(citation(`q${i}`, `Source line number ${i}.`));
        lines.push(`Claim sentence number ${i} [[quote:q${i}]].`);
      }
      const claims = collectCheckableClaims(lines.join("\n"), citations);
      assert.lengthOf(claims, MAX_ANSWER_CHECK_CLAIMS);
      assert.equal(claims[0].sentence, "Claim sentence number 1.");
      assert.equal(claims[11].sentence, "Claim sentence number 12.");
    });
  });

  describe("buildAnswerCheckPrompt", function () {
    it("numbers every claim, quotes every line, and names the JSON shape", function () {
      const claims = [
        {
          sentence: "Accuracy held steady.",
          quotes: ["84% on day 1.", "85% on day 10."],
        },
        { sentence: "The correlation fell.", quotes: ["0.92 to 0.61."] },
      ];
      const built = buildAnswerCheckPrompt(claims);
      assert.include(built.prompt, "Claim 1: Accuracy held steady.");
      assert.include(built.prompt, 'Quoted: "84% on day 1."');
      assert.include(built.prompt, 'Quoted: "85% on day 10."');
      assert.include(built.prompt, "Claim 2: The correlation fell.");
      assert.include(built.prompt, 'Quoted: "0.92 to 0.61."');
      assert.include(
        built.prompt,
        'Reply with {"claims":[{"index":1,"verdict":"supported"|"not_supported"|"unclear","note":"<= 20 words"}]}.',
      );
      assert.deepEqual(built.systemMessages, [ANSWER_CHECK_SYSTEM_MESSAGE]);
      assert.equal(built.jsonBudget, 120 + 60 * 2);
    });
  });

  describe("parseAnswerCheckResponse", function () {
    const claims = [
      { sentence: "Accuracy held steady.", quotes: ["84% on day 1."] },
      { sentence: "The correlation fell.", quotes: ["0.92 to 0.61."] },
      { sentence: "Latency dropped.", quotes: ["Latency was unchanged."] },
    ];

    it("maps one-based indices onto the claims it was given", function () {
      const parsed = parseAnswerCheckResponse(
        '```json\n{"claims":[{"index":1,"verdict":"supported","note":"both days quoted"},{"index":2,"verdict":"not_supported","note":"no numbers in the line"}]}\n```',
        claims,
      );
      assert.deepEqual(parsed, [
        {
          sentence: "Accuracy held steady.",
          quotes: ["84% on day 1."],
          verdict: "supported",
          note: "both days quoted",
        },
        {
          sentence: "The correlation fell.",
          quotes: ["0.92 to 0.61."],
          verdict: "not_supported",
          note: "no numbers in the line",
        },
        {
          sentence: "Latency dropped.",
          quotes: ["Latency was unchanged."],
          verdict: "unclear",
          note: "",
        },
      ]);
    });

    it("treats an unknown verdict and unreadable text as unclear", function () {
      const unknown = parseAnswerCheckResponse(
        '{"claims":[{"index":1,"verdict":"probably","note":"hedged"}]}',
        claims,
      );
      assert.equal(unknown[0].verdict, "unclear");
      assert.equal(unknown[0].note, "hedged");
      const unreadable = parseAnswerCheckResponse("I cannot answer.", claims);
      assert.deepEqual(
        unreadable.map((claim) => claim.verdict),
        ["unclear", "unclear", "unclear"],
      );
    });
  });

  describe("runAnswerCheck", function () {
    const text =
      "Accuracy held steady across sessions [[quote:q1]]. The correlation fell over the same sessions [[quote:q2]].";
    const quoteCitations = [
      citation("q1", "Median accuracy was 84% on day 1 and 85% on day 10."),
      citation("q2", "The correlation fell from 0.92 to 0.61."),
    ];

    it("asks the utility model about every cited claim and parses its verdicts", async function () {
      let seenPrompt = "";
      let seenSystem: string[] | undefined;
      let seenTemperature: number | undefined;
      const outcome = await runAnswerCheck({
        text,
        quoteCitations,
        llmConfig: {
          ...CONFIG,
          llmCall: async (params) => {
            seenPrompt = params.prompt;
            seenSystem = params.systemMessages;
            seenTemperature = params.temperature;
            return {
              text: '{"claims":[{"index":1,"verdict":"supported","note":"both numbers quoted"},{"index":2,"verdict":"not_supported","note":"the line names no sessions"}]}',
              completion: { status: "complete" as const },
            };
          },
        },
      });
      assert.isTrue(outcome.ok, "the check succeeds");
      if (!outcome.ok) return;
      assert.include(
        seenPrompt,
        "Claim 1: Accuracy held steady across sessions.",
      );
      assert.include(
        seenPrompt,
        'Quoted: "Median accuracy was 84% on day 1 and 85% on day 10."',
      );
      assert.deepEqual(seenSystem, [ANSWER_CHECK_SYSTEM_MESSAGE]);
      assert.equal(seenTemperature, 0);
      assert.equal(ANSWER_CHECK_TIMEOUT_MS, 45_000);
      assert.equal(outcome.result.model, "gpt-5.4");
      assert.isAtMost(Math.abs(outcome.result.checkedAt - Date.now()), 10_000);
      assert.deepEqual(
        outcome.result.claims.map((claim) => [claim.verdict, claim.note]),
        [
          ["supported", "both numbers quoted"],
          ["not_supported", "the line names no sessions"],
        ],
      );
    });

    it("reports a missing model without calling one", async function () {
      let calls = 0;
      const outcome = await runAnswerCheck({
        text,
        quoteCitations,
        llmConfig: {
          ...CONFIG,
          model: "",
          llmCall: async () => {
            calls += 1;
            return { text: "{}", completion: { status: "complete" as const } };
          },
        },
      });
      assert.deepEqual(outcome, { ok: false, reason: "not_configured" });
      assert.equal(calls, 0);
    });

    it("reports an answer with nothing to check without calling a model", async function () {
      let calls = 0;
      const outcome = await runAnswerCheck({
        text: "Accuracy held steady across sessions.",
        quoteCitations: [],
        llmConfig: {
          ...CONFIG,
          llmCall: async () => {
            calls += 1;
            return { text: "{}", completion: { status: "complete" as const } };
          },
        },
      });
      assert.deepEqual(outcome, { ok: false, reason: "no_claims" });
      assert.equal(calls, 0);
    });
  });

  describe("result store and card", function () {
    it("hands back only the result stored under the turn's own key", function () {
      const result = {
        claims: [
          {
            sentence: "Accuracy held steady.",
            quotes: ["84% on day 1."],
            verdict: "supported" as const,
            note: "quoted",
          },
        ],
        model: "gpt-5.4",
        checkedAt: 1_700_000_000_000,
      };
      storeAnswerCheckResult(answerCheckKey(7, 1234), result);
      assert.equal(getAnswerCheckResult(answerCheckKey(7, 1234)), result);
      assert.isUndefined(getAnswerCheckResult(answerCheckKey(7, 9999)));
      clearAnswerCheckResults();
      assert.isUndefined(getAnswerCheckResult(answerCheckKey(7, 1234)));
    });

    it("draws one verdict row per claim, with the sentence truncated", function () {
      const longSentence = `Accuracy held steady across every session ${"and every animal ".repeat(12)}.`;
      const card = renderAnswerCheckCard(fakeDocument, {
        claims: [
          {
            sentence: longSentence,
            quotes: ["84% on day 1."],
            verdict: "supported",
            note: "both numbers quoted",
          },
          {
            sentence: "The correlation fell.",
            quotes: ["0.92 to 0.61."],
            verdict: "not_supported",
            note: "the line names no sessions",
          },
          {
            sentence: "Latency dropped.",
            quotes: ["Latency was unchanged."],
            verdict: "unclear",
            note: "",
          },
        ],
        model: "gpt-5.4",
        checkedAt: Date.now(),
      }) as unknown as FakeElement;
      const rows = card.findAllByClass("llm-answer-check-row");
      assert.lengthOf(rows, 3);
      assert.deepEqual(
        rows.map((row) => row.dataset.verdict),
        ["supported", "not_supported", "unclear"],
      );
      assert.isTrue(
        rows.every((row) => row.classList.contains("llm-agent-action-row")),
        "rows reuse the action card row frame",
      );
      const firstRowText = collectFakeText(rows[0]);
      assert.include(firstRowText, "Accuracy held steady across every session");
      assert.include(firstRowText, "…");
      assert.include(firstRowText, "both numbers quoted");
      assert.isBelow(
        (card.findByClass("llm-answer-check-claim")?.textContent || "").length,
        162,
      );
      assert.include(collectFakeText(rows[1]), "Not supported");
    });
  });
});
