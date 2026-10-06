/**
 * Live throughput and time-remaining for a transfer.
 *
 * Both numbers come from a sliding window rather than a running average. A
 * transfer that starts slow and then speeds up has to say so quickly, and an
 * average taken from byte zero would keep reporting the slow start until the
 * file was nearly done. The window also means the estimate is withheld until
 * there is enough signal to be honest: a single chunk arriving in a millisecond
 * implies gigabytes per second, which is not a measurement.
 *
 * `at` is injected rather than read from the clock so the behaviour is
 * deterministic under test.
 */
import { formatBytes } from "../lib/bytes.ts";

/** Samples older than this are dropped, so the rate follows a change quickly. */
const WINDOW_MS = 3_000;

/** Below this span there is not enough signal to estimate from. */
const MIN_SPAN_MS = 750;

/** Past this the estimate is noise — "4 hours" helps nobody — so it is withheld. */
const MAX_ETA_MS = 24 * 60 * 60 * 1000;

type Sample = { at: number; bytes: number };

export class ThroughputMeter {
  private samples: Sample[] = [];

  /** Record the cumulative bytes transferred so far. */
  public sample(bytes: number, at: number = Date.now()): void {
    const last = this.samples.at(-1);
    // A repeat of the same byte count carries no new information, and keeping
    // it would drag the rate down as time passed without progress.
    if (last && bytes <= last.bytes) return;

    this.samples.push({ at, bytes });
    while (this.samples.length > 2 && at - this.samples[0]!.at > WINDOW_MS) {
      this.samples.shift();
    }
  }

  /** Bytes per second across the window, or null before that can be said. */
  public get bytesPerSecond(): number | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const span = last.at - first.at;
    if (span < MIN_SPAN_MS) return null;
    const delta = last.bytes - first.bytes;
    if (delta <= 0) return null;
    return (delta * 1000) / span;
  }

  /** Milliseconds still to go for `total` bytes, or null when it cannot be said. */
  public remainingMs(total: number): number | null {
    const rate = this.bytesPerSecond;
    if (rate === null) return null;
    const done = this.samples[this.samples.length - 1]!.bytes;
    const left = total - done;
    if (left <= 0) return 0;
    const ms = (left / rate) * 1000;
    return ms > MAX_ETA_MS ? null : ms;
  }

  /** Forget everything, for a fresh transfer. */
  public reset(): void {
    this.samples = [];
  }
}

/** `"12.40 MB/s"` — the unit comes from the shared byte formatter. */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * A duration short enough for a status line: `45s`, `1m 12s`, `2h 5m`.
 *
 * Rounds up to at least a second, so a finishing transfer never reads "0s left".
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
