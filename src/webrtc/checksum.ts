/**
 * SHA-256 helpers for transfer integrity.
 *
 * The sender digests the whole file up front and publishes the hex digest with
 * the transfer record.  The receiver digests what it reassembled and compares,
 * so a truncated or corrupted transfer is reported instead of silently saved.
 *
 * For payloads that are already in memory the native Web Crypto digest is used
 * (fast, no extra copy).  For files on disk the incremental implementation
 * reads one window at a time, so peak memory stays flat instead of pulling the
 * whole file back into the heap.
 */
import { Sha256 } from "./sha256.ts";

/** Read window for windowed hashing: 1 MiB keeps the copy negligible. */
const WINDOW_BYTES = 1 << 20;

/** Lowercase hex SHA-256 of a buffer, using the platform digest. */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SHA-256 of a Blob/File without ever holding the whole payload.
 *
 * `slice` is lazy, so each `arrayBuffer()` call materialises exactly one window
 * and the previous one becomes garbage immediately.
 */
export async function sha256Streamed(blob: Blob): Promise<string> {
  const hash = new Sha256();
  for (let offset = 0; offset < blob.size; offset += WINDOW_BYTES) {
    const window = blob.slice(offset, offset + WINDOW_BYTES);
    hash.update(new Uint8Array(await window.arrayBuffer()));
  }
  return hash.hex();
}

export function sha256File(file: File): Promise<string> {
  return sha256Streamed(file);
}

export function sha256Blob(blob: Blob): Promise<string> {
  // Small payloads are cheaper through the platform digest.
  return blob.size <= WINDOW_BYTES
    ? blob.arrayBuffer().then(sha256Hex)
    : sha256Streamed(blob);
}
