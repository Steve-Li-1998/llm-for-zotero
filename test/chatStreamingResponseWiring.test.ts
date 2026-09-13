import { assert } from "chai";
import { describe, it } from "mocha";
import { readFileSync } from "node:fs";

import {
  createBlockStreamCoalescer,
  type BlockStreamFlushReason,
} from "../src/modules/contextPanel/blockStreamCoalescer";
import { sanitizeText } from "../src/utils/textSanitization";

/**
 * Characterization for the streaming-response wiring the retry flow
 * (`retryLatestAssistantResponse`) and the send flow (`sendQuestion`) carry in
 * duplicate: buffer the model's deltas, append each released block to the
 * assistant message, repaint the bubble once per block, flush with a reason at
 * the end of the turn, and hand the still-unflushed text back when the turn is
 * interrupted.
 *
 * The two flows are not drivable from the unit suite — each needs a live panel,
 * a Zotero item, a conversation store and a provider. So this file pins the
 * behaviour at two levels:
 *
 *  - *Streaming behaviour*: the coalescer wired exactly as both flows wire it
 *    (`onBlock` appends to the message and calls the queued refresh; deltas go
 *    through `sanitizeText`). Whatever owns this wiring must keep these
 *    answers; `test/streamingResponse.test.ts` re-asserts the same list against
 *    the extracted owner.
 *  - *Flow order*: source pins over each flow's slice of `chat.ts`, written so
 *    they do not name the receiver — they hold both while the wiring is inline
 *    and after it moves behind an owner.
 */

const CHAT_SOURCE_PATH = "src/modules/contextPanel/chat.ts";

/** A flush of the streaming response, whatever object owns it today. */
const FLUSH_CALL = (reason: BlockStreamFlushReason) =>
  new RegExp(`(?:flushResponseStream|\\w+\\.flush)\\("${reason}"\\)`);
/** Reading everything the model streamed, flushed or not. */
const READ_STREAMED_TEXT = /\.(?:getFullText|getStreamedText)\(\)/;
/** Dropping the buffer and refusing later deltas. */
const DISCARD_STREAM = /\.(?:cancel|dispose|rollback)\(\)/;
/** Constructing the per-turn streaming response. */
const CREATE_STREAM =
  /create(?:BlockStreamCoalescer|StreamingResponse)(?:Owner)?\(/;

function readChatSource(): string {
  return readFileSync(CHAT_SOURCE_PATH, "utf8");
}

function sliceBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  assert.isAtLeast(start, 0, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.isAtLeast(end, 0, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

function retryFlowSource(source: string): string {
  return sliceBetween(
    source,
    "export async function retryLatestAssistantResponse(",
    "async function detachProviderForEdit(",
  );
}

function sendFlowSource(source: string): string {
  return sliceBetween(
    source,
    "export async function sendQuestion(",
    "function buildInlineEditWidget(",
  );
}

function matchIndex(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

/**
 * The wiring both flows repeat today: a coalescer whose released blocks are
 * appended to the streaming assistant message and repainted, fed by a delta
 * handler that sanitizes first and drops anything left empty.
 */
function wireStreamingResponseLikeChatFlow() {
  const message = { text: "" };
  const refreshes: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;

  const coalescer = createBlockStreamCoalescer({
    onBlock: (chunk) => {
      message.text += chunk;
      refreshes.push(chunk);
    },
    setTimer: (callback, _delayMs) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (timer) => {
      timers.delete(timer as number);
    },
  });

  return {
    message,
    refreshes,
    /** The flows' `handleDelta`. */
    push(delta: string) {
      const chunk = sanitizeText(delta);
      if (!chunk) return;
      coalescer.pushText(chunk);
    },
    /** The flows' `flushResponseStream`. */
    flush(reason: BlockStreamFlushReason) {
      coalescer.flushNow(reason);
    },
    /** The flows' error-path partial text. */
    partialText() {
      return sanitizeText(coalescer.getFullText() || message.text || "");
    },
    discard() {
      coalescer.cancel();
    },
    fireTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
    pendingTimerCount() {
      return timers.size;
    },
  };
}

const PARAGRAPH = `${"word ".repeat(40)}\n\n`;

describe("chat streaming-response wiring (characterization)", function () {
  describe("streaming behaviour both flows depend on", function () {
    it("buffers a short delta instead of repainting per token", function () {
      const stream = wireStreamingResponseLikeChatFlow();

      stream.push("Hello");

      assert.equal(stream.message.text, "");
      assert.deepEqual(stream.refreshes, []);
      assert.equal(stream.partialText(), "Hello");
    });

    it("releases one block, and one repaint, at a markdown block boundary", function () {
      const stream = wireStreamingResponseLikeChatFlow();

      stream.push(PARAGRAPH);

      assert.equal(stream.message.text, PARAGRAPH);
      assert.equal(stream.refreshes.length, 1);
    });

    it("releases at the hard cap even without a boundary", function () {
      const stream = wireStreamingResponseLikeChatFlow();
      const unbroken = "x".repeat(800);

      stream.push(unbroken);

      assert.equal(stream.message.text, unbroken);
      assert.equal(stream.refreshes.length, 1);
    });

    it("releases a stalled buffer on its timer", function () {
      const stream = wireStreamingResponseLikeChatFlow();

      stream.push("Hello");
      assert.equal(stream.message.text, "");
      assert.equal(stream.pendingTimerCount(), 1);

      stream.fireTimers();

      assert.equal(stream.message.text, "Hello");
      assert.equal(stream.refreshes.length, 1);
    });

    it("drops a delta that sanitizes to nothing", function () {
      const stream = wireStreamingResponseLikeChatFlow();

      stream.push("");
      stream.push("\u0000\u0001");

      assert.equal(stream.partialText(), "");
      assert.equal(stream.pendingTimerCount(), 0);
    });

    it("releases the tail on the final flush and stays quiet on a second one", function () {
      const stream = wireStreamingResponseLikeChatFlow();

      stream.push("tail");
      stream.flush("final");
      assert.equal(stream.message.text, "tail");
      assert.equal(stream.refreshes.length, 1);

      stream.flush("final");
      assert.equal(stream.message.text, "tail");
      assert.equal(stream.refreshes.length, 1);
    });

    it("releases the buffered tail on the cancel flush, before the store write", function () {
      const stream = wireStreamingResponseLikeChatFlow();

      stream.push("half an answer");
      stream.flush("cancel");

      assert.equal(stream.message.text, "half an answer");
      assert.equal(stream.refreshes.length, 1);
    });

    it("releases the buffered tail on an event flush", function () {
      const stream = wireStreamingResponseLikeChatFlow();

      stream.push("before reasoning");
      stream.flush("event");

      assert.equal(stream.message.text, "before reasoning");
      assert.equal(stream.refreshes.length, 1);
    });

    it("keeps the unflushed tail in the interruption text", function () {
      const stream = wireStreamingResponseLikeChatFlow();

      stream.push(PARAGRAPH);
      stream.push("not yet flushed");

      assert.equal(stream.message.text, PARAGRAPH);
      assert.equal(stream.partialText(), `${PARAGRAPH}not yet flushed`);
    });

    it("discards the buffer and ignores later deltas once the stream is dropped", function () {
      const stream = wireStreamingResponseLikeChatFlow();

      stream.push(PARAGRAPH);
      stream.push("pending");
      const partial = stream.partialText();
      stream.discard();
      stream.push("after the drop");
      stream.flush("final");

      assert.equal(partial, `${PARAGRAPH}pending`);
      assert.equal(stream.message.text, PARAGRAPH);
      assert.equal(stream.refreshes.length, 1);
      assert.equal(stream.pendingTimerCount(), 0);
    });

    it("repaints once per released block, not once per delta", function () {
      const stream = wireStreamingResponseLikeChatFlow();

      for (let index = 0; index < 8; index += 1) stream.push("word ");
      assert.deepEqual(stream.refreshes, []);

      stream.push(PARAGRAPH);
      stream.push(PARAGRAPH);

      assert.equal(stream.refreshes.length, 2);
    });
  });

  describe("flow order", function () {
    it("wires a streaming response in both the retry and the send flow", function () {
      const source = readChatSource();

      assert.match(retryFlowSource(source), CREATE_STREAM);
      assert.match(sendFlowSource(source), CREATE_STREAM);
    });

    it("hands the streaming repaint to the native trace controller in both flows", function () {
      const source = readChatSource();
      const wiring =
        "createCodexNativeActivityTraceController(assistantMessage, queueRefresh)";

      assert.include(retryFlowSource(source), wiring);
      assert.include(sendFlowSource(source), wiring);
    });

    it("flushes the streamed text before the cancelled turn is finalized", function () {
      const source = readChatSource();

      for (const flow of [retryFlowSource(source), sendFlowSource(source)]) {
        const flush = matchIndex(flow, FLUSH_CALL("cancel"));
        const traceFlush = flow.indexOf('flushBufferedProgress("cancel")');
        const finalize = flow.indexOf("finalizeCancelledAssistantMessage(");

        assert.isAtLeast(flush, 0);
        assert.isAtLeast(traceFlush, 0);
        assert.isAtLeast(finalize, 0);
        assert.isBelow(flush, traceFlush);
        assert.isBelow(traceFlush, finalize);
      }
    });

    it("flushes the streamed text before the completed turn is written", function () {
      const source = readChatSource();

      for (const flow of [retryFlowSource(source), sendFlowSource(source)]) {
        const flush = matchIndex(flow, FLUSH_CALL("final"));
        const completion = flow.indexOf(
          "assistantMessage.completionStatus = modelOutcome.completion.status;",
        );

        assert.isAtLeast(flush, 0);
        assert.isAtLeast(completion, 0);
        assert.isBelow(flush, completion);
      }
    });

    it("reads the streamed text before discarding it on the error path", function () {
      const source = readChatSource();

      for (const flow of [retryFlowSource(source), sendFlowSource(source)]) {
        const catchBlock = flow.slice(flow.indexOf("const partialText ="));
        const read = matchIndex(catchBlock, READ_STREAMED_TEXT);
        const discard = matchIndex(catchBlock, DISCARD_STREAM);

        assert.isAtLeast(read, 0);
        assert.isAtLeast(discard, 0);
        assert.isBelow(read, discard);
      }
    });

    it("drops the retry stream before the original turn is restored", function () {
      const source = readChatSource();
      const restore = sliceBetween(
        retryFlowSource(source),
        "const restoreOriginalTurn = () => {",
        "const stopRetryPreparation = () => {",
      );

      const discard = matchIndex(restore, DISCARD_STREAM);
      const snapshot = restore.indexOf("restoreAssistantSnapshot(");

      assert.isAtLeast(discard, 0);
      assert.isAtLeast(snapshot, 0);
      assert.isBelow(discard, snapshot);
    });
  });
});
