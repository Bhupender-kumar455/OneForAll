import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isExpired, selectExpired } from "./expiry.ts";

const NOW = 1_700_000_000_000;

describe("isExpired", () => {
  it("treats a future deadline as live", () => {
    assert.equal(isExpired({ expiresAt: NOW + 1 }, NOW), false);
  });

  it("treats a past deadline as expired", () => {
    assert.equal(isExpired({ expiresAt: NOW - 1 }, NOW), true);
  });

  it("keeps a deadline that lands exactly on now", () => {
    // Matches `isTransferExpired` (now > expiresAt) used when joining, so the
    // sweeper can never delete a record the join path still accepts.
    assert.equal(isExpired({ expiresAt: NOW }, NOW), false);
  });

  it("treats a missing or unreadable deadline as expired", () => {
    // A half-written record must not linger forever.
    assert.equal(isExpired({}, NOW), true);
    assert.equal(isExpired({ expiresAt: null }, NOW), true);
    assert.equal(isExpired({ expiresAt: Number.NaN }, NOW), true);
    assert.equal(isExpired(null, NOW), true);
  });
});

describe("selectExpired", () => {
  it("returns only the stale ids", () => {
    const records = {
      live1: { expiresAt: NOW + 60_000 },
      dead1: { expiresAt: NOW - 1 },
      live2: { expiresAt: NOW + 1 },
      dead2: { expiresAt: NOW - 60_000 },
    };
    assert.deepEqual(selectExpired(records, NOW).sort(), ["dead1", "dead2"]);
  });

  it("handles an empty or missing node", () => {
    assert.deepEqual(selectExpired({}, NOW), []);
    assert.deepEqual(selectExpired(null, NOW), []);
  });

  it("keeps a live record when its sibling is stale", () => {
    // Guards against the whole node being wiped by an off-by-one.
    const records = { keep: { expiresAt: NOW + 1 }, drop: { expiresAt: NOW - 1 } };
    assert.deepEqual(selectExpired(records, NOW), ["drop"]);
  });
});
