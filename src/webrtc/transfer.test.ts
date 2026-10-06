import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DataReceiver } from "./receiver.ts";
import { DataSender } from "./sender.ts";
import { sha256Bytes } from "./checksum.ts";
import {
  CHUNK_HEADER_BYTES,
  CHUNK_SIZE,
  encodeChunk,
  MAX_DECLARED_BYTES,
  READ_AHEAD_CHUNKS,
  totalBytes,
} from "./protocol.ts";
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

/**
 * Frame one slice of a source array the way the sender does. Tests that feed a
 * receiver by hand still have to produce authentic frames, because a chunk that
 * does not match its own digest is refused (see the mismatch test below).
 */
async function frameSlice(
  source: Uint8Array,
  offset: number,
  length: number,
): Promise<ArrayBuffer> {
  const payload = source.slice(offset, offset + length);
  const data = payload.buffer as ArrayBuffer;
  return encodeChunk(offset, data, await sha256Bytes(data));
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

  it("refuses a size the sink cannot hold", async () => {
    const [out, back] = makeChannelPair();
    const errors: string[] = [];
    new DataReceiver("cap", back, { onError: (e) => errors.push(e) });
    // 2 GB is a legal declaration now, but this environment has no OPFS, so the
    // memory sink is chosen and it must refuse before allocating 2 GB.
    out.send(JSON.stringify({
      type: "file-start",
      name: "huge.bin",
      size: 2 * 1024 * 1024 * 1024,
      mime: "application/octet-stream",
      chunkSize: CHUNK_SIZE,
    }));
    await waitFor(() => (errors.length ? errors : null));
    assert.match(errors[0], /cannot stream to disk/i);
  });

  it("refuses a declaration past the absolute sanity bound", async () => {
    const [out, back] = makeChannelPair();
    const errors: string[] = [];
    new DataReceiver("absurd", back, { onError: (e) => errors.push(e) });
    out.send(JSON.stringify({
      type: "file-start",
      name: "absurd.bin",
      size: MAX_DECLARED_BYTES + 1,
      mime: "application/octet-stream",
      chunkSize: CHUNK_SIZE,
    }));
    await waitFor(() => (errors.length ? errors : null));
    assert.match(errors[0], /invalid file size/i);
  });

  it("stays in order with reads running ahead of the send loop", async () => {
    const [out, back] = makeChannelPair();
    // Deeper than the read-ahead window, so the pipeline is genuinely filled
    // and the chunks are read concurrently rather than one at a time.
    const chunks = READ_AHEAD_CHUNKS + 5;
    const size = CHUNK_SIZE * chunks;
    const source = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) source[i] = (i * 7) % 251;
    const file = makeFile("pipeline.bin", source);

    let blob: Blob | null = null;
    new DataReceiver("pipeline", back, { onComplete: (b) => { blob = b; } });

    await new DataSender("pipeline", out, file, {}).sendFile();
    const finished = await waitFor(() => blob);
    const bytes = new Uint8Array(await finished.arrayBuffer());
    assert.equal(bytes.byteLength, size);
    assert.ok(bytes.every((value, i) => value === source[i]), "pipelined chunks landed out of order");
  });

  it("coalesces progress instead of reporting once per chunk", async () => {
    const [, back] = makeChannelPair();
    const chunks = 200;
    const size = CHUNK_SIZE * chunks;
    let blob: Blob | null = null;
    const progress: number[] = [];
    new DataReceiver("coalesce", back, {
      onProgress: (got) => progress.push(got),
      onComplete: (b) => { blob = b; },
    });

    // Every frame in one tick: without coalescing this is exactly 200 reports.
    const deliver = (data: string | ArrayBuffer): void => {
      back.onmessage?.(new MessageEvent("message", { data }));
    };
    deliver(JSON.stringify({
      type: "file-start",
      name: "coalesce.bin",
      size,
      mime: "application/octet-stream",
      chunkSize: CHUNK_SIZE,
    }));
    // One payload and one digest, re-framed per offset: the frames still verify.
    const payload = new ArrayBuffer(CHUNK_SIZE);
    const digest = await sha256Bytes(payload);
    for (let i = 0; i < chunks; i += 1) {
      deliver(encodeChunk(i * CHUNK_SIZE, payload, digest));
    }
    deliver(JSON.stringify({ type: "file-complete" }));

    await waitFor(() => blob);
    assert.ok(progress.length <= 5, `expected a handful of reports, got ${progress.length}`);
    assert.equal(progress.at(-1), size);
    assert.ok(progress.every((value, i) => i === 0 || value >= progress[i - 1]));
  });

  it("reports an interruption rather than an error when the channel dies", async () => {
    const [out, back] = makeChannelPair();
    void back;
    const file = makeFile("drop.bin", new Uint8Array(CHUNK_SIZE * 4));

    // The second frame cannot be sent: a realistic way for a dropped channel to
    // surface, without depending on how far the reads got.
    let frames = 0;
    const realSend = out.send.bind(out);
    out.send = (data: string | ArrayBuffer) => {
      if (typeof data !== "string") {
        frames += 1;
        if (frames > 1) {
          out.readyState = "closed";
          throw new Error("DataChannel is closing");
        }
      }
      realSend(data);
    };

    let interrupted = 0;
    const errors: string[] = [];
    const sender = new DataSender("drop", out, file, {
      onInterrupted: () => { interrupted += 1; },
      onError: (e) => errors.push(e),
    });

    await sender.sendFile();

    assert.equal(interrupted, 1);
    assert.ok(sender.interrupted);
    assert.ok(!sender.completed);
    assert.deepEqual(errors, []);
    assert.ok(sender.bytesSent < file.size);
  });

  it("re-sends only the missing ranges after a drop", async () => {
    const size = CHUNK_SIZE * 6 + 100;
    const source = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) source[i] = (i * 13) % 251;
    const file = makeFile("resume.bin", source);

    // ── Round 1: two chunks land, then the connection goes away ──────────
    const [out1, back1] = makeChannelPair();
    void out1;
    let blob: Blob | null = null;
    const receiver = new DataReceiver("resume", back1, {
      onComplete: (b) => { blob = b; },
    });

    const deliver = (data: string | ArrayBuffer): void => {
      back1.onmessage?.(new MessageEvent("message", { data }));
    };
    deliver(JSON.stringify({
      type: "file-start",
      name: "resume.bin",
      size,
      mime: "application/octet-stream",
      chunkSize: CHUNK_SIZE,
    }));
    // Chunks 0, 1 and 3 arrive; 2 and the tail (4, 5, 6) are still missing.
    for (const index of [0, 1, 3]) {
      deliver(await frameSlice(source, index * CHUNK_SIZE, CHUNK_SIZE));
    }

    const interruption = receiver.waitForInterruption();
    back1.readyState = "closed";
    back1.onclose?.(new Event("close"));

    const missing = await interruption;
    assert.ok(missing, "the drop was not reported");
    // Coalesced: one lone chunk, then the contiguous tail.
    assert.deepEqual(missing, [
      { offset: CHUNK_SIZE * 2, length: CHUNK_SIZE },
      { offset: CHUNK_SIZE * 4, length: CHUNK_SIZE * 2 + 100 },
    ]);
    const missingBytes = totalBytes(missing);
    assert.equal(receiver.bytesReceived, CHUNK_SIZE * 3);

    // ── Round 2: a fresh channel, and only the gaps cross it ─────────────
    const [out2, back2] = makeChannelPair();
    const frames: number[] = [];
    const senderSend = out2.send.bind(out2);
    out2.send = (data: string | ArrayBuffer) => {
      if (typeof data !== "string") frames.push((data as ArrayBuffer).byteLength);
      senderSend(data);
    };

    receiver.attach(back2);
    const sender = new DataSender("resume", out2, file, {});
    await sender.resumeStream(2000);

    const finished = await waitFor(() => blob);
    const bytes = new Uint8Array(await finished.arrayBuffer());
    assert.equal(bytes.byteLength, size);
    assert.ok(
      bytes.every((value, i) => value === source[i]),
      "the resumed file differs from the source",
    );
    assert.equal(receiver.bytesReceived, size);
    assert.ok(sender.completed);

    // Four chunk frames — the four missing ones — not the whole file.
    assert.equal(frames.length, 4);
    // Payload plus one offset/digest header per re-sent chunk.
    assert.equal(
      frames.reduce((sum, length) => sum + length, 0),
      missingBytes + 4 * CHUNK_HEADER_BYTES,
    );
  });

  it("ignores a close from a channel it has already moved past", async () => {
    const size = CHUNK_SIZE * 4;
    const source = new Uint8Array(size).fill(9);
    const [out1, back1] = makeChannelPair();
    void out1;
    const receiver = new DataReceiver("stale", back1, {});
    back1.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({
        type: "file-start",
        name: "stale.bin",
        size,
        mime: "application/octet-stream",
        chunkSize: CHUNK_SIZE,
      }),
    }));
    back1.onmessage?.(new MessageEvent("message", {
      data: await frameSlice(source, 0, CHUNK_SIZE),
    }));

    // The receiver has moved on to a fresh channel before the old one's close
    // event is delivered, which is exactly what a resume round looks like.
    const [, back2] = makeChannelPair();
    receiver.attach(back2);
    back1.onclose?.(new Event("close"));

    const outcome = await Promise.race([
      receiver.waitForInterruption().then(() => "reported"),
      new Promise<string>((resolve) => setTimeout(() => resolve("quiet"), 25)),
    ]);
    assert.equal(outcome, "quiet");
  });

  it("counts bytes an earlier session delivered in resume progress", async () => {
    const size = CHUNK_SIZE * 3 + 100;
    const source = new Uint8Array(size).fill(5);
    const file = makeFile("tail.bin", source);

    const [out1, back1] = makeChannelPair();
    void out1;
    let blob: Blob | null = null;
    const receiver = new DataReceiver("tail", back1, {
      onComplete: (b) => { blob = b; },
    });
    const deliver = (data: string | ArrayBuffer): void => {
      back1.onmessage?.(new MessageEvent("message", { data }));
    };
    deliver(JSON.stringify({
      type: "file-start",
      name: "tail.bin",
      size,
      mime: "application/octet-stream",
      chunkSize: CHUNK_SIZE,
    }));
    // Only the first chunk landed, so two full chunks and the ragged tail are
    // still missing: enough that the resumed progress has to start above zero.
    deliver(await frameSlice(source, 0, CHUNK_SIZE));

    const interruption = receiver.waitForInterruption();
    back1.readyState = "closed";
    back1.onclose?.(new Event("close"));
    assert.deepEqual(await interruption, [
      { offset: CHUNK_SIZE, length: CHUNK_SIZE * 2 + 100 },
    ]);

    const [out2, back2] = makeChannelPair();
    receiver.attach(back2);
    const progress: number[] = [];
    const sender = new DataSender("tail", out2, file, {
      onProgress: (sent) => progress.push(sent),
    });
    await sender.resumeStream(2000);

    await waitFor(() => blob);
    // The bar resumes at the byte already accounted for, not at zero: the
    // first report is the earlier chunk plus this session's first one.
    assert.equal(progress[0], CHUNK_SIZE * 2);
    assert.ok(progress[0] < size);
    assert.equal(progress.at(-1), size);
  });

  it("stops when a chunk does not match the digest it arrived with", async () => {
    const size = CHUNK_SIZE * 2;
    const source = new Uint8Array(size).fill(3);
    const [out, back] = makeChannelPair();
    void out;

    const errors: string[] = [];
    let blob: Blob | null = null;
    const receiver = new DataReceiver("corrupt", back, {
      onError: (e) => errors.push(e),
      onComplete: (b) => { blob = b; },
    });

    back.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({
        type: "file-start",
        name: "corrupt.bin",
        size,
        mime: "application/octet-stream",
        chunkSize: CHUNK_SIZE,
      }),
    }));
    // Chunk 0 is intact; chunk 1's payload is altered in flight while the
    // digest computed for the original bytes still rides along with it.
    back.onmessage?.(new MessageEvent("message", { data: await frameSlice(source, 0, CHUNK_SIZE) }));
    const goodPayload = source.slice(CHUNK_SIZE, CHUNK_SIZE * 2);
    const digest = await sha256Bytes(goodPayload.buffer as ArrayBuffer);
    const altered = goodPayload.slice();
    altered[0] ^= 0xff;
    back.onmessage?.(new MessageEvent("message", {
      data: encodeChunk(CHUNK_SIZE, altered.buffer as ArrayBuffer, digest),
    }));
    back.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({ type: "file-complete" }),
    }));

    await waitFor(() => (errors.length ? errors : null));
    assert.match(errors[0], /byte 65536/);
    assert.match(errors[0], /did not match its checksum/);
    // The corrupt file is never handed over as a finished download.
    assert.equal(blob, null);
    assert.ok(receiver.bytesReceived < size);
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
