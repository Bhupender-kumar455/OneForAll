/**
 * Main-thread client for the formatting worker.
 *
 * Owns the worker's lifecycle, the large-input guard and cancellation, and
 * exposes a single promise-based `run()` so the UI never has to think about
 * worker plumbing or stale results.
 */
// Explicit .ts specifiers: this module is unit-tested with `node --test`, which
// resolves modules itself instead of via Vite.
import { formatCode, type FormatOptions } from './formatter.ts';
import type { FormatWorkerRequest, FormatWorkerResponse } from './format-worker.ts';

/**
 * Inputs larger than this are not formatted automatically — the UI asks first,
 * because a multi-megabyte paste can take many seconds to rewrite.
 */
export const MAX_FORMAT_BYTES = 1_000_000;

/**
 * A superseded request only aborts its worker once it has been running this
 * long. Short jobs are left to finish (their result is discarded), which keeps
 * the loaded Prettier/WASM modules warm in the worker; long ones are genuinely
 * killed so the CPU work stops rather than queueing ahead of newer input.
 */
const CANCEL_GRACE_MS = 250;

export interface FormatOutcome {
  status: 'done' | 'error' | 'cancelled' | 'too-large';
  output: string;
  error: string | null;
  /** UTF-8 size of the input. */
  bytes: number;
  /** Where the work ran: the worker normally, the main thread as a fallback. */
  via: 'worker' | 'main';
}

export function sourceByteLength(source: string): number {
  return new TextEncoder().encode(source).length;
}

export function exceedsFormatLimit(bytes: number, limit: number = MAX_FORMAT_BYTES): boolean {
  return bytes > limit;
}

interface ActiveJob {
  id: number;
  source: string;
  options: FormatOptions;
  bytes: number;
  startedAt: number;
  settle: (outcome: FormatOutcome) => void;
}

export class FormatterClient {
  /** Overridable so the guard's policy can be exercised without huge inputs. */
  private readonly sizeLimit: number;

  constructor(sizeLimit: number = MAX_FORMAT_BYTES) {
    this.sizeLimit = sizeLimit;
  }

  private worker: Worker | null = null;
  private workerUnavailable = false;
  private disposed = false;
  private nextId = 0;
  private active: ActiveJob | null = null;

  /**
   * Formats `source`, superseding whatever is in flight. The returned promise
   * resolves with `cancelled` when a newer call takes over, so callers can drop
   * stale results without tracking request ids themselves.
   */
  run(source: string, options: FormatOptions, force = false): Promise<FormatOutcome> {
    const bytes = sourceByteLength(source);

    if (!force && exceedsFormatLimit(bytes, this.sizeLimit)) {
      this.cancel();
      return Promise.resolve({ status: 'too-large', output: '', error: null, bytes, via: 'worker' });
    }

    // Settle (and possibly abort) the previous job before starting a new one;
    // an aborted worker is replaced lazily by ensureWorker().
    this.cancel();

    return new Promise<FormatOutcome>((resolve) => {
      const id = (this.nextId += 1);
      const job: ActiveJob = { id, source, options, bytes, startedAt: Date.now(), settle: resolve };
      this.active = job;

      const worker = this.workerUnavailable ? null : this.ensureWorker();
      if (!worker) {
        // Workers unavailable: format inline, but keep the job registered so a
        // newer run can still supersede it.
        void this.runOnMainThread(source, options, bytes).then((outcome) => {
          if (this.active !== job) return; // superseded while running
          this.active = null;
          resolve(outcome);
        });
        return;
      }

      const request: FormatWorkerRequest = { id, source, options };
      worker.postMessage(request);
    });
  }

  /** Drops the in-flight job, aborting the worker if it is taking too long. */
  cancel(): void {
    const job = this.active;
    if (!job) return;
    this.active = null;
    job.settle({ status: 'cancelled', output: '', error: null, bytes: job.bytes, via: 'worker' });
    if (Date.now() - job.startedAt >= CANCEL_GRACE_MS) this.terminateWorker();
  }

  /** Releases the worker for good, e.g. when the view unmounts. */
  dispose(): void {
    this.cancel();
    this.disposed = true;
    this.terminateWorker();
  }

  private ensureWorker(): Worker | null {
    if (this.disposed) return null;
    if (this.worker) return this.worker;

    try {
      const worker = new Worker(new URL('./format-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<FormatWorkerResponse>) => this.handleMessage(event.data);
      worker.onerror = () => this.handleWorkerFailure();
      this.worker = worker;
      return worker;
    } catch {
      // Workers can be blocked outright (CSP, ancient engines): fall back to
      // formatting on the main thread so the app still works.
      this.workerUnavailable = true;
      return null;
    }
  }

  private handleMessage(response: FormatWorkerResponse): void {
    const job = this.active;
    if (!job || job.id !== response.id) return; // stale or cancelled

    this.active = null;
    if (response.ok) {
      job.settle({ status: 'done', output: response.output, error: null, bytes: job.bytes, via: 'worker' });
      return;
    }
    job.settle({ status: 'error', output: '', error: response.error, bytes: job.bytes, via: 'worker' });
  }

  /** The worker failed to load or crashed: finish the job on the main thread. */
  private handleWorkerFailure(): void {
    this.workerUnavailable = true;
    this.terminateWorker();

    const job = this.active;
    if (!job) return;
    // Re-run the same job inline, keeping it registered so a newer run can
    // still supersede it.
    void this.runOnMainThread(job.source, job.options, job.bytes).then((outcome) => {
      if (this.active !== job) return; // superseded while running
      this.active = null;
      job.settle(outcome);
    });
  }

  private terminateWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }

  private async runOnMainThread(source: string, options: FormatOptions, bytes: number): Promise<FormatOutcome> {
    try {
      const output = await formatCode(source, options);
      return { status: 'done', output, error: null, bytes, via: 'main' };
    } catch (cause: unknown) {
      return {
        status: 'error',
        output: '',
        error: cause instanceof Error ? cause.message : String(cause),
        bytes,
        via: 'main',
      };
    }
  }
}
