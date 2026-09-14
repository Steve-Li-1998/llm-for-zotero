import type { ActionConstraint } from "../authorization/types";
import {
  validMaterialOutputs,
  type MaterialOutputIntent,
} from "../contracts/workflowDependencies";

export type SemanticDecisions = {
  /** Whether the user needs only the verified action result or a substantive answer too. */
  responseIntent?: "receipt" | "answer";
  /** Faithful wording/format transformation versus substantive analysis. */
  generationMode?: "transform" | "reason";
  materialOutputs?: MaterialOutputIntent[];
  workflowReuse?: {
    contractId: string;
    actions: Array<{ actionIndex: number; previousActionIndex: number }>;
    outputs: Array<{ outputId: string; previousOutputId: string }>;
  };
  constraints: ActionConstraint[];
  noteDestination: "none" | "zotero" | "file" | "both";
  conversationOnly: boolean;
  reading: {
    source:
      | "provided_context"
      | "metadata"
      | "document_text"
      | "rendered_pages";
    coverage: "overview" | "targeted" | "exhaustive";
  };
  literature: "none" | "discover" | "import" | "select_then_import";
  requestedCount?: number;
  researchScopeCount?: number;
  supportTools?: string[];
  literatureMode?: "references" | "citations";
  literatureSource?: "openalex" | "arxiv" | "europepmc";
  visualMode?: "general" | "figure" | "equation";
  pages?: number[];
  retrievalPurpose?:
    | "factual"
    | "conceptual"
    | "methodological"
    | "comparative"
    | "citation"
    | "visual"
    | "general";
  figures?: {
    labels: string[];
    includeSupplementary: boolean;
    kind: "figures" | "tables" | "both";
  };
  bulk: boolean;
  continuation: "new" | "resume" | "revise";
  questions: string[];
  assumptions?: string[];
};

export type SemanticIntent = SemanticDecisions & {
  version: 1;
  id: string;
  revision: number;
  inputDigest: string;
  provenance?: {
    provider: string;
    model: string;
    interpretedAt: number;
    promptVersion: 1;
    requestDigest: string;
    predecessorId?: string;
  };
};

const domains = new Set([
  "zotero_library",
  "filesystem",
  "local_execution",
  "network",
  "privileged_zotero",
]);
const effects = new Set([
  "read",
  "create",
  "modify",
  "delete",
  "execute",
  "egress",
]);
const mechanisms = new Set(["shell", "zotero_script"]);
const listOf = (value: unknown, values?: Set<string>): value is string[] =>
  Array.isArray(value) &&
  value.every(
    (entry) => typeof entry === "string" && (!values || values.has(entry)),
  );

/** Decode structured model output. Never infer missing decisions from request text. */
export function parseSemanticDecisions(
  record: Record<string, unknown> | null,
): SemanticDecisions | null {
  const raw = record?.decisions;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.constraints)) return null;
  for (const entry of value.constraints) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.description !== "string"
    )
      return null;
    if (entry.kind === "deny_effects") {
      if (
        !listOf(entry.effects, effects) ||
        !entry.effects.length ||
        !listOf(entry.domains, domains) ||
        !entry.domains.length
      )
        return null;
      if (entry.operations !== undefined && !listOf(entry.operations))
        return null;
      if (
        entry.exceptOperations !== undefined &&
        !listOf(entry.exceptOperations)
      )
        return null;
    } else if (entry.kind === "deny_mechanisms") {
      if (!listOf(entry.mechanisms, mechanisms) || !entry.mechanisms.length)
        return null;
    } else return null;
  }
  const reading = value.reading as Record<string, unknown> | undefined;
  if (
    !reading ||
    ![
      "provided_context",
      "metadata",
      "document_text",
      "rendered_pages",
    ].includes(String(reading.source)) ||
    !["overview", "targeted", "exhaustive"].includes(
      String(reading.coverage),
    ) ||
    !["none", "zotero", "file", "both"].includes(
      String(value.noteDestination),
    ) ||
    !["none", "discover", "import", "select_then_import"].includes(
      String(value.literature),
    ) ||
    !["new", "resume", "revise"].includes(String(value.continuation)) ||
    typeof value.conversationOnly !== "boolean" ||
    typeof value.bulk !== "boolean" ||
    !listOf(value.questions)
  )
    return null;
  if (
    value.generationMode !== undefined &&
    !["transform", "reason"].includes(String(value.generationMode))
  )
    return null;
  if (value.assumptions !== undefined && !listOf(value.assumptions))
    return null;
  if (
    value.responseIntent !== undefined &&
    !["receipt", "answer"].includes(String(value.responseIntent))
  )
    return null;
  if (
    value.requestedCount !== undefined &&
    (!Number.isSafeInteger(value.requestedCount) ||
      Number(value.requestedCount) <= 0)
  )
    return null;
  if (
    value.literatureMode !== undefined &&
    !["references", "citations"].includes(String(value.literatureMode))
  )
    return null;
  if (
    value.literatureSource !== undefined &&
    !["openalex", "arxiv", "europepmc"].includes(String(value.literatureSource))
  )
    return null;
  if (
    value.visualMode !== undefined &&
    !["general", "figure", "equation"].includes(String(value.visualMode))
  )
    return null;
  if (
    value.researchScopeCount !== undefined &&
    (!Number.isSafeInteger(value.researchScopeCount) ||
      Number(value.researchScopeCount) <= 0)
  )
    return null;
  if (
    value.retrievalPurpose !== undefined &&
    ![
      "factual",
      "conceptual",
      "methodological",
      "comparative",
      "citation",
      "visual",
      "general",
    ].includes(String(value.retrievalPurpose))
  )
    return null;
  if (
    value.pages !== undefined &&
    (!Array.isArray(value.pages) ||
      !value.pages.every((page) => Number.isSafeInteger(page) && page > 0))
  )
    return null;
  if (value.figures !== undefined) {
    const figures = value.figures as Record<string, unknown>;
    if (
      !figures ||
      !listOf(figures.labels) ||
      typeof figures.includeSupplementary !== "boolean" ||
      !["figures", "tables", "both"].includes(String(figures.kind))
    )
      return null;
  }
  if (value.supportTools !== undefined && !listOf(value.supportTools))
    return null;
  if (
    value.materialOutputs !== undefined &&
    !validMaterialOutputs(value.materialOutputs)
  )
    return null;
  if (value.workflowReuse !== undefined) {
    const reuse = value.workflowReuse as SemanticDecisions["workflowReuse"];
    if (
      !reuse ||
      typeof reuse.contractId !== "string" ||
      !reuse.contractId ||
      !Array.isArray(reuse.actions) ||
      !Array.isArray(reuse.outputs) ||
      reuse.actions.some(
        (entry) =>
          !entry ||
          !Number.isSafeInteger(entry.actionIndex) ||
          entry.actionIndex < 0 ||
          !Number.isSafeInteger(entry.previousActionIndex) ||
          entry.previousActionIndex < 0,
      ) ||
      reuse.outputs.some(
        (entry) =>
          !entry ||
          typeof entry.outputId !== "string" ||
          !entry.outputId ||
          typeof entry.previousOutputId !== "string" ||
          !entry.previousOutputId,
      ) ||
      new Set(reuse.actions.map((entry) => entry.actionIndex)).size !==
        reuse.actions.length ||
      new Set(reuse.actions.map((entry) => entry.previousActionIndex)).size !==
        reuse.actions.length ||
      new Set(reuse.outputs.map((entry) => entry.outputId)).size !==
        reuse.outputs.length ||
      new Set(reuse.outputs.map((entry) => entry.previousOutputId)).size !==
        reuse.outputs.length
    )
      return null;
  }
  return JSON.parse(JSON.stringify(value)) as SemanticDecisions;
}
