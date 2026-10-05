/**
 * The execution boundary: `POST /api/execute`.
 *
 * Three jobs, and deliberately no fourth:
 *   1. validate what the browser sent, against limits it cannot influence,
 *   2. attach the provider credential and submit,
 *   3. normalize the provider's answer into our own result shape.
 *
 * It never executes user code. The provider's sandbox does that. Nothing about
 * the provider — its URL, its field names, its errors, its token — is visible to
 * the browser, so the provider can be swapped or self-hosted without touching
 * the UI.
 *
 * Deployed as a Vercel Function (this file is at the project root, so Vercel
 * picks it up from `api/`). Static-only hosts simply have no such endpoint, and
 * the page says so instead of failing on the first Run.
 */
// Relative `.ts` specifiers keep this module resolvable both by Vercel's
// bundler and by `tsc`, without depending on path-alias support at runtime.
import {
  buildProviderPayload,
  originAllowed,
  providerFailure,
  RequestRateLimiter,
  submissionQuery,
  toClientResult,
  validateExecuteRequest,
} from '../src/lib/runner/api-core.ts';
import { runnerLimits, DEFAULT_WAIT_SECONDS } from '../src/lib/runner/limits.ts';
import { isTerminalStatus } from '../src/lib/runner/normalize.ts';

/**
 * A generous ceiling for the function itself. The program gets a few seconds;
 * the rest is queue time at the provider, which can spike on a shared instance.
 */
export const config = { maxDuration: 30 };

/**
 * The function warms up and stays warm between requests, so this instance-wide
 * limiter throttles a burst from one caller. It is a speed bump, not a
 * guarantee — there may be several instances, and the provider's own quota is
 * the real backstop.
 */
const limiter = new RequestRateLimiter(12, 60_000);

type RequestLike = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  socket?: { remoteAddress?: string };
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
};

type ResponseLike = {
  setHeader(name: string, value: string): void;
  status(code: number): ResponseLike;
  json(body: unknown): void;
};

function header(req: RequestLike, name: string): string | undefined {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Client address for rate limiting, behind Vercel's proxy. */
function clientKey(req: RequestLike): string {
  const forwarded = header(req, 'x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Get the request body as parsed JSON. Vercel's Node runtime parses JSON bodies
 * for us; reading the stream is the fallback for other hosts.
 */
async function readBody(req: RequestLike): Promise<unknown> {
  const body = req.body;
  if (body === undefined || body === null) {
    // Bind the request explicitly: Node's own async iterator is a method that
    // expects `this` to be the stream it came from.
    const stream = req[Symbol.asyncIterator];
    if (typeof stream !== 'function') return undefined;
    let text = '';
    const iterator = stream.call(req);
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
      if (text.length > 4_000_000) break; // far past any valid submission
    }
    return text === '' ? undefined : JSON.parse(text);
  }
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  return body;
}

function providerBaseUrl(): string {
  const configured = process.env.JUDGE0_BASE_URL?.trim();
  const base = configured && configured !== '' ? configured : 'https://ce.judge0.com';
  return base.replace(/\/+$/, '');
}

export default async function handler(req: RequestLike, res: ResponseLike): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  if (!originAllowed(header(req, 'origin'), header(req, 'host'))) {
    res.status(403).json({ error: 'Cross-origin execution requests are not allowed.' });
    return;
  }

  const limits = runnerLimits(process.env);

  if (!limiter.allow(clientKey(req))) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: 'Too many executions. Wait a moment and try again.' });
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.status(400).json({ error: 'Request body is not valid JSON.' });
    return;
  }

  const validation = validateExecuteRequest(body, limits);
  if (!validation.ok) {
    res.status(validation.failure.status).json({ error: validation.failure.error });
    return;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = process.env.JUDGE0_AUTH_TOKEN?.trim();
  // Server-side only, and only when the provider asks for it. The public CE
  // instance does not.
  if (token) headers['X-Auth-Token'] = token;

  // Our own runtime controls, not the caller's: see `buildProviderPayload`.
  const payload = buildProviderPayload(validation.request, limits);

  const deadline = (limits.waitSeconds || DEFAULT_WAIT_SECONDS) * 1000 + 2_000;

  try {
    const response = await fetch(`${providerBaseUrl()}/submissions${submissionQuery(limits)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(deadline),
    });

    if (!response.ok) {
      const failure = providerFailure(response.status);
      console.error(`[runner] provider responded ${response.status}`);
      res.status(failure.status).json({ error: failure.error });
      return;
    }

    const raw = (await response.json()) as Parameters<typeof toClientResult>[0];
    // `?wait=true` returns a terminal submission, but a queue spike can still
    // hand back "In Queue"/"Processing". That is a timeout from our side, and
    // it must not be reported as a successful run.
    const timedOut = !isTerminalStatus(raw.status?.id);
    res.status(200).json(
      toClientResult(raw, { maxOutputChars: limits.maxOutputChars, timedOut }),
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    console.error('[runner] provider request failed:', error instanceof Error ? error.message : error);
    res.status(502).json({
      error: timedOut
        ? 'The execution timed out before the program finished.'
        : 'The execution service is temporarily unavailable.',
    });
  }
}