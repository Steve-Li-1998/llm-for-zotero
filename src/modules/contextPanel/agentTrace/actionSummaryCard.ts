import type {
  AgentActionSummaryResultCard,
  AgentRunEventRecord,
} from "../../../agent/types";
import type { AgentActionReceipt } from "../../../agent/contracts/types";
import {
  AGENT_ACTION_VERIFICATION_LABELS,
  readAgentActionVerification,
} from "../../../agent/contracts/actionVerificationLabels";
import { operationLabel } from "../../../agent/contracts/operationCatalog";
import { createDocumentCardLayout } from "../documentCard";

/**
 * The statuses that mean the turn did something the reader was promised.
 *
 * They are the same statuses the runtime's action-status block reported to the
 * model, so the card and that block describe one set of effects: work that
 * landed, work that was already true, work that landed for some targets, and
 * an observation a full read journaled. A cancelled or failed action is
 * reported by the row that failed, and claiming it here as an effect would
 * say the opposite of what happened.
 */
const SUMMARIZED_RECEIPT_STATUSES: ReadonlySet<AgentActionReceipt["status"]> =
  new Set(["applied", "already_satisfied", "partial", "observed"]);

/** The wording a connected client's authority carries wherever it is shown. */
const EXTERNAL_AUTHORITY_LABEL = "Authorized by connected client";

/** How many distinct objects a receipt claims to have covered. */
function receiptTargetCount(receipt: AgentActionReceipt): number {
  const requested = receipt.requestedTargets?.length || 0;
  if (requested) return requested;
  return new Set([
    ...(receipt.appliedTargets || []),
    ...(receipt.alreadySatisfiedTargets || []),
  ]).size;
}

/** Every receipt the run journaled, in the order the trace carries them. */
function collectRunReceipts(
  events: readonly AgentRunEventRecord[],
): AgentActionReceipt[] {
  const byId = new Map<string, AgentActionReceipt>();
  for (const entry of events) {
    const payload = entry.payload;
    const receipts =
      payload.type === "tool_result" || payload.type === "codex_tool_activity"
        ? payload.actionReceipts
        : undefined;
    for (const receipt of receipts || []) {
      // One effect reaches the trace through both the tool result and the
      // connected runtime's activity event; the receipt id is its identity.
      if (receipt?.id && !byId.has(receipt.id)) byId.set(receipt.id, receipt);
    }
  }
  return [...byId.values()];
}

/** The material the run's visible answer was rendered from, when it named one. */
function answerMaterialTitle(
  events: readonly AgentRunEventRecord[],
  materialTitle: (documentId: string) => string | undefined,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (payload?.type !== "final") continue;
    const documentId = payload.materialRef?.documentId;
    return documentId ? materialTitle(documentId) : undefined;
  }
  return undefined;
}

/**
 * What the turn did, projected from the receipts the run journaled.
 *
 * The reader used to get this as the `[Action status: …]` block appended to
 * the answer, which was written for the model. The same facts are stated here
 * instead, in the product's own words: the operation's catalog label rather
 * than the name of the tool that ran it, the targets it covered, the material
 * it landed, and the shared verification wording the row chips already use.
 *
 * `materialTitle` resolves a document id against the materials this run
 * finalized, so the card names a document the same way every other row in the
 * trace names it.
 */
export function buildAgentActionSummaryCard(
  events: readonly AgentRunEventRecord[],
  materialTitle: (documentId: string) => string | undefined,
): AgentActionSummaryResultCard | null {
  const entries = collectRunReceipts(events)
    .filter((receipt) => SUMMARIZED_RECEIPT_STATUSES.has(receipt.status))
    .map((receipt) => {
      const title = receipt.materialRef?.documentId
        ? materialTitle(receipt.materialRef.documentId)
        : undefined;
      const targets = receiptTargetCount(receipt);
      const verification = readAgentActionVerification(receipt.verification);
      return {
        receiptId: receipt.id,
        text: [
          operationLabel(receipt.operation),
          title ? ` “${title}”` : "",
          targets ? ` · ${targets} target${targets === 1 ? "" : "s"}` : "",
        ].join(""),
        badges: [
          verification ? AGENT_ACTION_VERIFICATION_LABELS[verification] : "",
          receipt.executionAuthority === "external_runtime"
            ? EXTERNAL_AUTHORITY_LABEL
            : "",
        ].filter(Boolean),
      };
    });
  if (!entries.length) return null;
  return {
    kind: "action_summary",
    answerMaterial: answerMaterialTitle(events, materialTitle),
    entries,
  };
}

/** One receipt's line: what it did, and what its proof was worth. */
function renderActionSummaryEntry(
  doc: Document,
  entry: AgentActionSummaryResultCard["entries"][number],
): HTMLElement {
  const row = doc.createElement("li");
  row.className = "llm-agent-action-summary-item";
  const text = doc.createElement("span");
  text.className = "llm-agent-action-summary-text";
  text.textContent = entry.text;
  row.appendChild(text);
  if (!entry.badges.length) return row;
  // The same chip shape the trace rows use, so one verdict reads the same way
  // wherever the reader meets it.
  const badges = doc.createElement("div");
  badges.className = "llm-agent-process-chips";
  for (const badge of entry.badges) {
    const chip = doc.createElement("div");
    chip.className = "llm-agent-process-chip";
    const label = doc.createElement("span");
    label.className = "llm-agent-process-chip-label";
    label.textContent = badge;
    chip.appendChild(label);
    badges.appendChild(chip);
  }
  row.appendChild(badges);
  return row;
}

/** The run's effects, read-only, closing the trace. */
export function renderActionSummaryCard(
  doc: Document,
  card: AgentActionSummaryResultCard,
): HTMLElement {
  const container = doc.createElement("section");
  container.className = "llm-plan-container llm-agent-action-summary-card";
  const { header } = createDocumentCardLayout(doc, {
    title: "What this turn did",
    status: `${card.entries.length} action${card.entries.length === 1 ? "" : "s"}`,
    statusKind: "completed",
  });
  container.appendChild(header);
  const list = doc.createElement("ul");
  list.className = "llm-agent-action-summary-list";
  for (const entry of card.entries)
    list.appendChild(renderActionSummaryEntry(doc, entry));
  container.appendChild(list);
  if (card.answerMaterial) {
    const source = doc.createElement("div");
    source.className = "llm-agent-action-summary-source";
    source.textContent = `Answer written from “${card.answerMaterial}”`;
    container.appendChild(source);
  }
  return container;
}
