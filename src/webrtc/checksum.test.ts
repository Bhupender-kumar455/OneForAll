import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sha256Blob, sha256Hex } from "./checksum.ts";
import { assembleChunks, CHUNK_SIZE, encodeChunk, decodeChunk } from "./protocol.ts";

describe("sha256Hex", () => {
  it("matches the known digest of an empty input", async () => {
    // Well-known SHA-256 of the empty string.
    assert.equal(
      await sha256Hex(new ArrayBuffer(0)),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known digest of 'abc'", async () => {
    const abc = new TextEncoder().encode("abc");
    assert.equal(
      await sha256Hex(abc.buffer as ArrayBuffer),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assert.equal(await sha256Blob(new Blob([abc])), await sha256Hex(abc.buffer as ArrayBuffer));
  });

  it("changes when a single byte changes", async () => {
    const a = new Uint8Array([1, 2, 3]).buffer;
    const b = new Uint8Array([1, 2, 4]).buffer;
    assert.notEqual(await sha256Hex(a), await sha256Hex(b));
  });
});

describe("integrity round trip", () => {
  it("detects a corrupted chunk after reassembly", async () => {
    const original = new Uint8Array(CHUNK_SIZE * 2 + 64);
    for (let i = 0; i < original.length; i += 1) original[i] = (i * 13) % 256;
    const digest = await sha256Hex(original.buffer as ArrayBuffer);

    // Move the payload through the real framing/reassembly path.
    const chunks = new Map<number, Uint8Array>();
    for (let offset = 0; offset < original.length; offset += CHUNK_SIZE) {
      const frame = encodeChunk(offset, original.slice(offset, offset + CHUNK_SIZE).buffer);
      const decoded = decodeChunk(frame);
      chunks.set(decoded.offset, decoded.data);
    }
    const rebuilt = assembleChunks(chunks, original.length);
    assert.ok(rebuilt);
    assert.equal(await sha256Hex(rebuilt.buffer as ArrayBuffer), digest);

    // Flip one bit in transit and the digest must disagree.
    const last = chunks.get(chunks.size * CHUNK_SIZE - CHUNK_SIZE)!;
    last[0] = last[0] ^ 0xff;
    const corrupted = assembleChunks(chunks, original.length);
    assert.ok(corrupted);
    assert.notEqual(await sha256Hex(corrupted.buffer as ArrayBuffer), digest);
  });
});