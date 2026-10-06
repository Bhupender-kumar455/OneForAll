import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withTimeout } from "./promise-timeout.ts";

const settle = <T,>(value: T, ms: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe("withTimeout", () => {
  it("passes through a value that arrives in time", async () => {
    assert.equal(await withTimeout(settle("ready", 1), 500, "too slow"), "ready");
  });

  it("rejects with the given message when the work never finishes", async () => {
    // The case that matters: a promise that simply never settles, which is what
    // a stalled socket looks like from the caller's side.
    await assert.rejects(
      () => withTimeout(new Promise<string>(() => {}), 10, "could not reach Firebase"),
      /could not reach Firebase/,
    );
  });

  it("reports the original failure rather than the timeout", async () => {
    await assert.rejects(
      () => withTimeout(Promise.reject(new Error("PERMISSION_DENIED")), 500, "too slow"),
      /PERMISSION_DENIED/,
    );
  });

  it("keeps a late rejection from becoming an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      // Rejects at 40 ms, well after the 10 ms guard has already settled the
      // race: exactly the shape of a request that fails after we gave up.
      const late = new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error("late failure")), 40);
      });
      await assert.rejects(() => withTimeout(late, 10, "too slow"), /too slow/);
      await settle(null, 80);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("does not keep the timer alive once the work is done", async () => {
    // A leaked timer is the difference between a clean exit and a hung test
    // run, so this asserts the cleared-handle behaviour directly.
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await withTimeout(settle("done", 1), 60_000, "never used");
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.ok(after <= before, "the abandoned 60s timer is still pending");
  });
});