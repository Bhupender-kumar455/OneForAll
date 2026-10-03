import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assembleChunks,
  CHUNK_HEADER_BYTES,
  CHUNK_SIZE,
  decodeChunk,
  deserializeMessage,
  encodeChunk,
  serializeMessage,
} from "./protocol.ts";

describe("chunk framing", () => {
  it("round-trips a chunk's offset and bytes", () => {
    const data = new Uint8Array([1, 2, 3, 4, 255]).buffer;
    const frame = encodeChunk(131_072, data);
    const decoded = decodeChunk(frame);
    assert.equal(decoded.offset, 131_072);
    assert.deepEqual(Array.from(decoded.data), [1, 2, 3, 4, 255]);
  });

  it("keeps the payload byte-exact across a large chunk", () => {
    const data = new Uint8Array(CHUNK_SIZE);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 256;
    const decoded = decodeChunk(encodeChunk(64, data.buffer));
    assert.equal(decoded.data.byteLength, CHUNK_SIZE);
    assert.ok(decoded.data.every((byte, i) => byte === i % 256));
  });

  it("sizes the frame as header + payload", () => {
    const frame = encodeChunk(0, new ArrayBuffer(10));
    assert.equal(frame.byteLength, CHUNK_HEADER_BYTES + 10);
  });

  it("rejects a frame too short to hold an offset", () => {
    assert.throws(() => decodeChunk(new ArrayBuffer(4)));
  });
});

describe("assembleChunks", () => {
  const fileOf = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 7) % 256;
    return bytes;
  };

  const chunkify = (bytes: Uint8Array): Map<number, Uint8Array> => {
    const chunks = new Map<number, Uint8Array>();
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      chunks.set(offset, bytes.subarray(offset, offset + CHUNK_SIZE));
    }
    return chunks;
  };

  it("reassembles a file spread over several chunks", () => {
    const bytes = fileOf(CHUNK_SIZE * 3 + 100);
    const result = assembleChunks(chunkify(bytes), bytes.length);
    assert.ok(result);
    assert.deepEqual(Array.from(result), Array.from(bytes));
  });

  it("returns null while a chunk is still missing", () => {
    const bytes = fileOf(CHUNK_SIZE * 2);
    const chunks = chunkify(bytes);
    chunks.delete(0);
    assert.equal(assembleChunks(chunks, bytes.length), null);
  });

  it("throws when a chunk overruns the declared size", () => {
    const chunks = new Map<number, Uint8Array>([
      [0, new Uint8Array(10)],
      [10, new Uint8Array(10)],
    ]);
    assert.throws(() => assembleChunks(chunks, 15));
  });

  it("returns null for a zero-byte file", () => {
    assert.equal(assembleChunks(new Map(), 0), null);
  });
});

describe("control messages", () => {
  it("round-trips a file-start message", () => {
    const msg = {
      type: "file-start" as const,
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

  it("rejects non-transfer JSON", () => {
    assert.throws(() => deserializeMessage("123"));
    assert.throws(() => deserializeMessage("null"));
    assert.throws(() => deserializeMessage('{"other":true}'));
  });
});
