import type { AgentActionSummaryResultCard } from "../../../agent/types";
import { createDocumentCardLayout } from "../documentCard";

// The projection that builds the card lives in `actionCardModel`; this module
// draws what it produced. Callers keep importing the builder from here until
// the panel is rewired to the model directly.
export { buildAgentActionSummaryCard } from "./actionCardModel";

/** One receipt's line: what it did, and what its proof was worth. */
function renderActionSummaryEntry(
  doc: Document,
  entry: AgentActionSummaryResultCard["entries"][number],
): HTMLElement {
  const row = doc.createElement("li");
  row.className = "llm-agent-action-summary-item";
  const text = doc.createElement("span");
  text.className = "llm-agent-action-summary-text";
  // Temporary bridge: the row's operations, in the order the receipts ran.
  // The chip layout that replaces it is the card renderer's own task.
  text.textContent = entry.effects.map((effect) => effect.label).join(", ");
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
    status: `${card.actionCount} action${card.actionCount === 1 ? "" : "s"}`,
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
