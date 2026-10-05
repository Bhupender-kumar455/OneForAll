/**
 * Browser client for the runner's own `/api/execute` endpoint.
 *
 * The UI only ever sees this contract: `ExecuteRequest` in, `ExecutionResult`
 * out. There is no provider URL, no token and no provider field name anywhere
 * on this side of the boundary, which is the whole point of having one.
 */
import type { ExecutionResult, ExecuteRequest } from '@/lib/runner/types';

/** Milliseconds before the browser gives up on a slow execution request. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Set once when a page first finds the API missing, to avoid refetching. */
let availability: Promise<boolean> | null = null;

export class RunnerError extends Error {}

type ApiBody = ExecutionResult | { error?: string };

async function readJson(response: Response): Promise<ApiBody> {
  try {
    return (await response.json()) as ApiBody;
  } catch {
    throw new RunnerError('The execution service returned an unreadable response.');
  }
}

async function postExecute(
  request: ExecuteRequest,
  signal: AbortSignal,
): Promise<ExecutionResult> {
  const response = await fetch('/api/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  const body = await readJson(response);
  if (!response.ok) {
    const message =
      'error' in body && typeof body.error === 'string'
        ? body.error
        : 'The execution service is temporarily unavailable.';
    throw new RunnerError(message);
  }
  if ('error' in body) {
    throw new RunnerError('The execution service returned an unexpected response.');
  }
  return body as ExecutionResult;
}

/**
 * Run a submission.
 *
 * The signal is what lets the Run button turn into a working Cancel: aborting
 * the fetch also aborts the serverless request, which is the only way a caller
 * can stop paying for an execution it no longer wants.
 */
export async function executeCode(
  request: ExecuteRequest,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await postExecute(request, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new RunnerError('Cancelled.');
      throw new RunnerError('The execution took too long and was stopped.');
    }
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('Could not reach the execution service. Are you online?');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Is the execution endpoint deployed at all?
 *
 * A static-only host answers the POST with the SPA fallback (an HTML 200) or a
 * 405, so the honest test is a GET that expects a JSON answer and does not mind
 * a 405 from a function that only implements POST. This lets the page explain
 * the situation instead of showing a run button that can never work.
 */
export function executionAvailable(): Promise<boolean> {
  if (availability) return availability;
  availability = fetch('/api/execute', { method: 'GET' })
    .then(async (response) => {
      // A function that exists answers 405 (or 501) for the wrong method.
      if (response.status === 405 || response.status === 501) return true;
      const type = response.headers.get('content-type') ?? '';
      if (!type.includes('application/json')) return false;
      const body = (await response.json()) as { error?: string };
      // Our own function's GET handler, or any JSON answer: the route exists.
      return typeof body?.error === 'string' || response.ok;
    })
    .catch(() => false);
  return availability;
}

/** Test seam: forget the cached availability probe. */
export function resetAvailabilityCache(): void {
  availability = null;
}