import { assert } from "chai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The trace must not decide what a row means by what a tool is called.
 *
 * A tool name is identity: it keys deduplication and it finds a spec in the
 * registry. The moment a name decides a row's words, its visibility or its
 * verdict, the reader's view of a run depends on a list of names written at
 * some other time than the run -- a renamed tool loses its row, and a trace
 * from last year is read against today's list. Every fact a row shows is
 * therefore supposed to come from the event that produced it or from the hook
 * the tool itself declared.
 *
 * This scan is the standing check on that. It reads the four files that used
 * to hold the name-derived shadow taxonomy and fails on any comparison of a
 * name against a string literal, unless the site is listed below with the
 * reason it is allowed to stay.
 */
const SCANNED_FILES = [
  "src/modules/contextPanel/agentTrace/render.ts",
  "src/modules/contextPanel/agentTrace/toolResultTraceInfo.ts",
  "src/modules/contextPanel/agentTrace/toolActivityDedupe.ts",
  "src/modules/contextPanel/chat.ts",
] as const;

type NameMeaningPattern = {
  id: string;
  /** Whether this line uses a tool name to decide something. */
  matches: (line: string) => boolean;
};

/**
 * A `typeof x === "string"` guard reads a value's type, never its identity,
 * so it is removed before the line is scanned rather than allowlisted once
 * per occurrence.
 */
function scannableLine(line: string): string {
  return line.replace(/typeof\s+[^=!;]+[=!]==\s*"[^"]*"/g, " ");
}

const NAME_MEANING_PATTERNS: NameMeaningPattern[] = [
  {
    id: 'name === "…"',
    matches: (line) => /\bname\s*[=!]==\s*"/.test(scannableLine(line)),
  },
  {
    id: 'toolName === "…"',
    matches: (line) => /\btoolName\s*[=!]==\s*"/.test(scannableLine(line)),
  },
  {
    id: ".has(entry.payload.name)",
    matches: (line) => line.includes(".has(entry.payload.name)"),
  },
  {
    id: "normalizeMcpToolName(…) === …",
    matches: (line) =>
      /normalizeMcpToolName\([^)]*\)[^;]*===/.test(scannableLine(line)),
  },
];

type AllowedSite = {
  file: (typeof SCANNED_FILES)[number];
  /** Text the offending line must contain, so the entry cannot drift. */
  snippet: string;
  reason: string;
};

/**
 * Sites allowed to compare a name against a literal, and why.
 *
 * The first group is identity: the value compared is not a tool name at all.
 * The second is meaning that still reads a name and has a named owner; each
 * entry says which change removes it. An entry that stops matching fails this
 * test, so the list cannot outlive the code it excuses.
 */
const ALLOWED_SITES: AllowedSite[] = [
  {
    file: "src/modules/contextPanel/chat.ts",
    snippet: '.name === "AbortError"',
    reason:
      "A DOM exception's own name, not a tool's: the platform reports a " +
      "cancelled request this way and there is no other field to read.",
  },
  {
    file: "src/modules/contextPanel/agentTrace/render.ts",
    snippet: 'action.toolName === "request_user_input"',
    reason:
      "Known meaning site awaiting its owner. A pending action carries no " +
      "field saying it is a question for the user, so the planning-question " +
      "card still recognises the host's own interaction tool by name. The " +
      "fix belongs where the action is built: the host stamps the " +
      "interaction kind on AgentPendingAction, as the tool spec already " +
      'declares it (`interaction: "user_input"`).',
  },
  {
    file: "src/modules/contextPanel/chat.ts",
    snippet: 'event.toolName === "research_update"',
    reason:
      "Known meaning site owned by Phase 4 Task 4, which replaces it with " +
      "the planning stage event carrying the research job id from the " +
      "tool result payload.",
  },
];

type Offence = { file: string; line: number; text: string; pattern: string };

function scanFile(file: string): { offences: Offence[]; lineCount: number } {
  const source = readFileSync(resolve(process.cwd(), file), "utf8");
  const lines = source.split("\n");
  const offences: Offence[] = [];
  for (const [index, line] of lines.entries()) {
    for (const pattern of NAME_MEANING_PATTERNS) {
      if (!pattern.matches(line)) continue;
      offences.push({
        file,
        line: index + 1,
        text: line.trim(),
        pattern: pattern.id,
      });
      break;
    }
  }
  return { offences, lineCount: lines.length };
}

describe("agent trace derives no meaning from tool names", function () {
  const scans = SCANNED_FILES.map((file) => ({ file, ...scanFile(file) }));

  it("inspects every file that held the name-derived taxonomy", function () {
    assert.deepEqual(
      scans.map((scan) => scan.file),
      [...SCANNED_FILES],
    );
    for (const scan of scans) {
      assert.isAbove(
        scan.lineCount,
        100,
        `${scan.file} was read but looks empty; the scan would pass vacuously`,
      );
    }
  });

  it("finds no unexplained comparison of a tool name to a literal", function () {
    const unexplained = scans
      .flatMap((scan) => scan.offences)
      .filter(
        (offence) =>
          !ALLOWED_SITES.some(
            (allowed) =>
              allowed.file === offence.file &&
              offence.text.includes(allowed.snippet),
          ),
      );

    assert.deepEqual(
      unexplained.map(
        (offence) =>
          `${offence.file}:${offence.line} (${offence.pattern}) ${offence.text}`,
      ),
      [],
    );
  });

  it("keeps every allowlisted site real and reasoned", function () {
    for (const allowed of ALLOWED_SITES) {
      const matched = scans
        .filter((scan) => scan.file === allowed.file)
        .flatMap((scan) => scan.offences)
        .filter((offence) => offence.text.includes(allowed.snippet));
      assert.isAtLeast(
        matched.length,
        1,
        `${allowed.file} no longer contains ${allowed.snippet}; drop the allowlist entry`,
      );
      assert.isAtLeast(
        allowed.reason.length,
        40,
        `${allowed.snippet} needs a reason that says why it may stay`,
      );
    }
  });

  it("would catch a name-derived branch if one came back", function () {
    const samples = [
      'if (name === "file_io") return null;',
      'if (toolName === "Read") rowSuffix = range;',
      "if (INTERNAL_PLAN_TOOL_NAMES.has(entry.payload.name)) return true;",
      'normalizeMcpToolName(toolName) === "paper_read"',
      'codeBlock && name !== "file_io" ? label : displayText',
    ];
    for (const sample of samples) {
      assert.isTrue(
        NAME_MEANING_PATTERNS.some((pattern) => pattern.matches(sample)),
        `the scan would miss: ${sample}`,
      );
    }
    assert.isFalse(
      NAME_MEANING_PATTERNS.some((pattern) =>
        pattern.matches('typeof entry.name === "string" && entry.name.trim()'),
      ),
      "a type guard is not a name comparison",
    );
  });
});
