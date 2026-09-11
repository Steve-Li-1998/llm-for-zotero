import { assert } from "chai";
import { createRequire } from "module";
import { readFileSync } from "fs";

const require = createRequire(import.meta.url);
const { checkArchitectureBoundaries, formatBoundary } =
  require("../scripts/check-architecture-boundaries.cjs") as {
    checkArchitectureBoundaries: (root?: string) => {
      unexpectedAgentPanelEdges: unknown[];
      staleAgentPanelEdges: unknown[];
      contractPanelEdges: unknown[];
      servicePanelEdges: unknown[];
    };
    formatBoundary: (boundary: unknown) => string;
  };

function formatted(boundaries: unknown[]): string[] {
  return boundaries.map((boundary) => formatBoundary(boundary));
}

describe("architecture boundaries", function () {
  it("rejects new Agent-to-panel dependencies and stale baseline entries", function () {
    this.timeout(10_000);
    const result = checkArchitectureBoundaries(process.cwd());
    assert.deepEqual(formatted(result.unexpectedAgentPanelEdges), []);
    assert.deepEqual(formatted(result.staleAgentPanelEdges), []);
    assert.deepEqual(formatted(result.contractPanelEdges), []);
    assert.deepEqual(formatted(result.servicePanelEdges), []);
  });

  it("exposes the architecture check as a repository command", function () {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    assert.equal(
      packageJson.scripts?.["check:architecture"],
      "node scripts/check-architecture-boundaries.cjs",
    );
  });
});
