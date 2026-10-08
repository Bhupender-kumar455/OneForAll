import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compressionAvailable, deflateChunk, inflateChunk } from "./compress.ts";

/** Text compresses; this stands in for a log, a CSV or a source file. */
function textBytes(size: number): Uint8Array {
  const line = "2026-10-08T00:00:00Z INFO worker finished batch in 421ms\n";
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = line.charCodeAt(i % line.length);
  return out;
}

/** Random bytes do not: this stands in for a zip, a ROM, a JPEG or an MP4. */
function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out);
  return out;
}

describe("per-chunk compression", () => {
  it("is available in this runtime", () => {
    assert.equal(compressionAvailable(), true);
  });

  it("round-trips a compressible chunk", async () => {
    const original = textBytes(64 * 1024);
    const packed = await deflateChunk(original);

    assert.ok(packed, "a text chunk should compress");
    assert.deepEqual(
      Array.from(await inflateChunk(packed, original.byteLength)),
      Array.from(original),
    );
  });

  it("shrinks a 64 KiB text chunk to well under a third", async () => {
    const original = textBytes(64 * 1024);
    const packed = await deflateChunk(original);

    assert.ok(packed);
    assert.ok(
      packed.byteLength < original.byteLength / 3,
      `expected a big saving, got ${packed.byteLength} bytes from ${original.byteLength}`,
    );
  });

  it("returns null rather than a larger buffer for random data", async () => {
    // null is the signal to send the bytes as they are. Returning a bigger
    // payload would make the frame's "deflated" flag a lie, and the receiver
    // would expand something that gained nothing.
    assert.equal(await deflateChunk(randomBytes(64 * 1024)), null);
  });

  it("refuses a payload that expands past the space it fills", async () => {
    // 200 KiB of one byte compresses to almost nothing, so decoding it back into
    // a 64 KiB slot is exactly what a decompression bomb looks like.
    const bomb = await deflateChunk(new Uint8Array(200 * 1024));
    assert.ok(bomb, "the bomb should compress");

    await assert.rejects(
      () => inflateChunk(bomb, 64 * 1024),
      /larger than the 65536 bytes/,
    );
  });

  it("rejects a payload that is not a deflate stream at all", async () => {
    // BTYPE 11 is reserved, so this cannot be a valid stream however it is read.
    await assert.rejects(() => inflateChunk(new Uint8Array(64).fill(0x06), 64));
  });
});
