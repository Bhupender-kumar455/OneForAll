/**
 * WebRTC receiver: writes incoming chunks straight to their offset in a sink
 * (disk when available, memory otherwise) and hands the finished file back.
 *
 * Two things are deliberate here:
 *   - The file is never buffered twice.  Chunks land at their final offset and
 *     completion is a counter comparison, not a scan over every offset.
 *   - Writes are chained, so a slow-disk sink cannot reorder or drop a chunk.
 */
import { digestsMatch, sha256Bytes } from "./checksum.ts";
import { inflateChunk } from "./compress.ts";
import {
  CHUNK_SIZE,
  decodeChunk,
  deserializeMessage,
  MAX_DECLARED_BYTES,
  missingRanges,
  PROGRESS_INTERVAL_MS,
  PROTOCOL_VERSION,
  serializeMessage,
} from "./protocol.ts";
import { createSink, type TransferSink } from "./sink.ts";

type SinkFactory = (entryName: string, totalSize: number) => Promise<TransferSink>;
import type {
  ChunkRange,
  ControlMessage,
  TransferChannel,
  TransferId,
} from "./types.ts";

export interface ReceiverOptions {
  onStatus?: (status: string) => void;
  onProgress?: (bytesReceived: number, total: number) => void;
  onComplete?: (file: Blob, name: string) => void;
  onCancelled?: (reason: string) => void;
  onError?: (message: string) => void;
  onFileStart?: (name: string, size: number, mime: string) => void;
  /**
   * Every chunk that arrived matched the digest it was sent with.
   *
   * Called once the file is complete. A chunk that fails is reported through
   * `onError` and stops the transfer, so this only ever fires `false` alongside
   * that failure.
   */
  onVerified?: (ok: boolean) => void;
  /** Override the sink, mainly so tests can simulate a slow disk. */
  sinkFactory?: SinkFactory;
  /** The channel died before the file was complete; `ranges` is what is left. */
  onInterrupted?: (ranges: ChunkRange[]) => void;
}

export class DataReceiver {
  private readonly transferId: TransferId;
  /** Rebound on every resume round by `attach`; the reassembly state persists. */
  private channel: TransferChannel;
  private readonly options: ReceiverOptions;

  /** Ranges a `notifyInterrupted` reported while nobody was waiting for them. */
  private pendingInterruption: ChunkRange[] | null = null;
  private interruptedWaiter: ((ranges: ChunkRange[] | null) => void) | null = null;

  /** Resolves to null when the sink could not be created at all. */
  private sinkPromise: Promise<TransferSink | null> | null = null;
  private lastProgressAt = 0;
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
    this.options = options;
    this.channel = channel;
    this.attach(channel);
  }

  /**
   * Move onto a freshly negotiated channel, keeping everything already
   * stored. This is what makes resume work: `seen`, the sink and the byte
   * counter all survive the reconnect, so the sender is only asked for the
   * ranges that are genuinely absent.
   *
   * Handlers check that the channel they fired on is still the current one, so
   * a late close from the replaced channel cannot trigger a bogus interruption.
   */
  public attach(channel: TransferChannel): void {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    // Any gap reported for the channel being replaced has already been acted
    // on. Its close event can still land after this point, and honouring it
    // would start a second resume round while the first is still streaming.
    this.pendingInterruption = null;

    const previousMessage = channel.onmessage;
    channel.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      previousMessage?.call(channel, event);
      if (this.channel === channel) this.handleFrame(event.data);
    };

    const previousClose = channel.onclose;
    channel.onclose = (event: Event) => {
      previousClose?.call(channel, event);
      if (this.channel === channel) this.notifyInterrupted();
    };
  }

  public get cancelled(): boolean {
    return this._cancelled;
  }

  public get bytesReceived(): number {
    return this.received;
  }

  /** The byte ranges not stored yet, or an empty list once nothing is left. */
  public missingRanges(): ChunkRange[] {
    if (this.totalSize <= 0 || this.complete) return [];
    return missingRanges(this.seen, this.totalSize, CHUNK_SIZE);
  }

  /**
   * Note that the connection went away before the file was complete.
   *
   * Called by the channel's own close handler and by the signaling layer when
   * the peer connection fails. Idempotent in the sense that it reports the
   * current gap every time; the resume loop consumes one report per round.
   */
  public notifyInterrupted(): void {
    if (this._cancelled || this.complete || this.totalSize <= 0) return;
    // Chunks whose sink writes are still queued have not been counted in
    // `seen` yet. Computing the gap before they land would ask the sender to
    // re-send bytes that are about to be stored — the last frames delivered
    // before a drop are exactly the ones still in flight here.
    this.writes = this.writes.then(() => this.reportInterruption());
  }

  /** Split out so it can run after the queued writes have been applied. */
  private reportInterruption(): void {
    if (this._cancelled || this.complete || this.totalSize <= 0) return;
    const ranges = this.missingRanges();
    if (ranges.length === 0) return;

    this.options.onStatus?.("interrupted");
    this.options.onInterrupted?.(ranges);

    const waiter = this.interruptedWaiter;
    this.interruptedWaiter = null;
    if (waiter) waiter(ranges);
    else this.pendingInterruption = ranges;
  }

  /**
   * Resolve with the ranges still missing after a drop, or `null` when the
   * transfer finished or was cancelled first.
   */
  public waitForInterruption(): Promise<ChunkRange[] | null> {
    if (this._cancelled || this.complete) return Promise.resolve(null);
    if (this.pendingInterruption) {
      const ranges = this.pendingInterruption;
      this.pendingInterruption = null;
      return Promise.resolve(ranges);
    }
    return new Promise((resolve) => {
      this.interruptedWaiter = resolve;
    });
  }

  /**
   * Ask the sender for the ranges this receiver is still missing.
   *
   * Returns false when there is nothing to ask for — the sender may already be
   * sending, in which case a duplicate request is harmless but pointless.
   */
  public requestResume(): boolean {
    if (this._cancelled || this.complete || this.totalSize <= 0) return false;
    const ranges = this.missingRanges();
    if (ranges.length === 0) return false;
    try {
      this.channel.send(serializeMessage({ type: "resume-request", ranges }));
      return true;
    } catch {
      return false;
    }
  }

  /** Ask the sender to stop, then tear down the channel. */
  public cancel(reason = "User cancelled"): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this.settleInterruption(null);
    try {
      this.channel.send(serializeMessage({ type: "cancelled", reason }));
    } catch {
      // The channel may already be closed; cancelling is still successful.
    }
    this.options.onCancelled?.(reason);
    this.options.onStatus?.("cancelled");
    this.channel.close();
  }

  /** Wake the resume loop with a terminal answer (finished or cancelled). */
  private settleInterruption(value: ChunkRange[] | null): void {
    this.pendingInterruption = null;
    const waiter = this.interruptedWaiter;
    this.interruptedWaiter = null;
    waiter?.(value);
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

      case "file-resume":
        // A resume continues the file already in progress, so `seen` and the
        // sink are deliberately left alone. Only a fresh `file-start` resets.
        this.options.onStatus?.("transferring");
        break;

      case "resume-ready":
        // The sender is back on a new channel and does not know what it still
        // owes; it can only be told by us. Answering every probe also covers a
        // request that was sent before the sender started listening.
        this.requestResume();
        break;

      case "cancelled":
        this._cancelled = true;
        this.settleInterruption(null);
        this.options.onCancelled?.(msg.reason);
        this.options.onStatus?.("cancelled");
        break;

      case "error":
        this.options.onError?.(msg.message);
        break;
    }
  }

  private startFile(msg: Extract<ControlMessage, { type: "file-start" }>): void {
    // Checked before anything else, because a mismatched pair fails on the very
    // first chunk and the checksum error it produces says nothing about why.
    // The flag byte in the chunk header is what makes the two versions
    // incompatible, so this is the only place the disagreement can be named.
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.fail(
        "This transfer was started by a different version of the app. Reload both pages and try again.",
      );
      return;
    }

    // An absolute sanity bound only. The real ceiling is the sink's: a disk
    // sink streams and is limited by the disk, a memory sink buffers and is
    // limited by RAM. Checking the sink's limit here would reject a large file
    // on the very browsers that could have streamed it.
    if (!Number.isFinite(msg.size) || msg.size <= 0 || msg.size > MAX_DECLARED_BYTES) {
      this.fail(`Refusing an invalid file size (${msg.size} bytes)`);
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
    // A sink that cannot hold the file refuses before allocating anything, and
    // that refusal has to reach the user rather than being thrown into a void.
    this.pendingInterruption = null;
    this.settleInterruption(null);
    this.sinkPromise = makeSink(`${this.transferId}-${Date.now()}`, msg.size).catch(
      (err: unknown) => {
        this._cancelled = true;
        this.settleInterruption(null);
        this.fail(err instanceof Error ? err.message : String(err));
        return null;
      },
    );

    this.options.onFileStart?.(this.fileName, msg.size, this.mime);
  }

  private handleChunk(frame: ArrayBuffer): void {
    let offset: number;
    let digest: Uint8Array;
    let data: Uint8Array<ArrayBuffer>;
    let deflated: boolean;
    try {
      ({ offset, digest, data, deflated } = decodeChunk(frame));
    } catch {
      this.options.onError?.("Malformed chunk frame from sender");
      return;
    }

    // How much of the file this chunk claims to fill. The expansion below is
    // capped by it, so a payload that tries to decode into something larger is
    // stopped before it is held in memory.
    const expected = Math.min(CHUNK_SIZE, this.totalSize - offset);

    // Expansion and hashing both start here rather than inside the chain below,
    // so they overlap the queued writes of the chunks before this one. The
    // digest describes the bytes as they exist in the file, which for a
    // compressed chunk only exist after expanding it.
    const settled = (
      deflated
        ? expected > 0
          ? inflateChunk(data, expected)
          : Promise.reject(new Error("Compressed chunk lies outside the file"))
        : Promise.resolve(data)
    )
      .then(async (bytes) => ({ bytes, ok: digestsMatch(digest, await sha256Bytes(bytes)) }))
      // An undecodable payload is reported as the integrity failure it is, at
      // the offset it claimed, rather than as a writing problem.
      .catch(() => null);

    // Chain the write: a sink that resolves asynchronously must not interleave.
    this.writes = this.writes
      .then(async () => {
        if (this._cancelled) return;
        const result = await settled;
        // Checked before storing, so a corrupt chunk is never written to the
        // file and never counted as present — which would otherwise be a silent
        // hole that the completeness check happily accepts.
        if (result === null || !result.ok) {
          this.integrityFailure(offset);
          return;
        }
        const sink = this.sinkPromise ? await this.sinkPromise : null;
        if (!sink || this._cancelled) return;
        await sink.write(offset, result.bytes);

        if (!this.seen.has(offset)) {
          this.seen.add(offset);
          this.received += result.bytes.byteLength;
          this.reportProgress();
        }
        this.completeIfDone();
      })
      .catch((err: unknown) => {
        // A sink that refuses a chunk will refuse the rest, so the transfer is
        // over: stopping frees the sender from writing gigabytes nobody keeps.
        this._cancelled = true;
        this.settleInterruption(null);
        this.fail(
          `Could not store a chunk: ${err instanceof Error ? err.message : String(err)}`,
        );
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
        this.fail(`Transfer ended with ${this.totalChunks - this.seen.size} chunk(s) missing`);
      }
      return;
    }
    this.complete = true;
    // The resume loop has nothing left to wait for.
    this.settleInterruption(null);
    // Surface a finalise failure rather than hanging: a swallowed error here
    // would leave the transfer stuck with no explanation.
    this.writes = this.writes.then(() => this.finalise()).catch((err: unknown) => {
      this.fail(
        `Could not finish the transfer: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Report progress, coalesced to `PROGRESS_INTERVAL_MS`.
   *
   * One callback per 64 KiB chunk is ~32,000 state updates for a 2 GiB file,
   * and a UI that re-renders on each of them starves the receive path. `force`
   * and reaching the end always emit, so the bar still ends at 100%.
   */
  private reportProgress(force = false): void {
    const now = Date.now();
    if (
      !force &&
      this.totalSize > 0 &&
      this.received < this.totalSize &&
      now - this.lastProgressAt < PROGRESS_INTERVAL_MS
    ) {
      return;
    }
    this.lastProgressAt = now;
    this.options.onProgress?.(this.received, this.totalSize);
  }

  private async finalise(): Promise<void> {
    const sink = this.sinkPromise ? await this.sinkPromise : null;
    if (!sink) return;

    // Nothing is re-read here. Every chunk was checked against the digest it
    // arrived with before it was stored, so completion already means the whole
    // file is present and every piece of it matched.
    const blob = await sink.finish();
    this.options.onProgress?.(this.totalSize, this.totalSize);
    this.options.onVerified?.(true);
    this.options.onStatus?.("completed");
    this.options.onComplete?.(blob, this.fileName);
  }

  /**
   * A chunk did not match the digest it was sent with.
   *
   * The transfer stops rather than retrying: the stream cannot be trusted, and
   * resuming would only hide that. The offset is named so the failure points at
   * a specific 64 KiB window rather than at "the file".
   */
  private integrityFailure(offset: number): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this.settleInterruption(null);
    this.options.onVerified?.(false);
    this.fail(
      `A chunk at byte ${offset} did not match its checksum, so the transfer was stopped.`,
    );
  }

  /**
   * Report a failure to the user *and* to the other device.
   *
   * The sender is the side that decides whether the transfer "succeeded": it
   * can hand every byte to the channel and announce delivery while this side is
   * refusing the file or discarding it. Without this frame it does exactly that,
   * and keeps streaming gigabytes at a receiver that is dropping them.
   */
  private fail(message: string): void {
    try {
      this.channel.send(serializeMessage({ type: "error", message }));
    } catch {
      // The channel is already gone; the local report still stands.
    }
    this.options.onError?.(message);
    this.options.onStatus?.("failed");
  }
}
