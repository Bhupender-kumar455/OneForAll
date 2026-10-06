/**
 * SHA-256 helpers for transfer integrity.
 *
 * Integrity is checked one chunk at a time, as the bytes stream: the sender
 * digests each 64 KiB slice it reads and puts that digest in the frame header,
 * and the receiver digests the slice it just received and compares before
 * storing it.  Nothing has to be read twice — not the file on the sending side
 * before the transfer starts, and not the reassembled file on the receiving
 * side afterwards — and a failure names the exact byte offset that went bad
 * instead of reporting only that "the file" is corrupt.
 *
 * `sha256Hex`/`sha256Blob` are kept for callers that want a whole-payload
 * digest string; the streaming implementation keeps peak memory flat by reading
 * one window at a time.
 */
import { Sha256 } from "./sha256.ts";

/** Read window for windowed hashing: 1 MiB keeps the copy negligible. */
const WINDOW_BYTES = 1 << 20;

/**
 * Raw SHA-256 bytes of a buffer or view.
 *
 * Raw bytes, not hex, because the per-chunk path compares digests thousands of
 * times for a multi-gigabyte file and building a hex string each time would
 * allocate for no reason.
 */
export async function sha256Bytes(
  input: ArrayBufferLike | ArrayBufferView,
): Promise<Uint8Array> {
  // `crypto.subtle.digest` is typed to `BufferSource`, whose view arm is
  // narrower than the plain `Uint8Array` a caller can hold. A view hashes the
  // same bytes whatever backs it, so this is a lib gap, not a real widening.
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", input as BufferSource),
  );
}

/** Lowercase hex SHA-256 of a buffer, using the platform digest. */
export async function sha256Hex(
  buffer: ArrayBufferLike | ArrayBufferView,
): Promise<string> {
  return toHex(await sha256Bytes(buffer));
}

/** Constant-shape comparison of two digests; length mismatch is a mismatch. */
export function digestsMatch(expected: Uint8Array, actual: Uint8Array): boolean {
  if (expected.byteLength !== actual.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < expected.byteLength; i += 1) {
    diff |= expected[i]! ^ actual[i]!;
  }
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
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

export function sha256Blob(blob: Blob): Promise<string> {
  // Small payloads are cheaper through the platform digest.
  return blob.size <= WINDOW_BYTES
    ? blob.arrayBuffer().then(sha256Hex)
    : sha256Streamed(blob);
}
