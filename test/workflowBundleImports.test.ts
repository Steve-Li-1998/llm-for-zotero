/**
 * What the workflow test bundles are allowed to contain.
 *
 * `zotero-plugin test` bundles every `test-workflows/*.test.ts` file with its
 * own hardcoded esbuild options (`TestBundler.bundleTests` in
 * zotero-plugin-scaffold), and those options configure no loader for `.md`
 * files -- unlike the production build, which declares
 * `loader: { ".md": "text" }` in `zotero-plugin.config.ts`. So the moment any
 * module reachable from a workflow bundle imports a skill markdown file, the
 * whole workflow suite stops building with
 * `No loader is configured for ".md" files`, and not one workflow test runs.
 *
 * Every workflow test file imports `test-workflows/hostSurfaceBootstrap.ts` to
 * compose its bundle's bridges, so that module's value-import graph is the
 * floor every bundle carries. This test walks that graph the way esbuild does
 * -- type-only imports erased, everything else followed -- and fails if it
 * reaches a `.md` import, or the chat renderer that pulls the skill markdown
 * in behind it.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrap = "test-workflows/hostSurfaceBootstrap.ts";
const chatRenderer = "src/modules/contextPanel/chat.ts";

/**
 * Removes comments so that commented-out or documented imports are not read as
 * real edges. Line comments are only stripped when the `//` starts the line or
 * follows whitespace, so that `https://` inside a string survives.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

/** True when every specifier in a braced clause is `type`-qualified. */
function isTypeOnlyClause(clause: string): boolean {
  const braced = clause.match(/\{([\s\S]*)\}/);
  if (!braced) return false;
  if (/(^|[\s,}])\*\s+as\s/.test(clause)) return false;
  // A default or namespace binding sits outside the braces; if anything other
  // than whitespace precedes them, the statement still imports a value.
  if (clause.slice(0, clause.indexOf("{")).trim().length > 0) return false;
  const specifiers = braced[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (specifiers.length === 0) return false;
  return specifiers.every((entry) => /^type\s/.test(entry));
}

/**
 * The module specifiers a bundler would actually follow: `import type` and
 * all-`type` clauses erased, `import("x").T` type positions erased, and every
 * remaining static, re-exported, and dynamic import kept.
 */
function valueImportsOf(source: string): string[] {
  let text = stripComments(source);
  // `import("x").T` / `typeof import("x")` are type positions, not edges.
  text = text.replace(/\bimport\(\s*["'][^"']+["']\s*\)\s*\./g, " ");
  text = text.replace(/\btypeof\s+import\(\s*["'][^"']+["']\s*\)/g, " ");

  const specifiers: string[] = [];
  const statement = /\b(import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = statement.exec(text)) !== null) {
    const clause = match[2];
    if (/^\s*type\b/.test(clause)) continue;
    if (isTypeOnlyClause(clause)) continue;
    specifiers.push(match[3]);
  }

  const sideEffect = /\bimport\s*["']([^"']+)["']/g;
  while ((match = sideEffect.exec(text)) !== null) specifiers.push(match[1]);

  const dynamic = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamic.exec(text)) !== null) specifiers.push(match[1]);

  return specifiers;
}

/** Resolves a relative specifier the way the bundler's resolver would. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = join(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.js`,
    `${base.replace(/\.js$/, "")}.ts`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    const absolute = resolve(repoRoot, candidate);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    return relative(repoRoot, absolute).split("\\").join("/");
  }
  return null;
}

type Reached = { files: Set<string>; parents: Map<string, string> };

/** Walks value imports from `entry`, recording how each file was reached. */
function walkValueImports(entry: string): Reached {
  const files = new Set<string>([entry]);
  const parents = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current.endsWith(".md")) continue;
    const source = readFileSync(resolve(repoRoot, current), "utf8");
    for (const specifier of valueImportsOf(source)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveSpecifier(current, specifier);
      if (!resolved || files.has(resolved)) continue;
      files.add(resolved);
      parents.set(resolved, current);
      queue.push(resolved);
    }
  }
  return { files, parents };
}

/** The chain of files that led the walk to `file`, entry point first. */
function chainTo(reached: Reached, file: string): string {
  const chain = [file];
  let cursor = file;
  while (reached.parents.has(cursor)) {
    cursor = reached.parents.get(cursor) as string;
    chain.push(cursor);
  }
  return chain.reverse().join("\n  -> ");
}

describe("workflow test bundle imports", function () {
  it("never reaches a .md import, which the scaffold test bundler has no loader for", function () {
    const reached = walkValueImports(bootstrap);
    const markdown = [...reached.files].filter((file) => file.endsWith(".md"));
    assert.deepEqual(
      markdown,
      [],
      `Workflow bundles cannot build with a .md import; ${
        markdown[0] ? chainTo(reached, markdown[0]) : ""
      }`,
    );
  });

  it("never reaches the chat renderer, which imports the skill markdown", function () {
    const reached = walkValueImports(bootstrap);
    assert.isFalse(
      reached.files.has(chatRenderer),
      `The host-surface bootstrap must stay clear of ${chatRenderer}:\n  ${
        reached.files.has(chatRenderer) ? chainTo(reached, chatRenderer) : ""
      }`,
    );
  });
});
