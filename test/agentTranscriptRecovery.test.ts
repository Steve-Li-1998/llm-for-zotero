import { assert } from "chai";
import {
  buildFinalizedMaterialRecoveryMessage,
  buildInterruptedRunRecoveryMessage,
  buildTranscriptUserMessage,
  isCurrentTurnUserTranscriptMessage,
  isManualCompactRequest,
  readLatestTranscriptGoal,
} from "../src/agent/execution/transcriptRecovery";
import type { MaterialOutcomeEntry } from "../src/agent/execution/materialOutcomes";

const unsavedMaterial: MaterialOutcomeEntry = {
  materialRef: {
    documentId: "run-1:document:1",
    documentVersion: 1,
    contentHash: "sha256:guide",
  },
  materialKind: "guide",
  materialTitle: "Representational drift",
  runId: "run-1",
  status: "finalized",
};

describe("Agent transcript recovery", function () {
  const request = {
    userText: "  Summarize   this paper  ",
  } as never;

  it("recognizes manual compaction without changing ordinary requests", function () {
    assert.isTrue(
      isManualCompactRequest({ userText: "/compact now" } as never),
    );
    assert.isFalse(isManualCompactRequest(request));
  });

  it("uses one normalized user goal for transcript deduplication and recovery", function () {
    const message = buildTranscriptUserMessage(request);
    assert.isTrue(isCurrentTurnUserTranscriptMessage(message, request));
    assert.equal(readLatestTranscriptGoal([message]), "Summarize this paper");
  });

  it("summarizes durable journal outcomes without instructing a repeated write", function () {
    const message = buildInterruptedRunRecoveryMessage({
      run: { runId: "run-1" } as never,
      priorGoal: "Save a note",
      actions: [
        {
          actionId: "action-1",
          status: "verified",
          createdAt: 2,
          affectedCount: 1,
          reversibility: "reversible",
        } as never,
      ],
    });
    assert.equal(message.role, "user");
    assert.include(
      String(message.content),
      "Do not automatically repeat any prior write.",
    );
    assert.include(
      String(message.content),
      "actionId=action-1; status=verified",
    );
  });

  it("names finalized-but-unsaved material in the interrupted-run recovery note", function () {
    const message = buildInterruptedRunRecoveryMessage({
      run: { runId: "run-2" } as never,
      actions: [],
      materialOutcomes: [unsavedMaterial],
    });
    const content = String(message.content);
    assert.include(content, "Finalized material not yet saved:");
    assert.include(
      content,
      'documentId=run-1:document:1 version=1 hash=sha256:guide title="Representational drift" status=finalized',
    );
    assert.include(
      content,
      "To save it, call note_write with that documentId; do not regenerate it.",
    );
  });

  it("builds a standalone host message for an uninterrupted next turn", function () {
    const message = buildFinalizedMaterialRecoveryMessage([unsavedMaterial]);
    assert.exists(message);
    assert.equal(message?.role, "user");
    assert.include(String(message?.content), "documentId=run-1:document:1");
    assert.isNull(buildFinalizedMaterialRecoveryMessage([]));
    assert.isNull(
      buildFinalizedMaterialRecoveryMessage([
        { ...unsavedMaterial, status: "saved" },
      ]),
    );
  });
});
