import type { AgentToolDefinition, AgentWorkCategory, ToolSpec } from "./types";

/**
 * Resolve trace meaning from the tool contract, never from its name or prose.
 *
 * Every spec declares its own category: an execution class says how the host
 * must authorize a call, not what work the call represents, so no default
 * table can be correct for both.
 */
export function resolveAgentWorkCategory(
  spec: Pick<ToolSpec, "workCategory">,
): AgentWorkCategory {
  return spec.workCategory;
}

/**
 * Resolve the category for one call.
 *
 * A delegating facade covers several kinds of work behind one spec — importing
 * a DOI changes only the library, importing a local file reaches the disk — so
 * the tool may narrow the label from the arguments the model sent. Everything
 * else keeps its declared category.
 */
export function resolveAgentToolCallWorkCategory(
  tool: Pick<AgentToolDefinition<any, any>, "spec" | "resolveWorkCategory">,
  args: unknown,
): AgentWorkCategory {
  return (
    tool.resolveWorkCategory?.(args) || resolveAgentWorkCategory(tool.spec)
  );
}

/**
 * Work a connected runtime performed inside its own process.
 *
 * A connected client's file write or shell command never reaches a host
 * `ToolSpec`, so it has no category to declare. It is named here with the
 * registered tools rather than spelled at the bridge, so the vocabulary stays
 * in one table.
 */
export const CONNECTED_RUNTIME_EFFECT_WORK_CATEGORY: AgentWorkCategory =
  "external_system";

/**
 * Activating a skill.
 *
 * A skill is a way of working the run adopted before doing the work, so it
 * belongs with the planning the run did rather than with the reading or
 * writing that followed. No `ToolSpec` declares it -- a connected runtime
 * activates a skill on its own -- so it is named here with the registered
 * tools instead of being spelled at whichever bridge noticed it.
 */
export const SKILL_ACTIVATION_WORK_CATEGORY: AgentWorkCategory = "planning";

/**
 * The label a skill activation carries into the trace.
 *
 * The bridge stamps it on the events it emits and the trace reads it back to
 * recognise the row; both sides therefore read it from here, because a label
 * written twice is a label that can disagree with itself. Nothing looks a
 * tool up by this word -- a skill is not a registered tool and has no spec.
 */
export const SKILL_ACTIVATION_TRACE_LABEL = "Skill";

/**
 * Activity kinds native Codex reports for work it runs itself. These never
 * reach a host `ToolSpec`, so the panel resolves their meaning here instead of
 * spelling a second taxonomy at each render site.
 */
export const CODEX_NATIVE_WORK_KINDS = [
  "web_search",
  "image_generation",
  "image_view",
  "command",
  "file_changes",
] as const;

export type CodexNativeWorkKind = (typeof CODEX_NATIVE_WORK_KINDS)[number];

const CODEX_NATIVE_WORK_CATEGORIES: Readonly<
  Record<CodexNativeWorkKind, AgentWorkCategory>
> = {
  web_search: "retrieval",
  image_generation: "generation",
  image_view: "retrieval",
  command: "external_system",
  file_changes: "external_system",
};

export function resolveCodexNativeWorkCategory(
  kind: CodexNativeWorkKind,
): AgentWorkCategory {
  return CODEX_NATIVE_WORK_CATEGORIES[kind];
}
