import type {
  ActionConstraint,
  ActionDomain,
  ActionEffect,
  ActionMechanism,
  ActionProposal,
  AuthorizationDecision,
  OriginalAuthorizationContext,
} from "./types";

function constraint(
  effects: ActionEffect[],
  domains: ActionDomain[],
  description: string,
): Extract<ActionConstraint, { kind: "deny_effects" }> {
  return { kind: "deny_effects", effects, domains, description };
}

function mechanismConstraint(
  mechanisms: Exclude<ActionMechanism, "none">[],
  description: string,
): ActionConstraint {
  return { kind: "deny_mechanisms", mechanisms, description };
}

export function proposalViolatesConstraints(
  proposal: Pick<
    ActionProposal,
    "operation" | "domains" | "effects" | "invocationPlan"
  >,
  constraints: readonly ActionConstraint[],
): ActionConstraint | null {
  return (
    constraints.find((constraint) => {
      if (constraint.kind === "deny_mechanisms") {
        return (
          proposal.invocationPlan.mechanism !== "none" &&
          constraint.mechanisms.includes(proposal.invocationPlan.mechanism)
        );
      }
      if (
        constraint.operations?.length &&
        proposal.invocationPlan.mechanism === "none" &&
        proposal.invocationPlan.assurance === "runtime_enforced" &&
        !proposal.operation
          .split("+")
          .some((operation) => constraint.operations!.includes(operation))
      )
        return false;
      if (
        constraint.exceptOperations?.includes(proposal.operation) &&
        proposal.invocationPlan.mechanism === "none" &&
        proposal.invocationPlan.assurance === "runtime_enforced"
      )
        return false;
      return (
        proposal.domains.some((domain) =>
          constraint.domains.includes(domain),
        ) &&
        proposal.effects.some((effect) => constraint.effects.includes(effect))
      );
    }) || null
  );
}

export function normalizeStoredActionConstraints(
  constraints:
    | readonly (ActionConstraint | { kind: "no_write"; description: string })[]
    | undefined,
): ActionConstraint[] {
  return (constraints || []).flatMap((entry) => {
    if (entry.kind === "deny_mechanisms") return [entry];
    if (entry.kind === "deny_effects") {
      const executeDenied = entry.effects.includes("execute");
      const effects = entry.effects.filter((effect) => effect !== "execute");
      return [
        ...(effects.length ? [{ ...entry, effects }] : []),
        ...(executeDenied
          ? [mechanismConstraint(["shell", "zotero_script"], entry.description)]
          : []),
      ];
    }
    return [
      constraint(
        ["create", "modify", "delete"],
        [
          "zotero_library",
          "filesystem",
          "local_execution",
          "privileged_zotero",
        ],
        entry.description,
      ),
      mechanismConstraint(["shell", "zotero_script"], entry.description),
    ];
  });
}

export function authorizeOriginalAction(
  proposal: ActionProposal,
  context: OriginalAuthorizationContext,
): AuthorizationDecision {
  const violation = proposalViolatesConstraints(
    proposal,
    context.constraints || [],
  );
  if (violation) {
    return {
      kind: "block",
      reason: violation.description,
    };
  }
  const integrityFailure = actionIntegrityFailure(proposal);
  if (integrityFailure) return integrityFailure;
  const trustedRead =
    proposal.invocationPlan.impact === "read_only" &&
    proposal.invocationPlan.assurance !== "unknown";
  if (trustedRead) {
    return { kind: "execute", authority: "safe_read" };
  }
  // Stored classifier-era workflows retain their selection gate while fresh
  // direct-agent turns no longer create or consume semantic authority.
  if (
    context.semantic?.conversationOnly &&
    (proposal.capabilities.includes("zotero.notes") ||
      proposal.capabilities.includes("file.write"))
  ) {
    return {
      kind: "block",
      reason:
        "Remember this within the conversation only. The stored workflow does not permit a saved note or file.",
    };
  }
  if (
    context.semantic &&
    proposal.capabilities.includes("zotero.import") &&
    (context.semantic.literature === "discover" ||
      context.semantic.literature === "select_then_import")
  ) {
    return {
      kind: "block",
      reason:
        "Paper discovery requires user selection. Call literature_review with the ranked candidates before importing the approved selection.",
    };
  }
  const chatLibraryID = context.executionContext?.chatLibraryID;
  const isLibraryWrite =
    proposal.domains.includes("zotero_library") &&
    proposal.effects.some((effect) => effect !== "read");
  if (context.executionContext && isLibraryWrite && !chatLibraryID) {
    return {
      kind: "block",
      reason:
        "The chat library is unresolved. Resolve and freeze its native identity before changing Zotero state.",
    };
  }
  if (
    context.interaction?.entryPoint === "action_ui" ||
    context.interaction?.reviewPreference === "review"
  ) {
    return {
      kind: "confirm",
      reason: "Review the prepared changes before applying them, as requested.",
    };
  }
  if (context.hasApprovedPlanAuthority) {
    return { kind: "execute", authority: "plan_approval" };
  }
  if (context.mode === "safe") {
    return {
      kind: "confirm",
      reason: "Safe mode reviews every external write before it runs.",
    };
  }
  const crossesChatLibrary = Boolean(
    chatLibraryID &&
    (proposal.targetLibraryIDs || []).some(
      (libraryID) => libraryID !== chatLibraryID,
    ),
  );
  const writesOutsideConfiguredRoots =
    proposal.domains.includes("filesystem") &&
    proposal.effects.some((effect) => effect !== "read") &&
    !proposal.targets.every((target) =>
      isWithinConfiguredRoot(
        target,
        context.executionContext?.configuredAccess.outputDirectories || [],
      ),
    );
  const exceptionalDanger = proposal.riskSignals.some((signal) =>
    [
      "ambiguous_target",
      "scope_expansion",
      "exclusive_replacement",
      "sensitive_egress",
      "broad_delete",
      "privilege_escalation",
      "package_system_modification",
      "download_to_shell",
    ].includes(signal),
  );
  const destructive = proposal.effects.includes("delete");
  const uncertain =
    proposal.invocationPlan.impact === "ambiguous" ||
    proposal.invocationPlan.assurance === "unknown";
  if (context.mode === "yolo") {
    if (crossesChatLibrary || writesOutsideConfiguredRoots) {
      return {
        kind: "confirm",
        reason:
          "The proposal crosses the configured library or filesystem boundary and requires review.",
      };
    }
    return {
      kind: "execute",
      authority: "yolo_judgment",
    };
  }
  if (
    exceptionalDanger ||
    destructive ||
    uncertain ||
    crossesChatLibrary ||
    writesOutsideConfiguredRoots
  ) {
    return {
      kind: "confirm",
      reason:
        "Auto mode found genuine ambiguity or exceptional danger in the exact action.",
    };
  }
  return { kind: "execute", authority: "auto_policy" };
}

function normalizedPathSegments(value: string): string[] | null {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    !normalized ||
    (!normalized.startsWith("/") && !/^[a-z]:\//i.test(normalized))
  )
    return null;
  const prefix = /^[a-z]:\//i.test(normalized)
    ? normalized.slice(0, 2).toLowerCase()
    : "/";
  const segments: string[] = [prefix];
  for (const part of normalized.replace(/^[a-z]:|^\//i, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 1) return null;
      segments.pop();
    } else segments.push(part);
  }
  return segments;
}

function isWithinConfiguredRoot(
  target: string,
  roots: readonly string[],
): boolean {
  const targetSegments = normalizedPathSegments(target);
  if (!targetSegments) return false;
  return roots.some((root) => {
    const rootSegments = normalizedPathSegments(root);
    return Boolean(
      rootSegments &&
      rootSegments.length <= targetSegments.length &&
      rootSegments.every((part, index) => part === targetSegments[index]),
    );
  });
}

/** Execution integrity applies independently of which agent owns permission. */
export function actionIntegrityFailure(
  proposal: ActionProposal,
): AuthorizationDecision | null {
  if (
    proposal.invocationPlan.impact === "prohibited" ||
    proposal.riskSignals.includes("protected_target") ||
    proposal.riskSignals.includes("raw_database") ||
    proposal.riskSignals.includes("authorization_tampering")
  ) {
    return {
      kind: "block",
      reason: "The proposed action targets a protected integrity boundary.",
    };
  }
  return null;
}

export function authorizeExternalAction(
  proposal: ActionProposal,
): AuthorizationDecision {
  return (
    actionIntegrityFailure(proposal) || {
      kind: "execute",
      authority: "external_runtime",
    }
  );
}
