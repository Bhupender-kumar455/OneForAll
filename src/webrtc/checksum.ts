/**
 * SHA-256 helpers for transfer integrity.
 *
 * The sender digests the whole file up front and publishes the hex digest with
 * the transfer record.  The receiver digests what it reassembled and compares,
 * so a truncated or corrupted transfer is reported instead of silently saved.
 */

/** Lowercase hex SHA-256 of a buffer. */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function sha256File(file: File): Promise<string> {
  return file.arrayBuffer().then(sha256Hex);
}

export function sha256Blob(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then(sha256Hex);
}