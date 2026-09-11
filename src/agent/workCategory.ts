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
