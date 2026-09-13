import { planExecutionCoordinator } from "../plans/coordinator";
import { loadPlanExecutionLedger } from "../plans/store";
import type { PlanExecutionLedger, TaskEvidence } from "../plans/types";
import {
  listPlanDocumentOutboxForConversation,
  loadPlanDocument,
  markPlanDocumentDelivered,
} from "./store";
import type { PlanDocument } from "./types";
import { getPlannedDocumentOrigin } from "./types";
import { buildPlanMaterialEvidence } from "../plans/materialEvidence";
import { notifyDocumentPublication } from "./publicationEvents";
export async function attachPublishedDocumentEvidence(params: {
  document: PlanDocument;
  deliveredAt?: number;
  messageTimestamp?: number;
  alreadyInTransaction?: boolean;
}): Promise<PlanExecutionLedger> {
  const now = params.deliveredAt ?? Date.now();
  const origin = getPlannedDocumentOrigin(params.document);
  if (!origin) {
    throw new Error("Direct documents do not have Plan publication evidence");
  }
  const ledger = await loadPlanExecutionLedger(origin.executionId);
  if (!ledger) throw new Error("Plan execution ledger not found");
  const task = ledger.tasks.find(
    (entry) => entry.taskId === origin.parentTaskId,
  );
  const requirement = task?.completionRequirements?.find(
    (entry) => entry.kind === "document_published",
  );
  if (!task || !requirement) {
    throw new Error("Document publication requirement not found");
  }
  const evidence: TaskEvidence = {
    version: 3,
    evidenceId: `${params.document.documentId}:published`,
    executionId: ledger.executionId,
    taskId: task.taskId,
    kind: "document_published",
    verified: true,
    requirementId: requirement.requirementId,
    criterionIds: requirement.criterionIds,
    contractDigest: requirement.contractDigest,
    payload: {
      type: "document_published",
      documentId: params.document.documentId,
      contentHash: params.document.contentHash,
      messageTimestamp: params.messageTimestamp ?? now,
    },
    reference: params.document.contentHash,
    summary:
      "The exact finalized document was persisted as the visible assistant message",
    createdAt: now,
  };
  return planExecutionCoordinator.attachEvidence(evidence, {
    alreadyInTransaction: params.alreadyInTransaction,
  });
}

/**
 * Completes the durable outbox only after the ordinary conversation store has
 * persisted the exact visible assistant text. Repeated calls are idempotent.
 */
export async function deliverPendingPlanDocumentMessage(params: {
  conversationKey: number;
  visibleMarkdown: string;
  messageTimestamp: number;
  documentId?: string;
}): Promise<PlanDocument | null> {
  const candidates = (
    await listPlanDocumentOutboxForConversation(params.conversationKey)
  ).sort((left, right) => {
    if (params.documentId) return 0;
    const leftTimestamp = Math.abs(
      left.messageTimestamp - params.messageTimestamp,
    );
    const rightTimestamp = Math.abs(
      right.messageTimestamp - params.messageTimestamp,
    );
    return leftTimestamp - rightTimestamp;
  });
  const outbox = candidates.find(
    (entry) =>
      entry.visibleMarkdown === params.visibleMarkdown &&
      (!params.documentId || entry.documentId === params.documentId),
  );
  if (!outbox) return null;
  const document = await loadPlanDocument(outbox.documentId);
  if (
    !document ||
    document.visibleMarkdown !== params.visibleMarkdown ||
    document.visibleMarkdown !== outbox.visibleMarkdown
  ) {
    throw new Error(
      "Pending document does not match the persisted assistant message",
    );
  }
  const origin = getPlannedDocumentOrigin(document);
  if (outbox.status !== "pending" && outbox.status !== "delivered") return null;
  await Zotero.DB.executeTransaction(async () => {
    await markPlanDocumentDelivered({
      documentId: document.documentId,
      deliveredAt: Date.now(),
      messageTimestamp: params.messageTimestamp,
    });
    if (origin) {
      const before = await loadPlanExecutionLedger(origin.executionId);
      const priorTask = before?.tasks.find(
        (entry) => entry.taskId === origin.parentTaskId,
      );
      // A delivered historical document stays readable without mutating a
      // completed or superseded execution. Only recover unfinished publication.
      if (
        outbox.status === "delivered" &&
        (before?.status === "superseded" ||
          !priorTask ||
          !["in_progress", "interrupted"].includes(priorTask.status))
      )
        return;
      await attachPublishedDocumentEvidence({
        document,
        messageTimestamp: params.messageTimestamp,
        alreadyInTransaction: true,
      });
      const ledger = await loadPlanExecutionLedger(origin.executionId);
      const task = ledger?.tasks.find(
        (entry) => entry.taskId === origin.parentTaskId,
      );
      if (task && ["in_progress", "interrupted"].includes(task.status)) {
        // Replay the same verified immutable material, not a newly generated
        // document, when older native runs omitted this evidence at submission.
        const material = buildPlanMaterialEvidence(task, document);
        if (material) {
          if (material.contractDigest !== origin.contractDigest)
            throw new Error(
              "Document material does not match the approved contract",
            );
          await planExecutionCoordinator.attachEvidence(material, {
            alreadyInTransaction: true,
          });
        }
        const current = await loadPlanExecutionLedger(origin.executionId);
        await planExecutionCoordinator.requestTransition(
          {
            executionId: origin.executionId,
            taskId: origin.parentTaskId,
            toStatus: "completed",
            evidenceIds: current!.tasks.find(
              (entry) => entry.taskId === task.taskId,
            )!.evidenceIds,
            requestedBy: "host",
          },
          Date.now(),
          { alreadyInTransaction: true },
        );
      }
    }
  });
  notifyDocumentPublication(document.documentId);
  return document;
}
