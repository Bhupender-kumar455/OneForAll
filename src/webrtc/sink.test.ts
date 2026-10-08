import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHUNK_SIZE } from "./protocol.ts";
import { canStreamToDisk, createSink, MAX_TRANSFER_BYTES } from "./sink.ts";
import { MAX_DECLARED_BYTES } from "./protocol.ts";

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

    const blob = await sink.finish();
    assert.equal(blob.size, size);
    const written = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual(Array.from(written), Array.from(file));
    await sink.dispose();
  });

  it("treats a re-sent chunk as an overwrite, not a corruption", async () => {
    const sink = await createSink("resend", 8);
    const good = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await sink.write(0, good);
    await sink.write(0, good);
    const written = new Uint8Array(await (await sink.finish()).arrayBuffer());
    assert.deepEqual(Array.from(written), [1, 2, 3, 4, 5, 6, 7, 8]);
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

/**
 * Pretend this browser has OPFS, but that opening the scratch file fails — the
 * shape of a full quota or a private window. The refusal then has to say why,
 * because "cannot stream to disk" on its own is not something a user can act on.
 */
describe("createSink (disk path refuses)", () => {
  it("keeps the reason the scratch file could not be opened", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        storage: {
          getDirectory: () => Promise.reject(new Error("QuotaExceededError")),
        },
      },
    });

    try {
      assert.equal(canStreamToDisk(), true);
      await assert.rejects(
        () => createSink("quota", MAX_TRANSFER_BYTES + 1),
        (err: Error) => {
          assert.match(err.message, /cannot stream to disk/i);
          assert.match(err.message, /QuotaExceededError/);
          return true;
        },
      );
      // A file that fits in memory still falls back rather than failing.
      const sink = await createSink("quota-small", 128);
      assert.equal(sink.kind, "memory");
      await sink.dispose();
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
    }
  });
});

describe("transfer size guard", () => {
  it("keeps the memory-sink ceiling at one gigabyte", () => {
    assert.equal(MAX_TRANSFER_BYTES, 1_000_000_000);
  });

  it("sets the sanity bound well above the memory ceiling", () => {
    // If the two were equal the disk path could never accept a large file,
    // which is exactly the wall this replaced.
    assert.ok(MAX_DECLARED_BYTES > MAX_TRANSFER_BYTES * 10);
  });

  it("refuses a size the memory sink cannot hold", async () => {
    // This environment has no OPFS, so the memory path is taken and the guard
    // must fire rather than allocating the whole file.
    await assert.rejects(
      () => createSink("oversize", MAX_TRANSFER_BYTES + 1),
      /cannot stream to disk/i,
    );
  });
});
