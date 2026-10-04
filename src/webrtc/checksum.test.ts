import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sha256Blob, sha256Hex, sha256Streamed } from "./checksum.ts";
import { Sha256 } from "./sha256.ts";
import { CHUNK_SIZE, encodeChunk, decodeChunk } from "./protocol.ts";
import { createSink } from "./sink.ts";

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

  it("routes large payloads through the streamed path", async () => {
    // Larger than one window, so sha256Blob must not materialise it wholesale.
    const bytes = new Uint8Array((1 << 20) + 12345);
    for (let i = 0; i < bytes.length; i += 64) bytes[i] = (i / 64) % 256;
    assert.equal(
      await sha256Blob(new Blob([bytes])),
      await sha256Hex(bytes.buffer as ArrayBuffer),
    );
  });
});

describe("streaming sha256", () => {
  it("matches Web Crypto on every block-boundary length", async () => {
    // 55/56/57 and 63/64/65 are where padding logic goes wrong.
    const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000, 4096, 65_537];
    for (const length of lengths) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + 7) % 256;
      assert.equal(
        await sha256Streamed(new Blob([bytes])),
        await sha256Hex(bytes.buffer as ArrayBuffer),
        `mismatch at length ${length}`,
      );
    }
  });

  it("matches the known digests", async () => {
    assert.equal(
      new Sha256().hex(),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const abc = new TextEncoder().encode("abc");
    assert.equal(
      new Sha256().update(abc).hex(),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is independent of how the input is chunked", async () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 3) % 256;
    const expected = await sha256Hex(bytes.buffer as ArrayBuffer);

    for (const size of [1, 7, 63, 64, 65, 333]) {
      const hash = new Sha256();
      for (let offset = 0; offset < bytes.length; offset += size) {
        hash.update(bytes.subarray(offset, offset + size));
      }
      assert.equal(hash.hex(), expected, `mismatch when fed ${size}-byte pieces`);
    }
  });
});

describe("integrity round trip", () => {
  it("survives framing and the sink, and detects a flipped bit", async () => {
    const original = new Uint8Array(CHUNK_SIZE * 2 + 64);
    for (let i = 0; i < original.length; i += 1) original[i] = (i * 13) % 256;
    const digest = await sha256Hex(original.buffer as ArrayBuffer);

    // Move the payload through the real framing path and into a sink.
    const sink = await createSink("checksum-test", original.length);
    for (let offset = 0; offset < original.length; offset += CHUNK_SIZE) {
      const payload = original.slice(offset, offset + CHUNK_SIZE);
      const decoded = decodeChunk(encodeChunk(offset, payload.buffer as ArrayBuffer));
      await sink.write(decoded.offset, decoded.data);
    }
    assert.equal(await sink.digest(), digest);
    assert.equal(await sha256Blob(await sink.finish()), digest);

    // The same bytes with one bit flipped must not match.
    const tampered = original.slice();
    tampered[original.length - 1] ^= 0xff;
    const tamperedSink = await createSink("checksum-tampered", original.length);
    await tamperedSink.write(0, tampered);
    assert.notEqual(await tamperedSink.digest(), digest);

    await sink.dispose();
    await tamperedSink.dispose();
  });
});