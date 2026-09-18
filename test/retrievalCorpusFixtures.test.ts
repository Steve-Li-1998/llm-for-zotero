import { assert } from "chai";
import {
  buildFixturePdfContext,
  restoreTestGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";

describe("retrieval corpus fixtures", function () {
  let globalsBefore: TestGlobalSnapshot;

  before(function () {
    globalsBefore = snapshotTestGlobals();
  });

  after(function () {
    restoreTestGlobals(globalsBefore);
  });

  it("builds a MinerU-backed context for the math fixture", async function () {
    const ctx = await buildFixturePdfContext("mathDoubleHash", 9001);
    assert.equal(ctx.sourceType, "mineru");
    assert.isAtLeast(ctx.chunks.length, 10);
    assert.isTrue(
      ctx.chunks.some((c) =>
        c.includes("kinematic relation between the film height"),
      ),
    );
  });

  it("builds a MinerU-backed context for the bio fixture", async function () {
    const ctx = await buildFixturePdfContext("bioSingleHash", 9002);
    assert.isAtLeast(ctx.chunks.length, 4);
    assert.include(
      ctx.chunkMeta.map((m) => m.sectionLabel),
      "Results",
    );
  });
});
