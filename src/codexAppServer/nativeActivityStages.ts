/**
 * What Codex did inside its own process, said once, beside the protocol.
 *
 * Codex reports the work it runs itself -- a web search, an image it made or
 * looked at, a shell command, a file edit -- as items of the app-server
 * protocol. Each item states its own kind, so nothing has to be guessed from
 * the words in it. That kind is the only fact the trace needs: it selects the
 * work category from the shared table and the row's fixed wording.
 *
 * The mapping lives here rather than in the panel because this module is the
 * one that already speaks the protocol. The panel appends what it is handed
 * and decides nothing; a second reader of these item types would be a second
 * taxonomy to keep in step with this one.
 *
 * Parsing an identifier out of an item is identity, not meaning, and stays
 * here with it.
 */
import type { AgentEvent } from "../agent/types";
import {
  resolveCodexNativeWorkCategory,
  SKILL_ACTIVATION_WORK_CATEGORY,
  type CodexNativeWorkKind,
} from "../agent/workCategory";
import { isRenderableGeneratedImageSrc } from "../shared/generatedImages";
import type { GeneratedChatImage } from "../shared/types";
import { sanitizeText } from "../utils/textSanitization";

/** One item of a native Codex turn, as the app-server process reports it. */
export type CodexNativeActivityItem = {
  id?: string;
  type?: string;
  role?: string;
  status?: string;
  summary?: string;
  details?: string;
  error?: string;
  name?: string;
  toolName?: string;
  title?: string;
  serverName?: string;
  arguments?: unknown;
  query?: string;
  action?: unknown;
  command?: string;
  cwd?: string;
  path?: string;
  result?: unknown;
  savedPath?: string;
  revisedPrompt?: string;
  exitCode?: number;
  durationMs?: number;
  changes?: unknown;
  success?: boolean;
  namespace?: string;
  model?: string;
  receiverThreadIds?: unknown;
  raw?: Record<string, unknown>;
};

export type CodexNativeActivityPhase = "started" | "completed";

export type AgentStageEvent = Extract<AgentEvent, { type: "agent_stage" }>;
export type CodexToolActivityPayload = Extract<
  AgentEvent,
  { type: "codex_tool_activity" }
>;

/**
 * The events one native item produces in one phase.
 *
 * `generatedImage` is not an event: an image Codex produced belongs to the
 * assistant message, which only the panel owns. It travels with the mapping
 * so the panel never has to recognise an image item for itself.
 */
export type CodexNativeItemEvents = {
  stage?: AgentStageEvent;
  activity?: CodexToolActivityPayload;
  generatedImage?: GeneratedChatImage;
};

/** The item type with its separators removed, for a stable substring test. */
export function normalizeCodexNativeItemTypeKey(
  type: string | undefined,
): string {
  return sanitizeText(type || "")
    .replace(/[-_\s]+/g, "")
    .toLowerCase();
}

export function isCodexNativeItemType(
  item: Pick<CodexNativeActivityItem, "type">,
  keys: string[],
): boolean {
  const itemType = normalizeCodexNativeItemTypeKey(item.type);
  return keys.some((key) => itemType.includes(key));
}

/** The raw protocol field behind one of several spellings. */
export function readCodexNativeRawField(
  item: CodexNativeActivityItem,
  keys: string[],
): unknown {
  const raw = item.raw || {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) return raw[key];
  }
  return undefined;
}

export function getCodexNativeRawString(
  item: CodexNativeActivityItem,
  keys: string[],
  maxLength = 4000,
): string {
  for (const key of keys) {
    const value =
      (item as unknown as Record<string, unknown>)[key] ??
      readCodexNativeRawField(item, [key]);
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text) return text.slice(0, maxLength);
  }
  return "";
}

export function getCodexNativeStatus(item: CodexNativeActivityItem): string {
  return (
    sanitizeText(item.status || "").trim() ||
    getCodexNativeRawString(item, ["status"], 120)
  );
}

/** The item type as ordinary words, for the trace's generic status line. */
export function humanizeCodexNativeItemType(type: string | undefined): string {
  return sanitizeText(type || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function compactCodexNativePathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function getCodexNativeGeneratedImage(
  item: CodexNativeActivityItem,
): GeneratedChatImage | null {
  const itemId = sanitizeText(item.id || "").trim();
  if (!itemId) return null;
  const savedPath =
    sanitizeText(item.savedPath || "").trim() ||
    getCodexNativeRawString(item, ["savedPath", "saved_path"], 4000);
  const result =
    typeof item.result === "string"
      ? item.result.trim()
      : getCodexNativeRawString(item, ["result"], Number.MAX_SAFE_INTEGER);
  const revisedPrompt =
    sanitizeText(item.revisedPrompt || "").trim() ||
    getCodexNativeRawString(item, ["revisedPrompt", "revised_prompt"], 8000);
  if (savedPath) {
    return {
      id: itemId,
      label: compactCodexNativePathBasename(savedPath),
      path: savedPath,
      ...(revisedPrompt ? { revisedPrompt } : {}),
    };
  }
  if (isRenderableGeneratedImageSrc(result)) {
    return {
      id: itemId,
      label: "Generated image",
      src: result,
      ...(revisedPrompt ? { revisedPrompt } : {}),
    };
  }
  return null;
}

/** One kind of native work, before it is turned into the two events. */
type CodexNativeStructuredOperation = {
  kind: CodexNativeWorkKind;
  toolName: string;
  toolLabel: string;
  args?: unknown;
  text?: string;
  codeBlock?: string;
  generatedImage?: GeneratedChatImage;
};

/**
 * Whether the item reports its own failure.
 *
 * The protocol says so three ways -- an error, a false success, or a status
 * word -- and none of them is the panel's reading of free prose: the strings
 * tested here are the item's own status fields.
 */
function isFailedCodexNativeItem(item: CodexNativeActivityItem): boolean {
  const status = getCodexNativeStatus(item);
  return (
    Boolean(item.error) ||
    /failed|error|cancelled|denied|rejected/i.test(
      sanitizeText(status || item.summary || item.details || ""),
    ) ||
    item.success === false
  );
}

function readCodexNativeWebSearchArgs(item: CodexNativeActivityItem): {
  args?: Record<string, string>;
  actionType: string;
} | null {
  const action = item.action || readCodexNativeRawField(item, ["action"]);
  const record =
    action && typeof action === "object" && !Array.isArray(action)
      ? (action as Record<string, unknown>)
      : null;
  const actionType = sanitizeText(String(record?.type || "")).trim();
  const query =
    sanitizeText(item.query || "").trim() ||
    getCodexNativeRawString(item, ["query"], 1000) ||
    sanitizeText(String(record?.query || "")).trim() ||
    (Array.isArray(record?.queries)
      ? record.queries
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => sanitizeText(entry).trim())
          .filter(Boolean)
          .join("; ")
      : "");
  const url = sanitizeText(String(record?.url || "")).trim();
  const pattern = sanitizeText(String(record?.pattern || "")).trim();
  const args: Record<string, string> = {};
  if (query) args.query = query;
  if (url) args.url = url;
  if (pattern) args.pattern = pattern;
  return Object.keys(args).length || actionType
    ? { args: Object.keys(args).length ? args : undefined, actionType }
    : null;
}

function resolveCodexNativeStructuredOperation(
  item: CodexNativeActivityItem,
  phase: CodexNativeActivityPhase,
  failed: boolean,
): CodexNativeStructuredOperation | null {
  if (isCodexNativeItemType(item, ["websearch", "websearchcall"])) {
    const webSearch = readCodexNativeWebSearchArgs(item);
    const actionType = normalizeCodexNativeItemTypeKey(webSearch?.actionType);
    const verb =
      actionType === "openpage"
        ? phase === "completed"
          ? "Opened web page"
          : "Opening web page"
        : actionType === "findinpage"
          ? phase === "completed"
            ? "Searched within page"
            : "Searching within page"
          : phase === "completed"
            ? "Searched web"
            : "Searching web";
    const query =
      sanitizeText(item.query || "").trim() ||
      getCodexNativeRawString(item, ["query"], 1000);
    return {
      kind: "web_search",
      toolName: "codex_web_search",
      toolLabel: "Web search",
      args: webSearch?.args || (query ? { query } : undefined),
      text: failed && phase === "completed" ? "Web search failed" : verb,
    };
  }

  if (isCodexNativeItemType(item, ["imagegeneration"])) {
    const generatedImage =
      phase === "completed" ? getCodexNativeGeneratedImage(item) : null;
    const status = getCodexNativeStatus(item);
    const savedPath =
      generatedImage?.path ||
      sanitizeText(item.savedPath || "").trim() ||
      getCodexNativeRawString(item, ["savedPath", "saved_path"], 4000);
    return {
      kind: "image_generation",
      toolName: "image_generation",
      toolLabel: "Generated image",
      args: {
        ...(status ? { status } : {}),
        ...(savedPath
          ? { saved: compactCodexNativePathBasename(savedPath) }
          : {}),
      },
      text:
        phase === "completed"
          ? failed
            ? `Generated image: ${status || "failed"}`
            : "Generated image"
          : "Generating image",
      ...(generatedImage ? { generatedImage } : {}),
    };
  }

  if (isCodexNativeItemType(item, ["imageview"])) {
    const path =
      sanitizeText(item.path || "").trim() ||
      getCodexNativeRawString(item, ["path"], 4000);
    return {
      kind: "image_view",
      toolName: "image_view",
      toolLabel: "Viewed image",
      args: path ? { path } : undefined,
      text: phase === "completed" ? "Viewed image" : "Viewing image",
    };
  }

  const command =
    sanitizeText(item.command || "").trim() ||
    getCodexNativeRawString(item, ["command"], 8000);
  if (command || isCodexNativeItemType(item, ["command", "exec"])) {
    const cwd =
      sanitizeText(item.cwd || "").trim() ||
      getCodexNativeRawString(item, ["cwd"], 4000);
    const exitCode =
      typeof item.exitCode === "number" && Number.isFinite(item.exitCode)
        ? item.exitCode
        : undefined;
    return {
      kind: "command",
      toolName: "command",
      toolLabel: "Command",
      args: {
        ...(cwd ? { cwd } : {}),
        ...(typeof exitCode === "number" ? { status: `exit ${exitCode}` } : {}),
      },
      text:
        phase === "completed"
          ? failed || (typeof exitCode === "number" && exitCode !== 0)
            ? "Command failed"
            : "Ran command"
          : "Running command",
      codeBlock: command || undefined,
    };
  }

  if (
    item.changes !== undefined ||
    isCodexNativeItemType(item, ["filechange", "filechanges", "patch"])
  ) {
    return {
      kind: "file_changes",
      toolName: "file_changes",
      toolLabel: "File changes",
      args: item.changes,
      text:
        phase === "completed"
          ? failed
            ? "File changes failed"
            : "Updated files"
          : "Updating files",
    };
  }

  return null;
}

/**
 * A stage event carrying only the fields it knows.
 *
 * The runtime and the compatibility projection drop undefined-valued keys for
 * the same reason: the trace store persists JSON, so such a key disappears on
 * the way to storage and a live stage would stop equalling its stored self.
 */
export function buildAgentStageEvent(
  fields: Omit<AgentStageEvent, "type">,
): AgentStageEvent {
  const event: Record<string, unknown> = { type: "agent_stage", ...fields };
  for (const key of Object.keys(event)) {
    if (event[key] === undefined) delete event[key];
  }
  return event as AgentStageEvent;
}

/**
 * The stage status the phase and outcome imply.
 *
 * The same rule the compatibility projection applies to a stored activity
 * row, so a run that emits its own stages and a run projected from an older
 * trace read identically.
 */
export function resolveCodexNativeStageStatus(
  phase: CodexNativeActivityPhase,
  ok: boolean | undefined,
): AgentStageEvent["status"] {
  if (phase === "started") return "started";
  return ok === false ? "failed" : "completed";
}

/**
 * The stage and the trace row one native item produces, or `null` when the
 * item is not work Codex ran (a message, reasoning, a plan the plan card
 * already shows).
 *
 * `fallbackItemId` names an item the protocol left unnamed; the caller owns
 * the uniqueness of that name because only it knows the run it is building.
 */
export function mapCodexNativeItemToEvents(
  item: CodexNativeActivityItem,
  phase: CodexNativeActivityPhase,
  fallbackItemId?: string,
): CodexNativeItemEvents | null {
  const failed = isFailedCodexNativeItem(item);
  const operation = resolveCodexNativeStructuredOperation(item, phase, failed);
  if (!operation) return null;
  const itemId =
    sanitizeText(item.id || "").trim() ||
    sanitizeText(fallbackItemId || "").trim() ||
    `codex-${normalizeCodexNativeItemTypeKey(item.type) || "item"}-${phase}`;
  const ok = phase === "completed" ? !failed : undefined;
  const workCategory = resolveCodexNativeWorkCategory(operation.kind);
  const args =
    operation.args && typeof operation.args === "object"
      ? Object.keys(operation.args as Record<string, unknown>).length
        ? operation.args
        : undefined
      : operation.args;
  return {
    stage: buildAgentStageEvent({
      stage: workCategory,
      status: resolveCodexNativeStageStatus(phase, ok),
      toolName: operation.toolName,
      toolLabel: operation.toolLabel,
    }),
    activity: {
      type: "codex_tool_activity",
      itemId,
      phase,
      toolName: operation.toolName,
      toolLabel: operation.toolLabel,
      ...(args !== undefined ? { args } : {}),
      ...(typeof ok === "boolean" ? { ok } : {}),
      ...(operation.text ? { text: operation.text } : {}),
      ...(operation.codeBlock ? { codeBlock: operation.codeBlock } : {}),
      workCategory,
    },
    ...(operation.generatedImage
      ? { generatedImage: operation.generatedImage }
      : {}),
  };
}

/**
 * The label a skill activation carries into the trace.
 *
 * The row and the stage say "Skill" because that is what happened; the skill
 * itself is in the row's arguments. Nothing downstream looks up a tool by
 * this word -- a skill is not a registered tool and has no spec.
 */
export const CODEX_NATIVE_SKILL_ACTIVATION_LABEL = "Skill";

/**
 * The stage and row one skill activation produces.
 *
 * A connected runtime activates a skill on its own, so there is no tool call
 * to bracket: the activation is the planning it stands for, reported once and
 * already complete.
 */
export function mapCodexNativeSkillActivationToEvents(
  skillId: string,
  options: { source?: "codex-native-slash" } = {},
): CodexNativeItemEvents | null {
  const cleanSkillId = sanitizeText(skillId || "").trim();
  if (!cleanSkillId) return null;
  return {
    stage: buildAgentStageEvent({
      stage: SKILL_ACTIVATION_WORK_CATEGORY,
      status: "completed",
      toolLabel: CODEX_NATIVE_SKILL_ACTIVATION_LABEL,
    }),
    activity: {
      type: "codex_tool_activity",
      itemId: `skill:${cleanSkillId}`,
      phase: "completed",
      toolLabel: CODEX_NATIVE_SKILL_ACTIVATION_LABEL,
      args: {
        skill: cleanSkillId,
        ...(options.source ? { source: options.source } : {}),
      },
      workCategory: SKILL_ACTIVATION_WORK_CATEGORY,
    },
  };
}
