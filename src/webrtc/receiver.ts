/**
 * WebRTC receiver: writes incoming chunks straight to their offset in a sink
 * (disk when available, memory otherwise) and hands the finished file back.
 *
 * Two things are deliberate here:
 *   - The file is never buffered twice.  Chunks land at their final offset and
 *     completion is a counter comparison, not a scan over every offset.
 *   - Writes are chained, so a slow-disk sink cannot reorder or drop a chunk.
 */
import {
  decodeChunk,
  deserializeMessage,
  serializeMessage,
} from "./protocol.ts";
import { createSink, MAX_TRANSFER_BYTES, type TransferSink } from "./sink.ts";

type SinkFactory = (entryName: string, totalSize: number) => Promise<TransferSink>;
import type { ControlMessage, TransferChannel, TransferId } from "./types.ts";
import { CHUNK_SIZE } from "./protocol.ts";

export interface ReceiverOptions {
  onStatus?: (status: string) => void;
  onProgress?: (bytesReceived: number, total: number) => void;
  onComplete?: (file: Blob, name: string) => void;
  onCancelled?: (reason: string) => void;
  onError?: (message: string) => void;
  onFileStart?: (name: string, size: number, mime: string) => void;
  /** The reassembled file was compared against this digest, when provided. */
  expectedChecksum?: string;
  onVerified?: (ok: boolean, actual: string, expected?: string) => void;
  /** Override the sink, mainly so tests can simulate a slow disk. */
  sinkFactory?: SinkFactory;
}

export class DataReceiver {
  private readonly transferId: TransferId;
  private readonly channel: TransferChannel;
  private readonly options: ReceiverOptions;

  private sinkPromise: Promise<TransferSink> | null = null;
  /** Serialises sink writes so out-of-order frames cannot corrupt the file. */
  private writes: Promise<void> = Promise.resolve();

  private readonly seen = new Set<number>();
  private totalSize = 0;
  private totalChunks = 0;
  private received = 0;
  private fileName = "transfer.bin";
  private mime = "application/octet-stream";
  private complete = false;
  private _cancelled = false;

  constructor(
    transferId: TransferId,
    channel: TransferChannel,
    options: ReceiverOptions = {},
  ) {
    this.transferId = transferId;
    this.channel = channel;
    this.options = options;

    this.channel.binaryType = "arraybuffer";
    this.channel.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      this.handleFrame(event.data);
    };
  }

  public get cancelled(): boolean {
    return this._cancelled;
  }

  public get bytesReceived(): number {
    return this.received;
  }

  /** Ask the sender to stop, then tear down the channel. */
  public cancel(reason = "User cancelled"): void {
    if (this._cancelled) return;
    this._cancelled = true;
    try {
      this.channel.send(serializeMessage({ type: "cancelled", reason }));
    } catch {
      // The channel may already be closed; cancelling is still successful.
    }
    this.options.onCancelled?.(reason);
    this.options.onStatus?.("cancelled");
    this.channel.close();
  }

  /** Release the sink. Safe to call once the download has finished. */
  public async dispose(): Promise<void> {
    const sink = this.sinkPromise ? await this.sinkPromise.catch(() => null) : null;
    await sink?.dispose();
  }

  /** A binary frame is a file chunk; a text frame is a control message. */
  private handleFrame(frame: string | ArrayBuffer | Blob): void {
    if (this._cancelled || this.complete) return;

    if (typeof frame !== "string") {
      if (!(frame instanceof ArrayBuffer)) return;
      this.handleChunk(frame);
      return;
    }

    let msg: ControlMessage;
    try {
      msg = deserializeMessage(frame);
    } catch {
      this.options.onError?.("Malformed message from sender");
      return;
    }

    switch (msg.type) {
      case "file-start":
        this.startFile(msg);
        break;

      case "file-complete":
        // Defer behind the queued writes: the last chunk's write may still be
        // in flight, and it has to be counted before we can judge completeness.
        this.writes = this.writes.then(() => this.completeIfDone(true));
        break;

      case "cancelled":
        this._cancelled = true;
        this.options.onCancelled?.(msg.reason);
        this.options.onStatus?.("cancelled");
        break;

      case "error":
        this.options.onError?.(msg.message);
        break;
    }
  }

  private startFile(msg: Extract<ControlMessage, { type: "file-start" }>): void {
    if (
      !Number.isFinite(msg.size) ||
      msg.size <= 0 ||
      msg.size > MAX_TRANSFER_BYTES
    ) {
      this.options.onError?.(`Refusing an invalid file size (${msg.size} bytes)`);
      this.options.onStatus?.("failed");
      return;
    }

    this.totalSize = msg.size;
    this.totalChunks = Math.ceil(msg.size / CHUNK_SIZE);
    this.fileName = msg.name || "transfer.bin";
    this.mime = msg.mime || "application/octet-stream";
    this.seen.clear();
    this.received = 0;
    this.complete = false;
    this.writes = Promise.resolve();
    const makeSink = this.options.sinkFactory ?? createSink;
    this.sinkPromise = makeSink(`${this.transferId}-${Date.now()}`, msg.size);

    this.options.onFileStart?.(this.fileName, msg.size, this.mime);
  }

  private handleChunk(frame: ArrayBuffer): void {
    let offset: number;
    let data: Uint8Array;
    try {
      ({ offset, data } = decodeChunk(frame));
    } catch {
      this.options.onError?.("Malformed chunk frame from sender");
      return;
    }

    // Chain the write: a sink that resolves asynchronously must not interleave.
    this.writes = this.writes
      .then(async () => {
        const sink = this.sinkPromise ? await this.sinkPromise : null;
        if (!sink || this._cancelled) return;
        await sink.write(offset, data);

        if (!this.seen.has(offset)) {
          this.seen.add(offset);
          this.received += data.byteLength;
          this.options.onProgress?.(this.received, this.totalSize);
        }
        this.completeIfDone();
      })
      .catch((err: unknown) => {
        this.options.onError?.(
          `Could not store a chunk: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.options.onStatus?.("failed");
      });
  }

  /**
   * Completion is a set-size comparison, so it costs the same whether the file
   * is 64 KiB or 1 GiB.  `forced` also accepts a completion marker whose chunks
   * all arrived (the marker is what the sender commits to).
   */
  private completeIfDone(forced = false): void {
    if (this.complete) return;
    const allSeen = this.totalChunks > 0 && this.seen.size >= this.totalChunks;
    if (!allSeen) {
      if (forced) {
        this.options.onError?.(
          `Transfer ended with ${this.totalChunks - this.seen.size} chunk(s) missing`,
        );
        this.options.onStatus?.("failed");
      }
      return;
    }
    this.complete = true;
    // Surface a finalise failure rather than hanging: a swallowed error here
    // would leave the transfer stuck with no explanation.
    this.writes = this.writes.then(() => this.finalise()).catch((err: unknown) => {
      this.options.onError?.(
        `Could not finish the transfer: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.options.onStatus?.("failed");
    });
  }

  private async finalise(): Promise<void> {
    const sink = this.sinkPromise ? await this.sinkPromise : null;
    if (!sink) return;

    const [blob, actual] = await Promise.all([sink.finish(), sink.digest()]);
    const expected = this.options.expectedChecksum;
    const ok = expected ? actual === expected : true;
    this.options.onVerified?.(ok, actual, expected);

    if (!ok) {
      this.options.onError?.(
        "The received file failed its integrity check and was not saved.",
      );
      this.options.onStatus?.("failed");
      await sink.dispose();
      return;
    }

    this.options.onProgress?.(this.totalSize, this.totalSize);
    this.options.onStatus?.("completed");
    this.options.onComplete?.(blob, this.fileName);
  }
}
