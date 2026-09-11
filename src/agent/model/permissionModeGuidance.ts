import type { OriginalAgentPermissionMode } from "../../shared/originalAgentPermissionMode";

/** Mode-specific instructions for the main agent model. Pure; no preference reads. */
export function buildPermissionModeGuidance(
  mode: OriginalAgentPermissionMode,
  assumptions: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  if (mode === "safe") {
    lines.push(
      "Permission mode: safe. Every external write is shown to the user for review before it runs, including new-note creation. Call the concrete tool; the host owns the review UI.",
    );
  } else if (mode === "auto") {
    lines.push(
      "Permission mode: auto. Routine reversible edits in this chat's Zotero library may run directly. Cross-library, destructive, exclusive-replacement, unresolved-scope, sensitive-egress, and out-of-root effects are reviewed by the host. Use request_user_input only for genuine ambiguity that reading or bounded search cannot resolve.",
    );
  } else {
    lines.push(
      "Permission mode: yolo. The user delegated judgment. Do not ask for confirmation or clarification; decide, act, and state your assumptions and any own-initiative changes in your reply. Actions beyond the literal request are authorized except explicit prohibitions, protected targets, chat-only memory, and importing discovered papers without the user's selection. Use request_user_input only when proceeding under any assumption would make the work useless.",
    );
  }
  if (assumptions.length)
    lines.push(
      `Interpretation assumptions: ${assumptions.join(" ")} State them in your reply.`,
    );
  return lines;
}
