import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sha256Hex } from "./checksum.ts";
import { CHUNK_SIZE } from "./protocol.ts";
import { canStreamToDisk, createSink, MAX_TRANSFER_BYTES } from "./sink.ts";

/**
 * Node has no `navigator.storage`, so `createSink` exercises the in-memory
 * path here.  The disk path is verified in a real browser.
 */
describe("createSink (no OPFS available)", () => {
  it("falls back to the memory sink", async () => {
    assert.equal(canStreamToDisk(), false);
    const sink = await createSink("test-memory", 128);
    assert.equal(sink.kind, "memory");
    await sink.dispose();
  });
});

describe("memory sink", () => {
  it("accepts chunks in any order and reproduces the file", async () => {
    const size = CHUNK_SIZE * 3;
    const file = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) file[i] = (i * 5) % 256;

    const sink = await createSink("out-of-order", size);
    // Deliberately reverse order: offsets are absolute, so order must not matter.
    for (let offset = size - CHUNK_SIZE; offset >= 0; offset -= CHUNK_SIZE) {
      await sink.write(offset, file.slice(offset, offset + CHUNK_SIZE));
    }

    assert.equal(await sink.digest(), await sha256Hex(file.buffer as ArrayBuffer));
    const blob = await sink.finish();
    assert.equal(blob.size, size);
    await sink.dispose();
  });

  it("treats a re-sent chunk as an overwrite, not a corruption", async () => {
    const sink = await createSink("resend", 8);
    const good = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await sink.write(0, good);
    await sink.write(0, good);
    assert.equal(
      await sink.digest(),
      await sha256Hex(good.buffer as ArrayBuffer),
    );
    await sink.dispose();
  });

  it("rejects a chunk that would overrun the declared size", async () => {
    const sink = await createSink("overrun", 16);
    await assert.rejects(() => sink.write(10, new Uint8Array(10)));
    await assert.rejects(() => sink.write(-1, new Uint8Array(1)));
    await sink.dispose();
  });

  it("leaves the untouched tail zero-filled rather than shifting data", async () => {
    const sink = await createSink("partial", 8);
    await sink.write(4, new Uint8Array([9, 9, 9, 9]));
    const bytes = new Uint8Array(await (await sink.finish()).arrayBuffer());
    assert.deepEqual(Array.from(bytes), [0, 0, 0, 0, 9, 9, 9, 9]);
    await sink.dispose();
  });

  it("survives dispose being called twice", async () => {
    const sink = await createSink("double-dispose", 4);
    await sink.dispose();
    await sink.dispose();
  });
});

describe("transfer size guard", () => {
  it("keeps the cap at one gigabyte", () => {
    assert.equal(MAX_TRANSFER_BYTES, 1_000_000_000);
  });
});
