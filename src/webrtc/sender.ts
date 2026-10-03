/**
 * WebRTC sender: streams the selected file over the DataChannel with 64 KiB
 * chunks, backpressure handling, progress reporting and cancel support.
 */
import {
  BACKPRESSURE_THRESHOLD,
  CHUNK_SIZE,
  encodeChunk,
  serializeMessage,
} from "./protocol.ts";
import type { ControlMessage, TransferChannel, TransferId } from "./types.ts";

export interface SenderOptions {
  onStatus?: (status: string) => void;
  onProgress?: (bytesSent: number, total: number) => void;
  onComplete?: () => void;
  onCancelled?: (reason: string) => void;
  onError?: (message: string) => void;
}

export class DataSender {
  private readonly transferId: TransferId;
  private readonly channel: TransferChannel;
  private readonly file: File;
  private readonly options: SenderOptions;

  private offset = 0;
  private cancelled = false;
  private cancelledReason = "User cancelled";

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
  }

  public get bytesSent(): number {
    return this.offset;
  }

  public get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Request cancellation; an in-flight `sendFile` stops at the next chunk. */
  public cancel(reason = "User cancelled"): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelledReason = reason;
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
   * Send the file.  Resolves once every chunk and the completion marker have
   * been handed to the DataChannel (or when cancelled).
   */
  public async sendFile(): Promise<void> {
    const file = this.file;
    if (!file) {
      this.options.onError?.("No file selected");
      return;
    }

    try {
      const start: ControlMessage = {
        type: "file-start",
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        chunkSize: CHUNK_SIZE,
      };
      this.channel.send(serializeMessage(start));
      this.options.onStatus?.("transferring");

      while (this.offset < file.size && !this.cancelled) {
        if (this.channel.bufferedAmount > BACKPRESSURE_THRESHOLD) {
          await this.waitForSpace();
        }
        if (this.cancelled) break;

        const chunk = file.slice(this.offset, this.offset + CHUNK_SIZE);
        const buffer = await chunk.arrayBuffer();
        if (this.cancelled) break;

        this.channel.send(encodeChunk(this.offset, buffer));
        this.offset += chunk.size;
        this.options.onProgress?.(this.offset, file.size);
      }

      if (this.cancelled) {
        this.options.onStatus?.("cancelled");
        return;
      }

      const complete: ControlMessage = { type: "file-complete" };
      this.channel.send(serializeMessage(complete));
      this.options.onComplete?.();
      this.options.onStatus?.("completed");
    } catch (err: unknown) {
      this.options.onError?.(
        `Send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.options.onStatus?.("failed");
    }
  }

  /** Poll the channel until the queued bytes drain below the threshold. */
  private waitForSpace(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.cancelled) return resolve();
        if (this.channel.bufferedAmount <= BACKPRESSURE_THRESHOLD) return resolve();
        setTimeout(check, 20);
      };
      check();
    });
  }
}
