import { assert } from "chai";
import { createRequire } from "module";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const require = createRequire(import.meta.url);

type Boundary = { kind: "runtime" | "type"; from: string; to: string };

type CheckResult = {
  unclassifiedDirectories: string[];
  upwardRuntimeEdges: Boundary[];
  unexpectedUpwardEdges: Boundary[];
  staleObligations: Boundary[];
  upwardTypeWarnings: Boundary[];
};

type Layer = { tier: number; name: string; roots: string[] };

const {
  checkArchitectureBoundaries,
  formatBoundary,
  validateLayers,
  LAYERS,
  MIGRATION_OBLIGATIONS,
} = require("../scripts/check-architecture-boundaries.cjs") as {
  checkArchitectureBoundaries: (
    root?: string,
    options?: { obligations?: string[] },
  ) => CheckResult;
  formatBoundary: (boundary: Boundary) => string;
  validateLayers: (layers: Layer[]) => Layer[];
  LAYERS: Layer[];
  MIGRATION_OBLIGATIONS: string[];
};

function formatted(boundaries: Boundary[]): string[] {
  return boundaries.map((boundary) => formatBoundary(boundary));
}

function writeFixture(root: string, files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  }
}

describe("architecture boundaries", function () {
  it("keeps the layer order clean apart from the recorded migration obligations", function () {
    this.timeout(20_000);
    const result = checkArchitectureBoundaries(process.cwd());
    assert.deepEqual(result.unclassifiedDirectories, []);
    assert.deepEqual(formatted(result.unexpectedUpwardEdges), []);
    assert.deepEqual(formatted(result.staleObligations), []);
  });

  it("classifies every top-level directory under src", function () {
    const roots = LAYERS.flatMap((layer) => layer.roots);
    assert.isAbove(roots.length, 0);
    assert.include(roots, "src/core/");
    assert.include(roots, "src/services/");
    assert.include(roots, "src/agent/");
    assert.include(roots, "src/modules/");
  });

  describe("layer table validation", function () {
    it("accepts the real layer table", function () {
      assert.equal(validateLayers(LAYERS), LAYERS);
    });

    it("rejects a directory claimed by two layers", function () {
      assert.throws(
        () =>
          validateLayers([
            { tier: 0, name: "core", roots: ["src/core/"] },
            { tier: 1, name: "foundation", roots: ["src/utils/", "src/core/"] },
          ]),
        /src\/core\/ is claimed by more than one layer/,
      );
    });

    it("rejects a duplicated directory inside one layer", function () {
      assert.throws(
        () =>
          validateLayers([
            { tier: 0, name: "core", roots: ["src/core/", "src/core/"] },
          ]),
        /src\/core\/ is claimed by more than one layer/,
      );
    });

    it("rejects a tier value that does not match its position", function () {
      assert.throws(
        () =>
          validateLayers([
            { tier: 0, name: "core", roots: ["src/core/"] },
            { tier: 2, name: "services", roots: ["src/services/"] },
          ]),
        /"services" declares tier 2 at position 1/,
      );
    });
  });

  it("records the services-to-agent change journal edge as a migration obligation", function () {
    assert.include(
      MIGRATION_OBLIGATIONS,
      "runtime:src/services/zoteroChangeDispatcher.ts -> src/agent/store/changeJournal.ts",
    );
  });

  describe("layer-order rule on a fixture tree", function () {
    let root = "";

    before(function () {
      root = mkdtempSync(join(tmpdir(), "architecture-layers-"));
      writeFixture(root, {
        // Foundation tier reaching up into services (runtime) and agent (type).
        "src/utils/foundation.ts": [
          'import { serve } from "../services/consumer";',
          'import type { Runner } from "../agent/runtime";',
          "export const helper = (runner: Runner) => serve(runner);",
          "",
        ].join("\n"),
        // Services reaching down into the foundation tier: allowed.
        "src/services/consumer.ts": [
          'import { helper } from "../utils/foundation";',
          "export const serve = (value: unknown) => helper(value as never);",
          "",
        ].join("\n"),
        // Agent reaching down into services: allowed.
        "src/agent/runtime.ts": [
          'import { serve } from "../services/consumer";',
          "export type Runner = { id: string };",
          "export const run = () => serve(null);",
          "",
        ].join("\n"),
      });
    });

    after(function () {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it("fails an upward runtime edge", function () {
      const result = checkArchitectureBoundaries(root, { obligations: [] });
      assert.include(
        formatted(result.unexpectedUpwardEdges),
        "runtime:src/utils/foundation.ts -> src/services/consumer.ts",
      );
    });

    it("passes downward runtime edges", function () {
      const result = checkArchitectureBoundaries(root, { obligations: [] });
      const upward = formatted(result.upwardRuntimeEdges);
      assert.notInclude(
        upward,
        "runtime:src/services/consumer.ts -> src/utils/foundation.ts",
      );
      assert.notInclude(
        upward,
        "runtime:src/agent/runtime.ts -> src/services/consumer.ts",
      );
    });

    it("reports an upward type-only edge as a warning, not a failure", function () {
      const result = checkArchitectureBoundaries(root, { obligations: [] });
      assert.include(
        formatted(result.upwardTypeWarnings),
        "type:src/utils/foundation.ts -> src/agent/runtime.ts",
      );
      assert.notInclude(
        formatted(result.unexpectedUpwardEdges),
        "type:src/utils/foundation.ts -> src/agent/runtime.ts",
      );
    });

    it("accepts a recorded obligation for an upward runtime edge", function () {
      const result = checkArchitectureBoundaries(root, {
        obligations: [
          "runtime:src/utils/foundation.ts -> src/services/consumer.ts",
        ],
      });
      assert.deepEqual(formatted(result.unexpectedUpwardEdges), []);
      assert.deepEqual(formatted(result.staleObligations), []);
    });

    it("reports an obligation that no longer matches a real edge as stale", function () {
      const result = checkArchitectureBoundaries(root, {
        obligations: ["runtime:src/utils/gone.ts -> src/services/consumer.ts"],
      });
      assert.deepEqual(formatted(result.staleObligations), [
        "runtime:src/utils/gone.ts -> src/services/consumer.ts",
      ]);
    });

    it("refuses to classify an unknown top-level directory", function () {
      const extra = join(root, "src/mystery");
      mkdirSync(extra, { recursive: true });
      writeFileSync(
        join(extra, "thing.ts"),
        "export const thing = 1;\n",
        "utf8",
      );
      try {
        const result = checkArchitectureBoundaries(root, { obligations: [] });
        assert.deepEqual(result.unclassifiedDirectories, ["src/mystery/"]);
      } finally {
        rmSync(extra, { recursive: true, force: true });
      }
    });
  });

  it("exposes the architecture check as a repository command", function () {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    assert.equal(
      packageJson.scripts?.["check:architecture"],
      "node scripts/check-architecture-boundaries.cjs",
    );
  });
});
