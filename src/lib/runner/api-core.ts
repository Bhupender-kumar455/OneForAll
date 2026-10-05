// Relative `.ts` specifiers throughout this directory: these modules are
// unit-tested with `node --test`, which resolves modules itself instead of via
// Vite, and Node's type stripping wants the real file name.
import { RUNNER_LANGUAGES } from './data/languages.ts';
import {
  byteLength,
  DEFAULT_CPU_TIME_LIMIT,
  DEFAULT_MEMORY_LIMIT_KB,
  DEFAULT_WALL_TIME_LIMIT,
  type RunnerLimits,
  truncateOutput,
} from './limits.ts';
import { normalizeExecution, SUBMISSION_FIELDS, type ProviderSubmission } from './normalize.ts';
import type { ExecutionResult, ExecuteRequest } from './types.ts';

/**
 * Everything the execution boundary does that is worth testing, kept out of
 * `api/execute.ts` so it can run under the Node test runner and be reasoned
 * about without a network in the picture.
 *
 * The function file is then only transport: read the body, call these, answer.
 */

/** The ids the UI is allowed to ask for. Anything else is a 400, not a 500. */
export const RUNNER_LANGUAGE_IDS: ReadonlySet<number> = new Set(
  RUNNER_LANGUAGES.map((language) => language.id),
);

export type ValidationFailure = {
  /** Response status: 400 for bad input, 413 for too much of it. */
  status: number;
  /** Safe, user-facing text. Never a provider or stack message. */
  error: string;
};

export type Validation =
  | { ok: true; request: ExecuteRequest }
  | { ok: false; failure: ValidationFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check a request before it costs anything. Rejects unknown shapes, unknown
 * languages and oversized payloads; it never trusts a limit sent by the
 * browser, which is why the limits come from the environment instead.
 */
export function validateExecuteRequest(body: unknown, limits: RunnerLimits): Validation {
  if (!isRecord(body)) {
    return { ok: false, failure: { status: 400, error: 'Expected a JSON object.' } };
  }

  // Judge0's ids are integers, and a string here would be coerced silently
  // upstream. Require the real thing.
  const languageId = body.languageId;
  if (typeof languageId !== 'number' || !Number.isInteger(languageId)) {
    return { ok: false, failure: { status: 400, error: 'languageId must be an integer.' } };
  }
  if (!RUNNER_LANGUAGE_IDS.has(languageId)) {
    return { ok: false, failure: { status: 400, error: `Unsupported language id: ${languageId}.` } };
  }

  const sourceCode = body.sourceCode;
  if (typeof sourceCode !== 'string') {
    return { ok: false, failure: { status: 400, error: 'sourceCode must be a string.' } };
  }
  if (sourceCode.trim() === '') {
    return { ok: false, failure: { status: 400, error: 'Source code is empty.' } };
  }

  const rawStdin = body.stdin;
  if (rawStdin !== undefined && rawStdin !== null && typeof rawStdin !== 'string') {
    return { ok: false, failure: { status: 400, error: 'stdin must be a string.' } };
  }
  const stdin = typeof rawStdin === 'string' ? rawStdin : '';

  const sourceBytes = byteLength(sourceCode);
  if (sourceBytes > limits.maxSourceBytes) {
    return {
      ok: false,
      failure: {
        status: 413,
        error: `Source code is ${sourceBytes} bytes; the limit is ${limits.maxSourceBytes}.`,
      },
    };
  }

  const stdinBytes = byteLength(stdin);
  if (stdinBytes > limits.maxStdinBytes) {
    return {
      ok: false,
      failure: {
        status: 413,
        error: `stdin is ${stdinBytes} bytes; the limit is ${limits.maxStdinBytes}.`,
      },
    };
  }

  return { ok: true, request: { languageId, sourceCode, stdin } };
}

export type ProviderPayload = {
  language_id: number;
  source_code: string;
  stdin: string;
  cpu_time_limit: number;
  wall_time_limit: number;
  memory_limit: number;
  // Keeps a runaway program's output from crossing the network at all.
  stdout_limit: number;
  stderr_limit: number;
};

/**
 * Build the upstream submission. Every runtime control is set here from our own
 * constants: the browser cannot widen a limit, and multi-file/custom-compiler
 * options stay off entirely.
 */
export function buildProviderPayload(request: ExecuteRequest, limits: RunnerLimits): ProviderPayload {
  const outputLimit = limits.maxOutputChars * 4 + 4096;
  return {
    language_id: request.languageId,
    source_code: request.sourceCode,
    stdin: request.stdin,
    cpu_time_limit: DEFAULT_CPU_TIME_LIMIT,
    wall_time_limit: DEFAULT_WALL_TIME_LIMIT,
    memory_limit: DEFAULT_MEMORY_LIMIT_KB,
    stdout_limit: outputLimit,
    stderr_limit: outputLimit,
  };
}

/** The query the provider needs to return exactly what the UI renders. */
export function submissionQuery(limits: RunnerLimits): string {
  const params = new URLSearchParams({
    base64_encoded: 'false',
    wait: 'true',
    fields: SUBMISSION_FIELDS.join(','),
  });
  return `?${params.toString()}`;
}

/**
 * Map an upstream failure onto something the browser may see. Provider detail
 * is logged server-side and replaced with a plain sentence, so a misconfigured
 * token or an internal stack trace never reaches the client.
 */
export function providerFailure(status: number): ValidationFailure {
  if (status === 429) {
    return { status: 429, error: 'The execution service is busy. Try again in a moment.' };
  }
  if (status >= 400 && status < 500) {
    return { status: 502, error: 'The execution service rejected this submission.' };
  }
  return { status: 502, error: 'The execution service is temporarily unavailable.' };
}

/** Clip every stream in a result, so one huge stream cannot crowd out another. */
export function clipResult(result: ExecutionResult, maxOutputChars: number): ExecutionResult {
  return {
    ...result,
    stdout: truncateOutput(result.stdout, maxOutputChars).text,
    stderr: truncateOutput(result.stderr, maxOutputChars).text,
    compileOutput: truncateOutput(result.compileOutput, maxOutputChars).text,
  };
}

/** Normalize and clip in the one order that makes sense: normalize, then clip. */
export function toClientResult(
  raw: ProviderSubmission,
  options: { maxOutputChars: number; timedOut?: boolean },
): ExecutionResult {
  return clipResult(normalizeExecution(raw, options), options.maxOutputChars);
}

/**
 * Per-IP sliding-window limiter.
 *
 * Serverless instances are recycled and there may be several of them, so this
 * throttles one warm instance and is a speed bump rather than a guarantee; the
 * provider's own quota is the real backstop. It is still worth having, because
 * it is what stops a held-down Run key from becoming a provider bill.
 */
export class RequestRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  // Written out rather than declared as parameter properties: these modules are
  // executed by `node --test`, whose type stripping rejects that syntax.
  constructor(maxRequests: number = 12, windowMs: number = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /** Record an attempt; returns false when the caller is over the limit. */
  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.maxRequests) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    this.prune(now);
    return true;
  }

  /** Drop windows that can no longer matter, so the map stays bounded. */
  private prune(now: number): void {
    if (this.hits.size < 500) return;
    for (const [key, times] of this.hits) {
      if (times.every((at) => now - at >= this.windowMs)) this.hits.delete(key);
    }
  }
}

/**
 * Only same-origin requests are served. A cross-origin page can still reach the
 * endpoint directly, but this keeps a stray browser tab from quietly spending
 * the provider quota on someone else's behalf.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}