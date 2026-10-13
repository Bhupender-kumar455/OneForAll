/**
 * Formatting worker.
 *
 * Everything that can take real time — Prettier, the WASM formatters, terser —
 * runs here so the UI thread never blocks, keeps painting, and stays able to
 * cancel. This module is only ever loaded as a worker entry point.
 */
// Explicit .ts specifiers: the format-client/cancellation logic is unit-tested
// with `node --test`, which resolves modules itself instead of via Vite.
import { formatCode, type FormatOptions } from './formatter.ts';

export interface FormatWorkerRequest {
  id: number;
  source: string;
  options: FormatOptions;
}

export type FormatWorkerResponse =
  | { id: number; ok: true; output: string }
  | { id: number; ok: false; error: string };

// Only the slice of the worker global this module uses, so the file needs
// neither lib.webworker (which clashes with lib.dom) nor a UMD global.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<FormatWorkerRequest>) => void) | null;
  postMessage: (message: FormatWorkerResponse) => void;
};

ctx.onmessage = (event: MessageEvent<FormatWorkerRequest>) => {
  const { id, source, options } = event.data;

  formatCode(source, options)
    .then((output) => {
      ctx.postMessage({ id, ok: true, output } satisfies FormatWorkerResponse);
    })
    .catch((cause: unknown) => {
      const error = cause instanceof Error ? cause.message : String(cause);
      ctx.postMessage({ id, ok: false, error } satisfies FormatWorkerResponse);
    });
};
