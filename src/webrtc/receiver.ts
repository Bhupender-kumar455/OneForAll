/**
 * WebRTC receiver: listens on the DataChannel, reassembles the incoming chunks
 * and hands the finished file back as a Blob the caller can download.
 */
import {
  assembleChunks,
  decodeChunk,
  deserializeMessage,
  serializeMessage,
} from "./protocol.ts";
import type { ControlMessage, TransferChannel, TransferId } from "./types.ts";

export interface ReceiverOptions {
  onStatus?: (status: string) => void;
  onProgress?: (bytesReceived: number, total: number) => void;
  onComplete?: (file: Blob, name: string) => void;
  onCancelled?: (reason: string) => void;
  onError?: (message: string) => void;
  onFileStart?: (name: string, size: number, mime: string) => void;
}

export class DataReceiver {
  private readonly transferId: TransferId;
  private readonly channel: TransferChannel;
  private readonly options: ReceiverOptions;

  private readonly chunks = new Map<number, Uint8Array>();
  private totalSize = 0;
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

  public get file(): Blob | null {
    if (!this.complete) return null;
    const bytes = assembleChunks(this.chunks, this.totalSize);
    return bytes ? new Blob([bytes], { type: this.mime }) : null;
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

  /** A binary frame is a file chunk; a text frame is a control message. */
  private handleFrame(frame: string | ArrayBuffer | Blob): void {
    if (this._cancelled) return;

    if (typeof frame !== "string") {
      if (frame instanceof Blob || !(frame instanceof ArrayBuffer)) return;
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
        this.totalSize = msg.size;
        this.fileName = msg.name;
        this.mime = msg.mime || "application/octet-stream";
        this.chunks.clear();
        this.received = 0;
        this.complete = false;
        this.options.onFileStart?.(msg.name, msg.size, msg.mime);
        break;

      case "file-complete":
        this.finishIfComplete(true);
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

  private handleChunk(frame: ArrayBuffer): void {
    let offset: number;
    let data: Uint8Array;
    try {
      ({ offset, data } = decodeChunk(frame));
    } catch {
      this.options.onError?.("Malformed chunk frame from sender");
      return;
    }

    if (!this.chunks.has(offset)) {
      this.chunks.set(offset, data);
      this.received += data.byteLength;
      this.options.onProgress?.(this.received, this.totalSize);
    }
    this.finishIfComplete();
  }

  private finishIfComplete(force = false): void {
    if (this.complete || (this.totalSize <= 0 && !force)) return;

    const bytes = assembleChunks(this.chunks, this.totalSize);
    if (!bytes) {
      if (force) {
        this.options.onError?.("Transfer ended before all chunks arrived");
      }
      return;
    }

    this.complete = true;
    this.options.onProgress?.(bytes.byteLength, bytes.byteLength);
    this.options.onStatus?.("completed");
    this.options.onComplete?.(new Blob([bytes], { type: this.mime }), this.fileName);
  }
}