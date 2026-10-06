import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDuration, formatSpeed, ThroughputMeter } from "./throughput.ts";

describe("ThroughputMeter", () => {
  it("withholds a rate until there is enough signal", () => {
    const meter = new ThroughputMeter();
    assert.equal(meter.bytesPerSecond, null, "no samples at all");

    meter.sample(0, 0);
    assert.equal(meter.bytesPerSecond, null, "a single sample is not a rate");

    // 500 ms of a burst says nothing; a fast first chunk would imply nonsense.
    meter.sample(1_000_000, 500);
    assert.equal(meter.bytesPerSecond, null);
  });

  it("reports bytes per second over the window", () => {
    const meter = new ThroughputMeter();
    meter.sample(0, 0);
    meter.sample(1_000_000, 1000);
    assert.equal(meter.bytesPerSecond, 1_000_000);
  });

  it("ignores a repeat of the same byte count", () => {
    const meter = new ThroughputMeter();
    meter.sample(0, 0);
    meter.sample(1000, 1000);
    assert.equal(meter.bytesPerSecond, 1000);

    // A stall: the byte count does not move. Counting the elapsed time would
    // halve the rate and make a healthy transfer look like it is dying.
    meter.sample(1000, 2000);
    assert.equal(meter.bytesPerSecond, 1000);
  });

  it("lets old samples fall out so the rate follows a slow-down", () => {
    const meter = new ThroughputMeter();
    meter.sample(0, 0);
    meter.sample(1_000_000, 1000);
    assert.equal(meter.bytesPerSecond, 1_000_000);

    // Only 10 KB moved across the last three seconds; the fast start must not
    // keep propping the estimate up.
    meter.sample(1_010_000, 4000);
    const rate = meter.bytesPerSecond;
    assert.notEqual(rate, null);
    assert.ok(rate! < 4000, `expected the slow rate to win, got ${rate}`);
  });

  it("estimates what is left", () => {
    const meter = new ThroughputMeter();
    assert.equal(meter.remainingMs(1_000_000), null, "no rate to divide by yet");

    meter.sample(0, 0);
    meter.sample(500_000, 1000); // 500 KB/s
    assert.equal(meter.remainingMs(1_000_000), 1000);
    assert.equal(meter.remainingMs(500_000), 0, "already finished");
    assert.equal(meter.remainingMs(1_000_000_000_000), null, "estimate too far out to mean anything");
  });

  it("forgets everything on reset", () => {
    const meter = new ThroughputMeter();
    meter.sample(0, 0);
    meter.sample(1000, 1000);
    assert.notEqual(meter.bytesPerSecond, null);

    meter.reset();
    assert.equal(meter.bytesPerSecond, null);
    assert.equal(meter.remainingMs(1000), null);
  });
});

describe("formatSpeed", () => {
  it("reuses the shared byte units", () => {
    assert.equal(formatSpeed(1_048_576), "1.00 MB/s");
    assert.equal(formatSpeed(1024), "1.0 KB/s");
  });
});

describe("formatDuration", () => {
  it("never reads as zero", () => {
    assert.equal(formatDuration(0), "1s");
    assert.equal(formatDuration(200), "1s");
  });

  it("uses the largest useful unit", () => {
    assert.equal(formatDuration(45_000), "45s");
    assert.equal(formatDuration(60_000), "1m");
    assert.equal(formatDuration(72_000), "1m 12s");
    assert.equal(formatDuration(3_600_000), "1h");
    assert.equal(formatDuration(7_500_000), "2h 5m");
  });
});
