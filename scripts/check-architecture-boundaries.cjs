#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

/**
 * Exact Agent-to-panel dependencies present when the architecture program
 * started. Every entry is a migration obligation, not a directory exemption.
 */
const ALLOWED_AGENT_PANEL_EDGES = [];

const CONTRACT_ROOTS = [
  "src/core/",
  "src/agent/authorization/",
  "src/agent/contracts/",
  "src/agent/execution/",
];

function slash(value) {
  return value.replace(/\\/g, "/");
}

function walkSourceFiles(dir, files = []) {
  for (const name of fs.readdirSync(dir)) {
    const absolute = path.join(dir, name);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walkSourceFiles(absolute, files);
    } else if (/\.(?:[cm]?ts|tsx)$/.test(name)) {
      files.push(absolute);
    }
  }
  return files;
}

function isTypeOnlyImport(statement) {
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (!bindings) return true;
  if (ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(statement) {
  if (statement.isTypeOnly) return true;
  const clause = statement.exportClause;
  return Boolean(
    clause &&
    ts.isNamedExports(clause) &&
    clause.elements.length &&
    clause.elements.every((element) => element.isTypeOnly),
  );
}

function loadAliases(root) {
  const file = path.join(root, "tsconfig.json");
  if (!fs.existsSync(file)) return [];
  const parsed = ts.parseConfigFileTextToJson(
    file,
    fs.readFileSync(file, "utf8"),
  );
  const options = parsed.config?.compilerOptions || {};
  const baseUrl = path.resolve(root, options.baseUrl || ".");
  return Object.entries(options.paths || {}).flatMap(([pattern, targets]) =>
    (targets || []).map((target) => ({ pattern, target, baseUrl })),
  );
}

function aliasCandidate(specifier, alias) {
  const marker = alias.pattern.indexOf("*");
  if (marker < 0) {
    return specifier === alias.pattern
      ? path.resolve(alias.baseUrl, alias.target)
      : null;
  }
  const prefix = alias.pattern.slice(0, marker);
  const suffix = alias.pattern.slice(marker + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  const value = specifier.slice(
    prefix.length,
    specifier.length - suffix.length,
  );
  return path.resolve(alias.baseUrl, alias.target.replace("*", value));
}

function resolveCandidate(base, fileSet) {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

function resolveImport(root, file, specifier, fileSet, aliases) {
  if (specifier.startsWith(".")) {
    return resolveCandidate(
      path.resolve(path.dirname(file), specifier),
      fileSet,
    );
  }
  if (specifier.startsWith("src/")) {
    return resolveCandidate(path.resolve(root, specifier), fileSet);
  }
  for (const alias of aliases) {
    const candidate = aliasCandidate(specifier, alias);
    const resolved = candidate && resolveCandidate(candidate, fileSet);
    if (resolved) return resolved;
  }
  return null;
}

function collectImportEdges(root = process.cwd()) {
  const sourceRoot = path.join(root, "src");
  const files = walkSourceFiles(sourceRoot);
  const fileSet = new Set(files);
  const aliases = loadAliases(root);
  const edges = [];
  const add = (file, specifier, kind) => {
    const resolved = resolveImport(root, file, specifier, fileSet, aliases);
    if (!resolved) return;
    edges.push({
      from: slash(path.relative(root, file)),
      to: slash(path.relative(root, resolved)),
      kind,
    });
  };

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        add(
          file,
          statement.moduleSpecifier.text,
          isTypeOnlyImport(statement) ? "type" : "runtime",
        );
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        add(
          file,
          statement.moduleSpecifier.text,
          isTypeOnlyExport(statement) ? "type" : "runtime",
        );
      }
    }
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        add(file, node.arguments[0].text, "runtime");
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        add(file, node.argument.literal.text, "type");
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }

  return [
    ...new Map(edges.map((edge) => [formatBoundary(edge), edge])).values(),
  ].sort((left, right) =>
    formatBoundary(left).localeCompare(formatBoundary(right)),
  );
}

function formatBoundary(boundary) {
  return `${boundary.kind}:${boundary.from} -> ${boundary.to}`;
}

function parseBoundary(value) {
  const match = /^(runtime|type):(.+) -> (.+)$/.exec(value);
  if (!match) throw new Error(`Invalid architecture baseline entry: ${value}`);
  return { kind: match[1], from: match[2], to: match[3] };
}

function checkArchitectureBoundaries(root = process.cwd()) {
  const edges = collectImportEdges(root);
  const agentPanelEdges = edges.filter(
    (edge) =>
      edge.from.startsWith("src/agent/") &&
      edge.to.startsWith("src/modules/contextPanel/"),
  );
  const current = new Map(
    agentPanelEdges.map((edge) => [formatBoundary(edge), edge]),
  );
  const allowed = new Map(
    ALLOWED_AGENT_PANEL_EDGES.map((value) => [value, parseBoundary(value)]),
  );
  const servicePanelEdges = edges.filter(
    (edge) =>
      edge.from.startsWith("src/services/") &&
      edge.to.startsWith("src/modules/contextPanel/"),
  );
  return {
    agentPanelEdges,
    unexpectedAgentPanelEdges: agentPanelEdges.filter(
      (edge) => !allowed.has(formatBoundary(edge)),
    ),
    staleAgentPanelEdges: [...allowed.entries()]
      .filter(([value]) => !current.has(value))
      .map(([, edge]) => edge),
    contractPanelEdges: agentPanelEdges.filter((edge) =>
      CONTRACT_ROOTS.some((rootPath) => edge.from.startsWith(rootPath)),
    ),
    servicePanelEdges,
  };
}

function printList(title, boundaries) {
  if (!boundaries.length) return;
  console.error(title);
  for (const boundary of boundaries) {
    console.error(`- ${formatBoundary(boundary)}`);
  }
}

if (require.main === module) {
  const result = checkArchitectureBoundaries(process.cwd());
  const failed =
    result.unexpectedAgentPanelEdges.length ||
    result.staleAgentPanelEdges.length ||
    result.contractPanelEdges.length ||
    result.servicePanelEdges.length;
  if (failed) {
    printList(
      "Unexpected Agent-to-panel dependencies:",
      result.unexpectedAgentPanelEdges,
    );
    printList("Stale migration obligations:", result.staleAgentPanelEdges);
    printList(
      "Shared-contract dependencies on panel code:",
      result.contractPanelEdges,
    );
    printList("Service dependencies on panel code:", result.servicePanelEdges);
    process.exit(1);
  }
  console.log(
    `Architecture-boundary check passed (${result.agentPanelEdges.length} exact migration obligations remain).`,
  );
}

module.exports = {
  checkArchitectureBoundaries,
  collectImportEdges,
  formatBoundary,
};
