import type { OriginalAgentPermissionMode } from "./originalAgentPermissionMode";
import type { ClaudePermissionMode } from "./claudePermissionMode";

export type PermissionProvider = "original" | "claude" | "codex";

export type PermissionOption = {
  selectionKey: string;
  provider: PermissionProvider;
  fullLabel: string;
  compactLabel: string;
  description: string;
  available: boolean;
  disabledReason?: string;
};

export type CodexPermissionProfile = {
  id: string;
  description: string;
  allowed: boolean;
  disabledReason?: string;
};

const ORIGINAL_OPTIONS: Record<OriginalAgentPermissionMode, PermissionOption> =
  {
    safe: {
      provider: "original",
      selectionKey: "original:safe",
      fullLabel: "Safe",
      compactLabel: "safe",
      description:
        "Every external write, including new-note creation, is shown for review before it runs. Reads do not require review.",
      available: true,
    },
    auto: {
      provider: "original",
      selectionKey: "original:auto",
      fullLabel: "Auto",
      compactLabel: "auto",
      description:
        "Routine reversible changes in this chat's library and exports inside configured directories run without review. Cross-library, destructive, ambiguous, and out-of-scope effects are shown for review.",
      available: true,
    },
    yolo: {
      provider: "original",
      selectionKey: "original:yolo",
      fullLabel: "Yolo",
      compactLabel: "yolo",
      description:
        "The Original Agent acts on its own judgment and may take actions beyond the literal request. Configured access, protected targets, database integrity, Plan integrity, chat-only memory, the paper selection card before importing discovered papers, and the change journal remain enforced. Claude Code, Codex, and external MCP callers keep their own permission controls.",
      available: true,
    },
  };

const CLAUDE_PRESENTATION: Record<
  ClaudePermissionMode,
  Omit<PermissionOption, "provider" | "selectionKey" | "available">
> = {
  plan: {
    fullLabel: "Plan",
    compactLabel: "plan",
    description: "Plan without executing tools that modify the environment.",
  },
  dontAsk: {
    fullLabel: "Don’t ask",
    compactLabel: "no prompts",
    description: "Decline permission prompts instead of asking the user.",
  },
  default: {
    fullLabel: "Default",
    compactLabel: "default",
    description: "Use Claude Code's standard permission behavior.",
  },
  acceptEdits: {
    fullLabel: "Accept edits",
    compactLabel: "edits",
    description:
      "Automatically accept file edits while retaining other prompts.",
  },
  auto: {
    fullLabel: "Auto approval",
    compactLabel: "auto",
    description: "Let Claude Code automatically resolve supported permissions.",
  },
  bypassPermissions: {
    fullLabel: "Bypass permissions",
    compactLabel: "bypass",
    description: "Bypass Claude Code permission checks for this runtime.",
  },
};

export function getOriginalPermissionOptions(): PermissionOption[] {
  return ["safe", "auto", "yolo"].map(
    (id) => ORIGINAL_OPTIONS[id as OriginalAgentPermissionMode],
  );
}

export function getOriginalPermissionModeFromSelectionKey(
  selectionKey: string,
): OriginalAgentPermissionMode | null {
  const mode = selectionKey.replace(/^original:/, "");
  return mode === "safe" || mode === "auto" || mode === "yolo" ? mode : null;
}

export function buildClaudePermissionOption(params: {
  id: ClaudePermissionMode;
  available?: boolean;
  description?: string;
  disabledReason?: string;
}): PermissionOption {
  const presentation = CLAUDE_PRESENTATION[params.id];
  return {
    provider: "claude",
    selectionKey: `claude:${params.id}`,
    ...presentation,
    description: params.description?.trim() || presentation.description,
    available: params.available !== false,
    disabledReason: params.disabledReason,
  };
}

export function getClaudePermissionModeFromSelectionKey(
  selectionKey: string,
): ClaudePermissionMode | null {
  const mode = selectionKey.replace(/^claude:/, "");
  return mode === "default" ||
    mode === "acceptEdits" ||
    mode === "plan" ||
    mode === "auto" ||
    mode === "dontAsk" ||
    mode === "bypassPermissions"
    ? mode
    : null;
}

export function buildPermissionAccessibleLabel(
  option: PermissionOption,
): string {
  const provider =
    option.provider === "claude"
      ? "Claude Code"
      : option.provider === "codex"
        ? "Codex"
        : "Original Agent";
  const description = option.description.trim();
  return `${provider} permission mode: ${option.fullLabel}${description ? ` — ${description}` : ""}`;
}
