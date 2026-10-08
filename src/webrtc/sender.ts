/**
 * WebRTC sender: streams the selected file over the DataChannel with 64 KiB
 * chunks, backpressure handling, progress reporting and cancel support.
 *
 * The same pipeline also serves resume.  After a dropped connection the sender
 * reconnects on a fresh channel and calls `resumeStream`, which waits for the
 * receiver to say which byte ranges it still needs and then slices only those
 * — the bytes already stored are never sent twice.
 */
import {
  BACKPRESSURE_THRESHOLD,
  CHUNK_SIZE,
  COMPRESSION_PROBE_BYTES,
  COMPRESSION_WORTH_IT_RATIO,
  deserializeMessage,
  encodeChunk,
  PROGRESS_INTERVAL_MS,
  PROTOCOL_VERSION,
  READ_AHEAD_CHUNKS,
  RESUME_HANDSHAKE_TIMEOUT_MS,
  RESUME_PROBE_MS,
  serializeMessage,
} from "./protocol.ts";
import { compressionAvailable, deflateChunk } from "./compress.ts";
import { sha256Bytes } from "./checksum.ts";
import type { ChunkRange, ControlMessage, TransferChannel, TransferId } from "./types.ts";

export interface SenderOptions {
  onStatus?: (status: string) => void;
  onProgress?: (bytesSent: number, total: number) => void;
  onComplete?: () => void;
  onCancelled?: (reason: string) => void;
  onError?: (message: string) => void;
  /** The channel went away mid-file; call `resumeStream` on a new one. */
  onInterrupted?: () => void;
}

export class DataSender {
  private readonly transferId: TransferId;
  private readonly channel: TransferChannel;
  private readonly file: File;
  private readonly options: SenderOptions;

  /**
   * Bytes that are accounted for in the current file, counting both what this
   * session sent and what an earlier session already delivered. This is what
   * `bytesSent` reports, so the progress bar never jumps backwards when a
   * resume sends only the missing tail.
   */
  private sent = 0;
  /**
   * Payload bytes actually handed to the channel.
   *
   * Equal to `sent` while compression is off; smaller once it engages, which is
   * the only honest way to report what the link carried.
   */
  private wire = 0;
  private packedChunks = 0;
  /**
   * Whether compressing this file is still worth doing.
   *
   * Starts on when the browser supports it, and is switched off for good once
   * the probe has seen enough of the file to know it will not compress — see
   * `COMPRESSION_PROBE_BYTES`.
   */
  private compressing = compressionAvailable();
  private probeOriginal = 0;
  private probePacked = 0;
  private lastProgressAt = 0;
  private cancelled = false;
  private closed = false;
  private _interrupted = false;
  private _completed = false;
  /**
   * The verdict the receiver sent back when it could not store the file.
   *
   * Non-null means the transfer is over no matter how much of the file is
   * still unsent: the other side is refusing or discarding the bytes.
   */
  private _receiverError: string | null = null;

  constructor(
    transferId: TransferId,
    channel: TransferChannel,
    file: File,
    options: SenderOptions = {},
  ) {
    this.transferId = transferId;
    this.channel = channel;
    this.file = file;
    this.options = options;

    // A closed channel is the signal that the file did not make it: sends stop
    // being delivered, and the receiver is the only side that can say what is
    // missing, so the sender has to notice and rebuild the connection.
    const previousClose = channel.onclose;
    channel.onclose = (event: Event) => {
      previousClose?.call(channel, event);
      this.closed = true;
    };

    // The receiver is the side that decides whether the file was stored, so its
    // verdicts have to be heard while the stream is still running. A refusal
    // that only reached the other browser's screen would leave this side
    // reporting a delivery that never happened.
    const previousMessage = channel.onmessage;
    channel.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      previousMessage?.call(channel, event);
      this.handleControlFrame(event.data);
    };
  }

  public get bytesSent(): number {
    return this.sent;
  }

  /** Payload bytes the channel carried, which is below `bytesSent` when compression engaged. */
  public get wireBytes(): number {
    return this.wire;
  }

  /** True once at least one chunk went out compressed. */
  public get usedCompression(): boolean {
    return this.packedChunks > 0;
  }

  public get isCancelled(): boolean {
    return this.cancelled;
  }

  /** The channel dropped before the completion marker was sent. */
  public get interrupted(): boolean {
    return this._interrupted;
  }

  /** Every chunk and the completion marker were handed to the channel. */
  public get completed(): boolean {
    return this._completed;
  }

  /**
   * The receiver said it could not store the file.
   *
   * Terminal: unlike a drop, another negotiation round cannot help, because the
   * problem is on the far side of the connection rather than in it.
   */
  public get failed(): boolean {
    return this._receiverError !== null;
  }

  /** Request cancellation; an in-flight `sendFile` stops at the next chunk. */
  public cancel(reason = "User cancelled"): void {
    if (this.cancelled) return;
    this.cancelled = true;
    try {
      const msg: ControlMessage = { type: "cancelled", reason };
      this.channel.send(serializeMessage(msg));
    } catch {
      // Channel already gone; cancellation still stands.
    }
    this.options.onCancelled?.(reason);
    this.options.onStatus?.("cancelled");
  }

  /**
   * Send the whole file.  Resolves once every chunk and the completion marker
   * have been handed to the DataChannel (or when cancelled/interrupted).
   */
  public async sendFile(): Promise<void> {
    if (!this.file) {
      this.options.onError?.("No file selected");
      return;
    }
    try {
      await this.transmit(undefined);
    } catch (err: unknown) {
      this.failSend(err);
    }
  }

  /**
   * Resume a file the receiver partly holds.
   *
   * The receiver publishes the gaps after the drop and answers our
   * `resume-ready` probe with them, so the sender never has to guess what is
   * missing. If the request does not arrive the outcome is another
   * interruption, not a failure: the signaling layer may still be able to
   * rebuild the connection once more.
   */
  public async resumeStream(timeoutMs = RESUME_HANDSHAKE_TIMEOUT_MS): Promise<void> {
    if (this.cancelled || this._completed || this.failed) return;
    try {
      const ranges = await this.waitForResumeRequest(timeoutMs);
      if (this.cancelled) {
        this.options.onStatus?.("cancelled");
        return;
      }
      if (!ranges) {
        this.markInterrupted();
        return;
      }
      await this.transmit(ranges);
    } catch (err: unknown) {
      this.failSend(err);
    }
  }

  /** Frame and push one set of ranges; `undefined` means the whole file. */
  private async transmit(ranges: readonly ChunkRange[] | undefined): Promise<void> {
    const file = this.file;
    const marker: ControlMessage = ranges
      ? { type: "file-resume", ranges: [...ranges] }
      : {
          type: "file-start",
          protocol: PROTOCOL_VERSION,
          name: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          chunkSize: CHUNK_SIZE,
        };

    if (ranges) {
      // Progress counts what is genuinely left, not merely this session's
      // bytes, so resuming a nearly-finished file starts near 100%.
      this.sent = file.size - this.coverage(ranges);
    }

    this.channel.send(serializeMessage(marker));
    this.options.onStatus?.("transferring");

    // Ask the channel to wake us at the threshold rather than being polled.
    if ("bufferedAmountLowThreshold" in this.channel) {
      this.channel.bufferedAmountLowThreshold = BACKPRESSURE_THRESHOLD;
    }

    const outcome = await this.streamChunks(ranges);
    if (outcome === "cancelled") {
      this.options.onStatus?.("cancelled");
      return;
    }
    if (outcome === "receiver-failed") {
      // The frame handler has already reported it. Sending the completion
      // marker, or any further chunk, would be telling a receiver that has
      // stopped accepting that it received something.
      return;
    }
    if (outcome === "dropped") {
      this.markInterrupted();
      return;
    }

    // A file smaller than one chunk never entered the loop; make sure the bar
    // still arrives at 100%.
    this.reportProgress(true);

    const complete: ControlMessage = { type: "file-complete" };
    this.channel.send(serializeMessage(complete));
    this._completed = true;
    this.options.onComplete?.();
    this.options.onStatus?.("completed");
  }

  /**
   * Stream every chunk covered by `ranges` (or the whole file), reading ahead
   * of the send loop so a disk read overlaps the previous chunk's trip through
   * the channel.
   */
  private async streamChunks(
    ranges?: readonly ChunkRange[],
  ): Promise<"done" | "cancelled" | "dropped" | "receiver-failed"> {
    const pending: Promise<{
      offset: number;
      buffer: ArrayBuffer;
      digest: Uint8Array;
      wire: Uint8Array;
      deflated: boolean;
    }>[] = [];
    const chunks = this.chunksIn(ranges);

    const topUp = (): void => {
      while (pending.length < READ_AHEAD_CHUNKS) {
        const next = chunks.next();
        if (next.done) break;
        const { offset, end } = next.value;
        const read = this.file
          .slice(offset, end)
          .arrayBuffer()
          .then(async (buffer) => {
            // Digested inside the read-ahead window, so the hash overlaps the
            // previous chunk's trip through the channel rather than delaying
            // it. This is also why there is no separate pass over the file
            // before the transfer starts. The digest covers the bytes as they
            // exist in the file, never the compressed form, so the receiver's
            // check still describes what it ends up storing.
            const digest = await sha256Bytes(buffer);
            const packed = await this.packChunk(new Uint8Array(buffer));
            return {
              offset,
              buffer,
              digest,
              wire: packed ?? new Uint8Array(buffer),
              deflated: packed !== null,
            };
          });
        // Cancelling early would leave the tail of the pipeline rejected with
        // nothing listening, which surfaces as an unhandled rejection.
        read.catch(() => {});
        pending.push(read);
      }
    };

    topUp();
    while (pending.length > 0) {
      if (this.cancelled) return "cancelled";
      if (this.failed) return "receiver-failed";
      if (!this.channelAlive()) return "dropped";

      const { offset, buffer, digest, wire, deflated } = await pending.shift()!;

      await this.waitForSpace();
      if (this.cancelled) return "cancelled";
      if (this.failed) return "receiver-failed";
      if (!this.channelAlive()) return "dropped";

      try {
        this.channel.send(encodeChunk(offset, wire, digest, deflated));
      } catch {
        // A send onto a channel that has gone away is a drop, not a bug.
        return "dropped";
      }
      // Progress stays in file terms so the bar, the rate and the estimate all
      // describe the file rather than the wire; `wire` is what actually moved.
      this.sent += buffer.byteLength;
      this.wire += wire.byteLength;
      this.reportProgress();
      topUp();
    }
    return "done";
  }

  /**
   * Compress one chunk, when that is still worth doing for this file.
   *
   * The first `COMPRESSION_PROBE_BYTES` are always attempted: whether deflate
   * helps is a property of the payload and the only way to know is to try. Once
   * the probe has enough evidence that it does not, compression is switched off
   * for the rest of the file, so a ROM zip or a video does not pay tens of
   * seconds of deflate per gigabyte on both devices to save nothing.
   */
  private async packChunk(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array | null> {
    if (!this.compressing) return null;

    const packed = await deflateChunk(data);
    if (packed !== null) this.packedChunks += 1;

    this.probeOriginal += data.byteLength;
    this.probePacked += (packed ?? data).byteLength;
    if (
      this.probeOriginal >= COMPRESSION_PROBE_BYTES &&
      this.probePacked / this.probeOriginal > COMPRESSION_WORTH_IT_RATIO
    ) {
      this.compressing = false;
    }
    return packed;
  }

  /**
   * The chunk descriptors for the whole file, or for the requested ranges.
   *
   * Ranges are clamped to the file so a garbled request can never read past the
   * end or stall the loop on an empty span.
   */
  private *chunksIn(
    ranges?: readonly ChunkRange[],
  ): Generator<{ offset: number; end: number }> {
    const size = this.file.size;
    if (!ranges) {
      for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
        yield { offset, end: Math.min(offset + CHUNK_SIZE, size) };
      }
      return;
    }

    for (const range of ranges) {
      const start = Math.max(0, Math.min(range.offset, size));
      const stop = Math.max(start, Math.min(range.offset + range.length, size));
      for (let offset = start; offset < stop; offset += CHUNK_SIZE) {
        yield { offset, end: Math.min(offset + CHUNK_SIZE, stop) };
      }
    }
  }

  /** Bytes of the file covered by `ranges`, after clamping. */
  private coverage(ranges: readonly ChunkRange[]): number {
    let covered = 0;
    for (const { offset, end } of this.chunksIn(ranges)) covered += end - offset;
    return covered;
  }

  /**
   * Wait for the receiver to answer `resume-ready` with the ranges it needs.
   *
   * The probe repeats while we wait: on a freshly negotiated channel the first
   * announcement can arrive before the receiver has attached its handler, and
   * the receiver answers every probe, so a lost one costs one interval.
   */
  private waitForResumeRequest(timeoutMs: number): Promise<ChunkRange[] | null> {
    const channel = this.channel;
    return new Promise((resolve) => {
      let settled = false;
      let probe: ReturnType<typeof setInterval> | undefined;
      const previousMessage = channel.onmessage;
      const previousClose = channel.onclose;

      const finish = (ranges: ChunkRange[] | null): void => {
        if (settled) return;
        settled = true;
        if (probe !== undefined) clearInterval(probe);
        clearTimeout(timer);
        channel.onmessage = previousMessage;
        channel.onclose = previousClose;
        resolve(ranges);
      };

      channel.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        // Keep the constructor's handler in the chain: a receiver failure can
        // arrive during the handshake, and dropping it would hide the reason
        // this round is about to be abandoned.
        previousMessage?.call(channel, event);
        if (typeof event.data !== "string") return;
        let msg: ControlMessage;
        try {
          msg = deserializeMessage(event.data);
        } catch {
          return;
        }
        if (msg.type === "resume-request") {
          finish(Array.isArray(msg.ranges) ? msg.ranges : []);
        } else if (msg.type === "cancelled") {
          this.cancelled = true;
          finish(null);
        }
      };
      channel.onclose = (event: Event) => {
        previousClose?.call(channel, event);
        this.closed = true;
        finish(null);
      };

      const announce = (): void => {
        try {
          channel.send(serializeMessage({ type: "resume-ready" }));
        } catch {
          // The close handler will settle us; nothing else to do here.
        }
      };

      const timer = setTimeout(() => finish(null), timeoutMs);
      announce();
      probe = setInterval(() => {
        if (this.cancelled || !this.channelAlive()) {
          finish(null);
          return;
        }
        announce();
      }, RESUME_PROBE_MS);
    });
  }

  /** True while the channel can still carry frames. */
  private channelAlive(): boolean {
    return !this.closed && this.channel.readyState === "open";
  }

  private markInterrupted(): void {
    this._interrupted = true;
    this.options.onInterrupted?.();
    this.options.onStatus?.("interrupted");
  }

  /**
   * Act on a verdict from the receiver.
   *
   * Only two frames matter here and both end the transfer: the receiver either
   * cannot store the file, or the person on that side cancelled. Everything else
   * on this channel is the resume handshake's business.
   */
  private handleControlFrame(data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;
    let msg: ControlMessage;
    try {
      msg = deserializeMessage(data);
    } catch {
      return;
    }

    if (msg.type === "error") {
      // Reported here rather than from the send loop: a receiver that fails
      // while sealing the file reports after the last chunk was handed over,
      // when nothing is waiting on the loop any more.
      if (this._receiverError !== null) return;
      this._receiverError = msg.message;
      this.options.onError?.(msg.message);
      this.options.onStatus?.("failed");
      return;
    }

    if (msg.type === "cancelled") {
      if (this.cancelled) return;
      this.cancelled = true;
      this.options.onCancelled?.(msg.reason);
      this.options.onStatus?.("cancelled");
    }
  }

  private failSend(err: unknown): void {
    if (this.cancelled) {
      this.options.onStatus?.("cancelled");
      return;
    }
    if (!this.channelAlive()) {
      this.markInterrupted();
      return;
    }
    this.options.onError?.(
      `Send failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    this.options.onStatus?.("failed");
  }

  /**
   * Wait until the channel drains below the threshold.
   *
   * The `bufferedamountlow` event is the fast path: polling every 20 ms can
   * idle the sender for that long on each stall. The interval stays as a safety
   * net, and is the only path on a channel that does not expose the event. It
   * also wakes us when the channel dies, so a drop cannot deadlock the loop.
   */
  private waitForSpace(): Promise<void> {
    const channel = this.channel;
    if (this.cancelled || !this.channelAlive()) return Promise.resolve();
    if (channel.bufferedAmount <= BACKPRESSURE_THRESHOLD) return Promise.resolve();

    return new Promise((resolve) => {
      const previous = channel.onbufferedamountlow;
      let poll: ReturnType<typeof setInterval> | undefined;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (poll !== undefined) clearInterval(poll);
        channel.onbufferedamountlow = previous;
        resolve();
      };
      if ("onbufferedamountlow" in channel) channel.onbufferedamountlow = () => finish();
      poll = setInterval(() => {
        if (this.cancelled || !this.channelAlive()) finish();
        else if (channel.bufferedAmount <= BACKPRESSURE_THRESHOLD) finish();
      }, 20);
    });
  }

  /**
   * Report progress, coalesced to `PROGRESS_INTERVAL_MS`.
   *
   * `force` (or reaching the end) always emits, so the consumer still receives
   * a final 100% even when the whole file went out inside one interval.
   */
  private reportProgress(force = false): void {
    const total = this.file.size;
    const now = Date.now();
    if (!force && this.sent < total && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) {
      return;
    }
    this.lastProgressAt = now;
    this.options.onProgress?.(Math.min(this.sent, total), total);
  }
}
