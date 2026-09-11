import type { AgentWorkCategory, ToolSpec } from "./types";

const DEFAULT_WORK_CATEGORY: Readonly<
  Record<ToolSpec["executionClass"], AgentWorkCategory>
> = {
  read: "retrieval",
  control: "planning",
  external_effect: "zotero_action",
};

/**
 * Resolve trace meaning from the tool contract, never from its name or prose.
 * Tools whose execution class is too broad must declare an explicit category.
 */
export function resolveAgentWorkCategory(
  spec: Pick<ToolSpec, "executionClass" | "workCategory">,
): AgentWorkCategory {
  return spec.workCategory || DEFAULT_WORK_CATEGORY[spec.executionClass];
}
