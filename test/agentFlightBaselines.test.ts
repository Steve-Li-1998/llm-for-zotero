import { assert } from "chai";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { summarizeAgentFlight } from "../src/agent/flightMetrics";
import {
  runBatchMaterialJourney,
  runDirectMaterialJourney,
} from "./helpers/materialJourneys";
import type { AgentFlightSummary } from "../src/agent/flightMetrics";

/**
 * The pinned cost of the two acceptance journeys.
 *
 * `test/fixtures/agentFlightBaselines.json` is the source of truth for these
 * numbers -- `docs/` is git-ignored, so nothing there can hold them. This test
 * replays each journey against the scripted adapter and the sqlite fakes and
 * compares what it measures with the last row of the fixture, so a change that
 * moves a number has to say so in the same review that makes it.
 */

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/agentFlightBaselines.json", import.meta.url),
);

const UPDATE_INSTRUCTION =
  "If the move is intended, update test/fixtures/agentFlightBaselines.json in the same commit as the behavior change that moved it, so the number and the change that caused it are reviewed together.";

type BaselineRow = {
  phase: string;
  commit: string;
  source?: string;
  reason?: string;
  journeys: Record<string, AgentFlightSummary> | null;
};

type Baselines = { schemaVersion: number; rows: BaselineRow[] };

function loadBaselines(): Baselines {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Baselines;
}

/** Every metric of a summary under the dotted path a reader can look up. */
function flattenMetrics(
  value: unknown,
  prefix = "",
  into = new Map<string, string>(),
): Map<string, string> {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      flattenMetrics(entry, `${prefix}[${index}]`, into),
    );
    return into;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value))
      flattenMetrics(entry, prefix ? `${prefix}.${key}` : key, into);
    return into;
  }
  into.set(prefix, JSON.stringify(value));
  return into;
}

/** Fails on the first metric that moved, naming it and both of its values. */
function assertPinned(
  journey: string,
  measured: AgentFlightSummary,
  pinned: AgentFlightSummary,
): void {
  const now = flattenMetrics(measured);
  const baseline = flattenMetrics(pinned);
  for (const [metric, value] of now) {
    const expected = baseline.get(metric);
    if (expected === undefined)
      assert.fail(
        `${journey}.${metric} is ${value} now, and the baseline pins no such metric. ${UPDATE_INSTRUCTION}`,
      );
    if (expected !== value)
      assert.fail(
        `${journey}.${metric} drifted: this run measured ${value}, the baseline pins ${expected}. ${UPDATE_INSTRUCTION}`,
      );
  }
  for (const metric of baseline.keys())
    if (!now.has(metric))
      assert.fail(
        `${journey}.${metric} is pinned at ${baseline.get(metric)}, and this run reports no such metric. ${UPDATE_INSTRUCTION}`,
      );
  assert.deepEqual(
    measured,
    pinned,
    `${journey} no longer matches its pinned baseline. ${UPDATE_INSTRUCTION}`,
  );
}

describe("agent flight baselines", function () {
  let measured: Record<string, AgentFlightSummary>;
  let latest: BaselineRow;

  before(async function () {
    const direct = await runDirectMaterialJourney();
    const batch = await runBatchMaterialJourney();
    measured = {
      directMaterial: summarizeAgentFlight(direct.events, {
        modelCalls: direct.modelCalls,
        nativeSaves: direct.nativeSaves,
      }),
      batchMaterial: summarizeAgentFlight(batch.events, {
        modelCalls: batch.modelCalls,
        nativeSaves: batch.nativeSaves,
      }),
    };
    const rows = loadBaselines().rows;
    latest = rows[rows.length - 1];
  });

  it("pins a row for a phase whose journey did not exist yet without inventing numbers", function () {
    const baselines = loadBaselines();
    assert.equal(baselines.schemaVersion, 1);
    const first = baselines.rows[0];
    assert.isNull(
      first.journeys,
      "a journey that did not exist has no baseline, and a fabricated one would be worse than none",
    );
    assert.isString(
      first.reason,
      "a null row must say why it is null, or the next reader will try to fill it in",
    );
  });

  it("measures the direct material journey at its pinned baseline", function () {
    assert.isNotNull(
      latest.journeys,
      "the newest row must carry measured journeys",
    );
    assertPinned(
      "directMaterial",
      measured.directMaterial,
      latest.journeys!.directMaterial,
    );
  });

  it("measures the batch material journey at its pinned baseline", function () {
    assert.isNotNull(
      latest.journeys,
      "the newest row must carry measured journeys",
    );
    assertPinned(
      "batchMaterial",
      measured.batchMaterial,
      latest.journeys!.batchMaterial,
    );
  });

  it("pins every journey it measures, and measures every journey it pins", function () {
    assert.deepEqual(
      Object.keys(latest.journeys || {}).sort(),
      Object.keys(measured).sort(),
      `the newest baseline row and this test measure different journeys. ${UPDATE_INSTRUCTION}`,
    );
  });
});
