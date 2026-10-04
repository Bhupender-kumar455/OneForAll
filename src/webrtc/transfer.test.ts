import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DataReceiver } from "./receiver.ts";
import { DataSender } from "./sender.ts";
import { CHUNK_SIZE } from "./protocol.ts";
import { createSink, type TransferSink } from "./sink.ts";
import type { TransferChannel } from "./types.ts";

/** Wrap the real sink so every write resolves on a later macrotask. */
function slowSink(delayMs: number) {
  return async (name: string, totalSize: number): Promise<TransferSink> => {
    const inner = await createSink(name, totalSize);
    return {
      kind: inner.kind,
      write: async (offset, data) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        await inner.write(offset, data);
      },
      finish: () => inner.finish(),
      digest: () => inner.digest(),
      dispose: () => inner.dispose(),
    };
  };
}

/**
 * Two stub channels wired to each other, standing in for a WebRTC DataChannel
 * pair.  `send` is delivered synchronously to the peer's `onmessage`, which is
 * stricter than the real (async) channel and therefore a fair smoke test.
 */
function makeChannelPair(): [TransferChannel, TransferChannel] {
  const make = (): TransferChannel => ({
    readyState: "open",
    bufferedAmount: 0,
    binaryType: "arraybuffer",
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(_data: string | ArrayBuffer) {},
    close() {
      this.readyState = "closed";
    },
  });

  const a = make();
  const b = make();
  a.send = (data) => {
    setTimeout(() => b.onmessage?.(new MessageEvent("message", { data })), 0);
  };
  b.send = (data) => {
    setTimeout(() => a.onmessage?.(new MessageEvent("message", { data })), 0);
  };
  return [a, b];
}

function makeFile(name: string, bytes: Uint8Array, type = "application/octet-stream"): File {
  return new File([bytes], name, { type });
}

const waitFor = async <T>(check: () => T | null, timeoutMs = 5000): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value !== null) return value;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("DataSender -> DataReceiver", () => {
  it("delivers a small file byte-for-byte", async () => {
    const [out, back] = makeChannelPair();
    const source = new Uint8Array([...Array(2000)].map((_, i) => i % 256));
    const file = makeFile("small.bin", source);

    let name = "";
    let received: Uint8Array | null = null;
    const receiver = new DataReceiver("t1", back, {
      onFileStart: (fileName) => {
        name = fileName;
      },
      onComplete: (blob) => {
        void blob.arrayBuffer().then((buf) => {
          received = new Uint8Array(buf);
        });
      },
    });

    await new DataSender("t1", out, file, {}).sendFile();
    const done = await waitFor(() => received);
    assert.equal(name, "small.bin");
    assert.equal(receiver.bytesReceived, source.length);
    assert.deepEqual(Array.from(done), Array.from(source));
  });

  it("delivers a file that spans multiple 64 KiB chunks", async () => {
    const [out, back] = makeChannelPair();
    const size = CHUNK_SIZE * 2 + 1234;
    const source = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) source[i] = (i * 31) % 256;
    const file = makeFile("large.bin", source);

    let blob: Blob | null = null;
    const receiver = new DataReceiver("t2", back, {
      onComplete: (b) => {
        blob = b;
      },
    });

    await new DataSender("t2", out, file, {}).sendFile();
    const finished = await waitFor(() => blob);
    const bytes = new Uint8Array(await finished.arrayBuffer());
    assert.equal(bytes.byteLength, size);
    assert.deepEqual(Array.from(bytes), Array.from(source));
  });

  it("reports monotonic progress and the file's metadata", async () => {
    const [out, back] = makeChannelPair();
    const source = new Uint8Array(CHUNK_SIZE + 10).fill(7);
    const file = makeFile("progress.bin", source, "application/octet-stream");

    const progress: number[] = [];
    let metadata: { name: string; size: number; mime: string } | null = null;
    const receiver = new DataReceiver("t3", back, {
      onFileStart: (name, size, mime) => {
        metadata = { name, size, mime };
      },
      onProgress: (got) => progress.push(got),
    });

    await new DataSender("t3", out, file, {}).sendFile();
    await waitFor(() => (receiver.cancelled ? null : progress.at(-1) === source.length ? progress : null));

    assert.deepEqual(metadata, {
      name: "progress.bin",
      size: source.length,
      mime: "application/octet-stream",
    });
    assert.equal(progress.at(-1), source.length);
    assert.ok(progress.every((value, i) => i === 0 || value >= progress[i - 1]));
  });

  it("completes when the sink is slower than the channel", async () => {
    // The last chunk's write is still queued when `file-complete` arrives; a
    // synchronous completeness check would wrongly report a missing chunk.
    const [out, back] = makeChannelPair();
    const size = CHUNK_SIZE * 3;
    const source = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) source[i] = (i * 3) % 256;
    const file = makeFile("slow-sink.bin", source);

    const errors: string[] = [];
    let blob: Blob | null = null;
    const receiver = new DataReceiver("slow", back, {
      onError: (e) => errors.push(e),
      onComplete: (b) => { blob = b; },
      sinkFactory: slowSink(1),
    });

    await new DataSender("slow", out, file, {}).sendFile();
    const finished = await waitFor(() => blob);
    assert.deepEqual(errors, []);
    assert.equal(receiver.bytesReceived, size);
    assert.deepEqual(Array.from(new Uint8Array(await finished.arrayBuffer())), Array.from(source));
  });

  it("refuses a file whose declared size exceeds the cap", async () => {
    const [out, back] = makeChannelPair();
    const errors: string[] = [];
    new DataReceiver("cap", back, { onError: (e) => errors.push(e) });
    // A 2 GB declaration must be rejected before any buffer is allocated.
    out.send(JSON.stringify({
      type: "file-start",
      name: "huge.bin",
      size: 2 * 1024 * 1024 * 1024,
      mime: "application/octet-stream",
      chunkSize: CHUNK_SIZE,
    }));
    await waitFor(() => (errors.length ? errors : null));
    assert.match(errors[0], /invalid file size/i);
  });

  it("lets the sender cancel mid-transfer", async () => {
    const [out, back] = makeChannelPair();
    const file = makeFile("cancel.bin", new Uint8Array(CHUNK_SIZE * 4));
    let cancelled = false;
    const receiver = new DataReceiver("t4", back, { onCancelled: () => { cancelled = true; } });

    const sender = new DataSender("t4", out, file, {});
    const sending = sender.sendFile();
    sender.cancel("changed my mind");
    await sending;

    await waitFor(() => (cancelled || receiver.cancelled ? true : null));
    assert.ok(sender.isCancelled);
    assert.ok(receiver.cancelled);
    assert.ok(receiver.bytesReceived < file.size);
  });
});
