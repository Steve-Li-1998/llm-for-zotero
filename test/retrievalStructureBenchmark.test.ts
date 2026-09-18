import { assert } from "chai";
import {
  buildFixturePdfContext,
  loadRetrievalCorpusFixture,
  measureCorpus,
  restoreTestGlobals,
  snapshotTestGlobals,
  type CorpusName,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

/**
 * Structure benchmark. Milestone 0 only records the baseline: these numbers
 * describe how the shipped retrieval path labels and ranks the chunks of a
 * `##`-heading maths paper and a `#`-heading life-science paper. Later
 * milestones tighten these into thresholds (see task 2.2), so the printed
 * values matter more than the assertion.
 */
const ATTACHMENT_IDS: Record<CorpusName, number> = {
  mathDoubleHash: 9201,
  bioSingleHash: 9202,
};

function fixturePaperRef(attachmentId: number): PaperContextRef {
  return {
    itemId: 100,
    contextItemId: attachmentId,
    title: "Mock",
    firstCreator: "Tester",
    year: "2026",
  };
}

describe("retrieval structure benchmark", function () {
  this.timeout(120000);

  let globalsBefore: TestGlobalSnapshot;

  before(function () {
    globalsBefore = snapshotTestGlobals();
  });

  after(function () {
    restoreTestGlobals(globalsBefore);
  });

  for (const name of ["mathDoubleHash", "bioSingleHash"] as CorpusName[]) {
    it(`records baseline structure metrics for ${name}`, async function () {
      const attachmentId = ATTACHMENT_IDS[name];
      const ctx = await buildFixturePdfContext(name, attachmentId);
      const metrics = await measureCorpus(ctx, fixturePaperRef(attachmentId), {
        fullMarkdown: loadRetrievalCorpusFixture(name).md,
      });
      console.log(`${name} ${JSON.stringify(metrics)}`);
      assert.isNumber(metrics.labelCoverage);
    });
  }
});
