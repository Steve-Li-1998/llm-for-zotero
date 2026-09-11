/**
 * Permission mode for the in-plugin Original Agent.
 *
 * Unlike the legacy library-write preference, this mode governs every
 * Original Agent capability: Zotero mutations, local files, commands,
 * privileged scripts, and agent-controlled network access.
 * Claude Code and Codex retain their own independent native profiles.
 */
export type OriginalAgentPermissionMode = "auto" | "safe" | "yolo";

export function normalizeOriginalAgentPermissionMode(
  value: unknown,
): OriginalAgentPermissionMode {
  if (value === "yolo") return "yolo";
  if (value === "safe") return "safe";
  return "auto";
}

export function getOriginalAgentPermissionModeDescription(): string {
  return "safe reviews every external write, including new-note creation. auto runs routine reversible changes in this chat's library and exports inside configured directories, while reviewing cross-library, destructive, ambiguous, and out-of-scope effects. yolo lets the Original Agent act on its own judgment within configured access and host integrity checks. Protected targets, database integrity, Plan integrity, chat-only memory, the paper selection card before importing discovered papers, and the change journal remain enforced in every mode. Claude Code, Codex, and external MCP callers keep their own permission controls.";
}
