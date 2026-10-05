import type { ExecutionResult } from './types.ts';

/**
 * The provider's shape, kept in one place so the rest of the app never learns
 * its field names. Judge0 reports `null` for anything it has nothing to say
 * about, which is why every field here is nullable.
 */
export type ProviderSubmission = {
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  exit_code?: number | null;
  time?: string | null;
  memory?: number | null;
  status?: { id?: number | null; description?: string | null } | null;
};

/**
 * Every field the runner wants back, in one place. Sent upstream as the
 * `fields` query so the provider skips serializing what we would discard.
 */
export const SUBMISSION_FIELDS = [
  'stdout',
  'stderr',
  'compile_output',
  'message',
  'exit_code',
  'time',
  'memory',
  'status',
] as const;

/** Judge0 status ids. Values above 2 are terminal; 1 and 2 are in progress. */
export const STATUS_IN_QUEUE = 1;
export const STATUS_PROCESSING = 2;

export function isTerminalStatus(statusId: number | null | undefined): boolean {
  return typeof statusId === 'number' && statusId > STATUS_PROCESSING;
}

/**
 * Turn any provider response into the app's own result shape.
 *
 * `timedOut` is set here rather than derived later because only this layer knows
 * whether a non-terminal status means "still running" (we gave up) or an actual
 * verdict from the provider.
 */
export function normalizeExecution(
  raw: ProviderSubmission,
  options: { maxOutputChars: number; timedOut?: boolean },
): ExecutionResult {
  const statusId = typeof raw.status?.id === 'number' ? raw.status.id : 0;
  const description = raw.status?.description?.trim();

  let status = description && description.length > 0 ? description : 'Unknown';
  if (options.timedOut === true) status = 'Timed out';

  return {
    status,
    statusId,
    stdout: raw.stdout ?? '',
    stderr: raw.stderr ?? '',
    compileOutput: raw.compile_output ?? '',
    message: raw.message ?? '',
    exitCode: typeof raw.exit_code === 'number' ? raw.exit_code : null,
    time: raw.time ?? '',
    memory: typeof raw.memory === 'number' ? raw.memory : null,
    timedOut: options.timedOut === true,
  };
}

/**
 * Decide how much output to ask the provider to send back, given the byte
 * limits. A submission whose first 200 kB is not enough is not worth relaying
 * further: the max-output cap will trim it anyway.
 */
export function outputLimitBytes(maxOutputChars: number): number {
  // Four bytes per UTF-8 code point covers the worst case (astral characters),
  // so the provider never truncates below our own character cap.
  return maxOutputChars * 4 + 4096;
}