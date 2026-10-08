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
  | "interrupted"
  | "completed"
  | "cancelled"
  | "failed"
  | "expired";

/**
 * The file as described in the signaling record.
 *
 * Deliberately no checksum: the sender must not read its whole file before the
 * transfer can begin. Integrity is carried per chunk instead, in the frame
 * header, so it costs nothing up front.
 */
export interface TransferFile {
  name: string;
  size: number;
  mime: string;
}

/**
 * One ICE candidate as persisted in Firebase.  The full triple is stored
 * because `addIceCandidate` rejects a candidate that has neither `sdpMid` nor
 * `sdpMLineIndex`.
 */
export interface StoredCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/**
 * A contiguous span of the file that has not been stored yet.
 *
 * Resume is expressed in byte ranges rather than a list of chunk offsets: a
 * dropped connection usually leaves one long hole, so a 2 GiB file needs a
 * handful of numbers on the wire instead of ~32,000 offsets.
 */
export interface ChunkRange {
  offset: number;
  length: number;
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
  /**
   * Present on a real RTCDataChannel, omitted by the test stubs.  When the
   * sender can set it, backpressure is signalled by an event instead of being
   * discovered by polling.
   */
  bufferedAmountLowThreshold?: number;
  onbufferedamountlow?: ((event: Event) => void) | null;
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
  | {
      type: "file-start";
      /** See `PROTOCOL_VERSION`: the two browsers must agree on the frame shape. */
      protocol: number;
      name: string;
      size: number;
      mime: string;
      chunkSize: number;
    }
  | { type: "file-complete" }
  // Resume round: the receiver reports exactly which byte ranges it still
  // needs, the sender announces that it is re-sending only those, and the
  // sender probes with `resume-ready` until that request arrives (see
  // `sender.ts`/`receiver.ts` for the handshake).
  | { type: "resume-ready" }
  | { type: "resume-request"; ranges: ChunkRange[] }
  | { type: "file-resume"; ranges: ChunkRange[] }
  | { type: "cancelled"; reason: string }
  | { type: "error"; message: string };

/** @deprecated use ControlMessage */
export type TransferMessage = ControlMessage;

/** A WebRTC DataChannel event (the browser's native type). */


/** A WebRTC ICE candidate event (the browser's native type). */
export interface RTCPeerConnectionIceEvent {
  candidate: RTCIceCandidate;
}
