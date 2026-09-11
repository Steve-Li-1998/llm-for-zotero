import { assert } from "chai";
import {
  buildInterruptedRunRecoveryMessage,
  buildTranscriptUserMessage,
  isCurrentTurnUserTranscriptMessage,
  isManualCompactRequest,
  readLatestTranscriptGoal,
} from "../src/agent/execution/transcriptRecovery";

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
});
