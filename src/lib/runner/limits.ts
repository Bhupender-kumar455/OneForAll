/**
 * The wires the runner refuses to let the browser choose for itself: how big a
 * submission may be, and how much output comes back.
 *
 * Every value here is read from the *server* environment, never from the
 * request body. The API layer validates against these before it touches the
 * execution provider, so an abusive or accidental payload is rejected locally
 * instead of costing provider quota.
 */

/** Source-code ceiling. Overridable with `RUNNER_MAX_SOURCE_BYTES`. */
export const DEFAULT_MAX_SOURCE_BYTES = 200_000;

/** stdin ceiling. Overridable with `RUNNER_MAX_STDIN_BYTES`. */
export const DEFAULT_MAX_STDIN_BYTES = 50_000;

/**
 * How much of any one output stream is returned to the browser. A runaway
 * `print` loop can produce megabytes in the ~3 s the program is allowed to
 * live; there is no reason to hand all of it to a terminal panel.
 */
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

/** Wall-clock budget for the provider call, in seconds. */
export const DEFAULT_WAIT_SECONDS = 20;

/**
 * CPU seconds the program is allowed. Judge0 measures this separately from wall
 * time, which is what actually bounds a busy loop.
 */
export const DEFAULT_CPU_TIME_LIMIT = 3;

/** Wall seconds the program is allowed, covering sleeps as well as work. */
export const DEFAULT_WALL_TIME_LIMIT = 5;

/** Memory ceiling handed to the provider, in kilobytes (128 MB). */
export const DEFAULT_MEMORY_LIMIT_KB = 128_000;

export type RunnerLimits = {
  maxSourceBytes: number;
  maxStdinBytes: number;
  maxOutputChars: number;
  waitSeconds: number;
};

/** Parse a positive integer override, falling back when it is absent or silly. */
function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Read the limits from an environment-shaped record. Taking the record as an
 * argument keeps this testable without touching `process.env`.
 */
export function runnerLimits(env: Record<string, string | undefined> = {}): RunnerLimits {
  return {
    maxSourceBytes: positiveInt(env.RUNNER_MAX_SOURCE_BYTES, DEFAULT_MAX_SOURCE_BYTES),
    maxStdinBytes: positiveInt(env.RUNNER_MAX_STDIN_BYTES, DEFAULT_MAX_STDIN_BYTES),
    maxOutputChars: positiveInt(env.RUNNER_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS),
    waitSeconds: positiveInt(env.RUNNER_WAIT_SECONDS, DEFAULT_WAIT_SECONDS),
  };
}

/** UTF-8 byte length, which is what the limits are expressed in. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Clip an output stream, appending a marker so the reader knows why it ends
 * abruptly rather than assuming the program stopped talking.
 */
export function truncateOutput(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
  const marker = `\n… output truncated at ${maxChars.toLocaleString()} characters …`;
  return { text: text.slice(0, maxChars) + marker, truncated: true };
}