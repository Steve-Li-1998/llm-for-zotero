import type {
  AgentRuntimeRequest,
  AgentToolCall,
  AgentToolEffect,
  AgentToolResult,
} from "../types";

const TOOL_RESULT_READ_TOOL_NAME = "tool_result_read";

export function buildSyntheticToolCall(
  name: string,
  args: unknown,
): AgentToolCall {
  return {
    id: `synthetic-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: args,
  };
}

export function readToolError(result: AgentToolResult): string {
  return result.content &&
    typeof result.content === "object" &&
    "error" in result.content
    ? String((result.content as { error: unknown }).error || "")
    : "";
}

export function isUserDeniedToolResult(result: AgentToolResult): boolean {
  return readToolError(result).toLowerCase() === "user denied action";
}

export function setToolResultReadAvailability(
  request: AgentRuntimeRequest,
  available: boolean,
): void {
  const metadata = { ...(request.metadata || {}) };
  if (available) {
    metadata.agentToolResultReadAvailable = true;
  } else {
    delete metadata.agentToolResultReadAvailable;
  }
  request.metadata = metadata;
}

export function filterTransientRecoveryTool<T extends { name: string }>(
  tools: T[],
): T[] {
  return tools.filter((tool) => tool.name !== TOOL_RESULT_READ_TOOL_NAME);
}

function stabilizeProgressValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stabilizeProgressValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) {
      stable[key] = stabilizeProgressValue(record[key]);
    }
  }
  return stable;
}

export function buildToolProgressFingerprint(record: {
  name: string;
  effect?: AgentToolEffect;
  input?: unknown;
  content?: unknown;
}): string {
  try {
    return JSON.stringify(
      stabilizeProgressValue({
        name: record.name,
        effect: record.effect,
        input: record.input,
        content: record.content,
      }),
    );
  } catch {
    return `${record.name}:${String(record.effect || "read")}:${String(
      record.input,
    )}:${String(record.content)}`;
  }
}
