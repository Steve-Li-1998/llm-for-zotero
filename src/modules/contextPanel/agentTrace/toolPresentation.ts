import { getAgentRuntime } from "../../../agent";
import type { AgentToolPresentation } from "../../../agent/types";

/**
 * How the trace asks a tool how to present itself.
 *
 * The lookup is by tool name, and the name is used as identity and nothing
 * else: the renderer never asks "is this tool called X" to decide what a row
 * means. Everything a row says comes either from the event that produced it
 * or from the hooks this returns, which the tool that ran wrote itself.
 *
 * A name the registry does not know -- a tool since renamed or removed, or a
 * connected client's own built-in -- resolves to nothing, and every caller
 * falls back to what the event alone says.
 */
export type AgentToolPresentationResolver = (
  name: string,
) => AgentToolPresentation | undefined;

let resolverOverride: AgentToolPresentationResolver | null = null;

export function resolveAgentToolPresentation(
  name: string,
): AgentToolPresentation | undefined {
  if (resolverOverride) return resolverOverride(name);
  try {
    return getAgentRuntime().getToolDefinition(name)?.presentation;
  } catch {
    return undefined;
  }
}

/**
 * Answer presentation lookups from a caller-supplied registry.
 *
 * The live registry needs the whole agent subsystem behind it, which a unit
 * test has no way to stand up, so a test installs the specs it is asserting
 * about. Pass `null` to go back to the running registry.
 */
export function setAgentToolPresentationResolverForTests(
  resolver: AgentToolPresentationResolver | null,
): void {
  resolverOverride = resolver;
}
