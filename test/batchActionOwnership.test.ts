import { assert } from "chai";
import {
  getActiveMutationActionId,
  withActiveMutationAction,
} from "../src/services/mutationActionContext";

/** Fail fast instead of hanging mocha when the native write queue deadlocks. */
async function withDeadline<T>(work: Promise<T>, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), 100);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("native mutation window ownership", function () {
  it("runs a nested acquire by the owning action inline", async function () {
    const order: string[] = [];
    const composite = withActiveMutationAction("action-owner", async () => {
      order.push("outer-start");
      await withActiveMutationAction("action-owner", async () => {
        order.push(`inner:${getActiveMutationActionId()}`);
      });
      order.push("outer-end");
    });

    await withDeadline(
      composite,
      "a nested acquire by the owning action deadlocked",
    );

    assert.deepEqual(order, ["outer-start", "inner:action-owner", "outer-end"]);
  });

  it("still serializes an acquire from a different owner", async function () {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withActiveMutationAction("action-first", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = withActiveMutationAction("action-second", async () => {
      order.push("second");
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ["first-start"]);

    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  });

  it("does not treat an unowned acquire as reentrant", async function () {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withActiveMutationAction(null, async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = withActiveMutationAction(null, async () => {
      order.push("second");
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ["first-start"]);

    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  });
});
