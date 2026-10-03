/**
 * Shared types for the peer-to-peer transfer module.
 *
 * WebRTC DOM types (RTCPeerConnection, RTCDataChannel, ...) are owned by the
 * browser lib (tsconfig dom) and must not be re-exported here; import them as
 * bare global types instead of importing them from this file.
 */

export type TransferId = string;

export type TransferStatus =
  | "waiting"
  | "connecting"
  | "connected"
  | "transferring"
  | "completed"
  | "cancelled"
  | "failed"
  | "expired";

export interface TransferFile {
  name: string;
  size: number;
  mime: string;
  checksum?: string;
}

/**
 * The slice of `RTCDataChannel` the transfer layer actually uses.  Typing the
 * dependency structurally (instead of importing the DOM class) keeps the
 * protocol logic unit-testable with a plain stub channel.
 */
export interface TransferChannel {
  readyState: RTCDataChannelState;
  bufferedAmount: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string | ArrayBuffer>) => void) | null;
  onclose: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

/**
 * Control messages travel as JSON text frames on the DataChannel.  File bytes
 * do NOT: they are sent as binary frames with an 8-byte offset header (see
 * `protocol.ts`), so a chunk never round-trips through JSON.
 */
export type ControlMessage =
  | { type: "file-start"; name: string; size: number; mime: string; chunkSize: number }
  | { type: "file-complete" }
  | { type: "cancelled"; reason: string }
  | { type: "error"; message: string };

/** @deprecated use ControlMessage */
export type TransferMessage = ControlMessage;

/** A WebRTC DataChannel event (the browser's native type). */


/** A WebRTC ICE candidate event (the browser's native type). */
export interface RTCPeerConnectionIceEvent {
  candidate: RTCIceCandidate;
}
