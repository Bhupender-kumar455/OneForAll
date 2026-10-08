import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { digestsMatch, sha256Bytes } from "./checksum.ts";
import {
  CHUNK_DIGEST_BYTES,
  CHUNK_HEADER_BYTES,
  CHUNK_SIZE,
  decodeChunk,
  deserializeMessage,
  encodeChunk,
  missingRanges,
  PROTOCOL_VERSION,
  serializeMessage,
  totalBytes,
} from "./protocol.ts";

/** Frame a payload the way the sender does: digest it, then write the frame. */
async function frame(payload: Uint8Array): Promise<ArrayBuffer> {
  const data = payload.buffer.slice(
    payload.byteOffset,
    payload.byteOffset + payload.byteLength,
  ) as ArrayBuffer;
  return encodeChunk(0, data, await sha256Bytes(data));
}

describe("chunk framing", () => {
  it("round-trips a chunk's offset, digest and bytes", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 255]).buffer;
    const frame = encodeChunk(131_072, data, await sha256Bytes(data));
    const decoded = decodeChunk(frame);
    assert.equal(decoded.offset, 131_072);
    assert.deepEqual(Array.from(decoded.data), [1, 2, 3, 4, 255]);
    assert.ok(digestsMatch(decoded.digest, await sha256Bytes(data)));
    assert.equal(decoded.digest.byteLength, CHUNK_DIGEST_BYTES);
  });

  it("keeps the payload byte-exact across a large chunk", async () => {
    const data = new Uint8Array(CHUNK_SIZE);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 256;
    const decoded = decodeChunk(await frame(data));
    assert.equal(decoded.data.byteLength, CHUNK_SIZE);
    assert.ok(decoded.data.every((byte, i) => byte === i % 256));
  });

  it("sizes the frame as header + payload", async () => {
    const data = new ArrayBuffer(10);
    const frame = encodeChunk(0, data, await sha256Bytes(data));
    assert.equal(frame.byteLength, CHUNK_HEADER_BYTES + 10);
  });

  it("rejects a digest that is not a full SHA-256", () => {
    assert.throws(
      () => encodeChunk(0, new ArrayBuffer(4), new Uint8Array(16)),
      /must be 32 bytes/,
    );
  });

  it("rejects a frame too short to hold an offset", () => {
    assert.throws(() => decodeChunk(new ArrayBuffer(4)));
  });
});

describe("chunk framing across a whole file", () => {
  it("frames every chunk of a multi-chunk file and returns the bytes intact", async () => {
    const size = CHUNK_SIZE * 3 + 100;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 7) % 256;

    const offsets: number[] = [];
    for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
      const payload = bytes.slice(offset, offset + CHUNK_SIZE);
      const data = payload.buffer as ArrayBuffer;
      const decoded = decodeChunk(encodeChunk(offset, data, await sha256Bytes(data)));
      assert.equal(decoded.offset, offset);
      assert.deepEqual(Array.from(decoded.data), Array.from(payload));
      // The digest is the chunk's own, so a frame is self-describing.
      assert.ok(digestsMatch(decoded.digest, await sha256Bytes(data)));
      offsets.push(decoded.offset);
    }

    assert.equal(offsets.length, Math.ceil(size / CHUNK_SIZE));
    assert.equal(offsets.at(-1), CHUNK_SIZE * 3);
  });
});

describe("missing-range computation (resume)", () => {
  const size = CHUNK_SIZE * 5;
  const allOffsets = [0, 1, 2, 3, 4].map((i) => i * CHUNK_SIZE);

  it("reports the whole file when nothing has arrived", () => {
    assert.deepEqual(missingRanges(new Set(), size), [{ offset: 0, length: size }]);
  });

  it("reports nothing when every chunk is stored", () => {
    assert.deepEqual(missingRanges(new Set(allOffsets), size), []);
  });

  it("coalesces a contiguous hole into a single range", () => {
    // Chunks 3 and 4 are missing: one range, not two offsets.
    const seen = new Set([0, 1, 2].map((i) => i * CHUNK_SIZE));
    assert.deepEqual(missingRanges(seen, size), [
      { offset: CHUNK_SIZE * 3, length: CHUNK_SIZE * 2 },
    ]);
  });

  it("keeps separated holes in separate, ordered ranges", () => {
    const seen = new Set([CHUNK_SIZE, CHUNK_SIZE * 3]);
    assert.deepEqual(missingRanges(seen, size), [
      { offset: 0, length: CHUNK_SIZE },
      { offset: CHUNK_SIZE * 2, length: CHUNK_SIZE },
      { offset: CHUNK_SIZE * 4, length: CHUNK_SIZE },
    ]);
  });

  it("sizes a short final chunk by the declared total, not the chunk size", () => {
    const ragged = CHUNK_SIZE * 2 + 100;
    assert.deepEqual(missingRanges(new Set([0, CHUNK_SIZE]), ragged), [
      { offset: CHUNK_SIZE * 2, length: 100 },
    ]);
  });

  it("covers exactly the missing bytes, including a one-byte tail chunk", () => {
    const ragged = CHUNK_SIZE * 3 + 1;
    const seen = new Set([0]);
    const ranges = missingRanges(seen, ragged);
    assert.deepEqual(ranges, [{ offset: CHUNK_SIZE, length: CHUNK_SIZE * 2 + 1 }]);
    assert.equal(totalBytes(ranges), CHUNK_SIZE * 2 + 1);
  });

  it("treats a nonsensical size as nothing to send", () => {
    assert.deepEqual(missingRanges(new Set(), 0), []);
    assert.deepEqual(missingRanges(new Set(), Number.NaN), []);
  });
});

describe("control messages", () => {
  it("round-trips a file-start message", () => {
    const msg = {
      type: "file-start" as const,
      protocol: PROTOCOL_VERSION,
      name: "report.pdf",
      size: 4096,
      mime: "application/pdf",
      chunkSize: CHUNK_SIZE,
    };
    assert.deepEqual(deserializeMessage(serializeMessage(msg)), msg);
  });

  it("round-trips a cancellation", () => {
    const msg = { type: "cancelled" as const, reason: "User cancelled" };
    assert.deepEqual(deserializeMessage(serializeMessage(msg)), msg);
  });

  it("round-trips a resume request with its ranges", () => {
    const msg = {
      type: "resume-request" as const,
      ranges: [{ offset: CHUNK_SIZE, length: CHUNK_SIZE * 2 }],
    };
    assert.deepEqual(deserializeMessage(serializeMessage(msg)), msg);
  });

  it("rejects non-transfer JSON", () => {
    assert.throws(() => deserializeMessage("123"));
    assert.throws(() => deserializeMessage("null"));
    assert.throws(() => deserializeMessage('{"other":true}'));
  });
});
