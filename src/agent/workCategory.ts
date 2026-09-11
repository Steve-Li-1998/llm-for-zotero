import type { AgentWorkCategory, ToolSpec } from "./types";

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
