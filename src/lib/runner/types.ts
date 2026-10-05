/**
 * The Code Runner's own vocabulary.
 *
 * Nothing here mentions the execution provider. The browser only ever talks to
 * our `/api/execute` boundary and only ever sees these shapes, so the provider
 * behind it can be swapped (or self-hosted) without touching the UI.
 */

/** A language as the UI presents it. `runtime`/`extension` are cosmetic. */
export type RunnerLanguage = {
  /** Provider language id. Kept in `data/languages.ts` and mapped server-side. */
  id: number;
  name: string;
  /** Short label for the selector, e.g. `Python`. */
  short: string;
  /** Runtime note shown next to the selector, e.g. `3.14.0`. */
  runtime: string;
  extension: string;
  /** Monaco's language id, or `plaintext` where Monaco has no grammar. */
  monaco: string;
  defaultCode: string;
};

/** What the UI is doing. Drives the Run button, status pill and cancel. */
export type RunPhase = 'idle' | 'submitting' | 'running' | 'done' | 'cancelled' | 'error';

/** The single shape the API returns, regardless of the provider behind it. */
export type ExecutionResult = {
  /** Terminal status: `Accepted` on success, the provider's verdict otherwise. */
  status: string;
  /** Provider status id (`3` = accepted). Useful for classifying at a glance. */
  statusId: number;
  stdout: string;
  stderr: string;
  /** Compiler diagnostics, kept separate from runtime stderr on purpose. */
  compileOutput: string;
  /** Runtime's own message: timeout, memory exceeded, internal error. */
  message: string;
  exitCode: number | null;
  /** Seconds, as the provider reports them. */
  time: string;
  /** Kilobytes, as the provider reports them. */
  memory: number | null;
  /** True when the provider never reached a terminal state in time. */
  timedOut: boolean;
};

export type ExecuteRequest = {
  languageId: number;
  sourceCode: string;
  stdin: string;
};