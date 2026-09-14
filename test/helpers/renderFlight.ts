import { createBlockStreamCoalescer } from "../../src/modules/contextPanel/blockStreamCoalescer";
import { sanitizeText } from "../../src/utils/textSanitization";
import type { BlockStreamFlushReason } from "../../src/modules/contextPanel/blockStreamCoalescer";
import type { RenderFlightRun } from "../../src/agent/flightMetrics";

/**
 * The rig behind the render flight numbers.
 *
 * `src/modules/contextPanel/streamingResponse.ts` is the owner of a streamed
 * turn, and it builds its coalescer with one option -- `onBlock` -- so it has
 * no seam through which a test can hold the 450 ms stall timer still. Adding
 * one would be a production change, which this phase does not make. So this rig
 * builds the coalescer the owner builds, with the owner's own options and the
 * owner's own two lines of `onBlock` body (append the block to the message,
 * then ask for one repaint), and injects only the timer seam the coalescer
 * already offers.
 *
 * `test/renderFlightMetrics.test.ts` checks the rig against the real owner at
 * every delta size, so a drift between this copy and the owner fails a test
 * rather than quietly moving a baseline.
 */

/** The fixed transcript length every run pushes, in characters. */
export const RENDER_TRANSCRIPT_CHARS = 2000;

/** One sentence of the synthetic answer; deliberately dull and repeatable. */
const SENTENCE =
  "A streamed answer reaches the panel as many small deltas, not as blocks. ";

/** Four sentences and a blank line: one paragraph the coalescer can end on. */
const PARAGRAPH = `${SENTENCE.repeat(4).trimEnd()}\n\n`;

/**
 * The transcript, built rather than pasted so it is exactly as long as it says
 * and identical on every machine.
 */
export function buildRenderTranscript(
  totalChars: number = RENDER_TRANSCRIPT_CHARS,
): string {
  let text = "";
  while (text.length < totalChars) text += PARAGRAPH;
  return text.slice(0, totalChars);
}

export type RenderFlightDriveOptions = {
  /** The name this run is pinned under. */
  id: string;
  /** How many characters the provider hands over at a time. */
  deltaChars: number;
  /** Defaults to the fixed 2,000-character transcript. */
  transcript?: string;
  /**
   * Fires the stalled-stream timer after every delta: the worst case, where no
   * natural boundary ever arrives before the coalescer gives up waiting.
   */
  fireStallTimer?: boolean;
};

export type RenderFlightDriveResult = {
  run: RenderFlightRun;
  /** What the message bubble holds once the turn ends. */
  text: string;
  /** Why each block was released, in order. */
  reasons: BlockStreamFlushReason[];
};

/** Pushes one transcript through one coalescer and counts what it cost. */
export function driveRenderFlight(
  options: RenderFlightDriveOptions,
): RenderFlightDriveResult {
  const transcript = options.transcript ?? buildRenderTranscript();
  const message = { text: "" };
  const reasons: BlockStreamFlushReason[] = [];
  let refreshesScheduled = 0;
  let blocksReleased = 0;
  let stallTimer: (() => void) | null = null;

  /** Stands in for the panel's frame-coalesced refresh; counts, paints nothing. */
  const queueRefresh = () => {
    refreshesScheduled += 1;
  };

  const coalescer = createBlockStreamCoalescer({
    onBlock: (chunk, reason) => {
      message.text += chunk;
      queueRefresh();
      blocksReleased += 1;
      reasons.push(reason);
    },
    setTimer: (callback) => {
      stallTimer = callback;
      return "stall-timer";
    },
    clearTimer: () => {
      stallTimer = null;
    },
  });

  let deltas = 0;
  let charsPushed = 0;
  for (let at = 0; at < transcript.length; at += options.deltaChars) {
    const delta = sanitizeText(transcript.slice(at, at + options.deltaChars));
    if (!delta) continue;
    deltas += 1;
    charsPushed += delta.length;
    coalescer.pushText(delta);
    if (options.fireStallTimer) {
      const fire: (() => void) | null = stallTimer;
      stallTimer = null;
      fire?.();
    }
  }
  coalescer.flushNow("final");

  return {
    run: {
      id: options.id,
      deltaChars: options.deltaChars,
      deltas,
      charsPushed,
      blocksReleased,
      refreshesScheduled,
      stallTimerFires: Boolean(options.fireStallTimer),
    },
    text: message.text,
    reasons,
  };
}

/**
 * The four runs the render baseline pins: the fixed transcript at three delta
 * sizes, plus the same 16-character stream stalling before every delta.
 */
export function measureRenderFlight(): RenderFlightRun[] {
  const transcript = buildRenderTranscript();
  return [
    driveRenderFlight({ id: "delta1", deltaChars: 1, transcript }),
    driveRenderFlight({ id: "delta16", deltaChars: 16, transcript }),
    driveRenderFlight({ id: "delta128", deltaChars: 128, transcript }),
    driveRenderFlight({
      id: "delta16Stalled",
      deltaChars: 16,
      transcript,
      fireStallTimer: true,
    }),
  ].map((driven) => driven.run);
}
