/**
 * Application-level protocol for the WebRTC DataChannel.
 *
 * Firebase carries the signaling; the bytes travel here.  A file is sliced
 * into `CHUNK_SIZE` byte pieces, each sent as a binary frame carrying its byte
 * offset, so the receiver can write it straight to its final position and
 * out-of-order delivery does not matter.
 */
import type { ControlMessage } from "./types";

/** Maximum DataChannel payload.  64 KiB is the interoperable safe limit. */
export const CHUNK_SIZE = 64 * 1024;

/** Pause sending once this many bytes are queued on the channel. */
export const BACKPRESSURE_THRESHOLD = 1 << 18; // 256 KiB

/** Byte length of the offset header that prefixes every binary chunk frame. */
export const CHUNK_HEADER_BYTES = 8;

export function serializeMessage(msg: ControlMessage): string {
  return JSON.stringify(msg);
}

export function deserializeMessage(json: string): ControlMessage {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== "string"
  ) {
    throw new Error("Not a transfer message");
  }
  return parsed as ControlMessage;
}

/**
 * Frame one file chunk for the wire: an 8-byte big-endian byte offset followed
 * by the raw bytes.  Binary frames keep the payload exact (JSON would turn an
 * ArrayBuffer into `{}`) and avoid base64's 33% overhead.
 */
export function encodeChunk(offset: number, data: ArrayBuffer): ArrayBuffer {
  const frame = new Uint8Array(CHUNK_HEADER_BYTES + data.byteLength);
  new DataView(frame.buffer).setFloat64(0, offset, false);
  frame.set(new Uint8Array(data), CHUNK_HEADER_BYTES);
  return frame.buffer;
}

/** Inverse of `encodeChunk`; returns the offset and the chunk's bytes. */
export function decodeChunk(frame: ArrayBuffer): {
  offset: number;
  data: Uint8Array;
} {
  if (frame.byteLength < CHUNK_HEADER_BYTES) {
    throw new Error("Chunk frame is missing its offset header");
  }
  const offset = new DataView(frame).getFloat64(0, false);
  return { offset, data: new Uint8Array(frame, CHUNK_HEADER_BYTES) };
}

