/**
 * Application-level protocol for the WebRTC DataChannel.
 *
 * Firebase carries the signaling; the bytes travel here.  A file is sliced
 * into `CHUNK_SIZE` byte pieces, each sent as a binary frame carrying its byte
 * offset, so the receiver can write it straight to its final position and
 * out-of-order delivery does not matter.
 */
import type { ChunkRange, ControlMessage } from "./types";

/** Maximum DataChannel payload.  64 KiB is the interoperable safe limit. */
export const CHUNK_SIZE = 64 * 1024;

/** Pause sending once this many bytes are queued on the channel. */
export const BACKPRESSURE_THRESHOLD = 1 << 18; // 256 KiB

/**
 * Cap on how often progress is reported, in milliseconds.
 *
 * Progress is a UI signal, not a protocol one. Reporting per chunk means a
 * 2 GiB file fires ~32,000 callbacks, and a React handler that sets state on
 * each of them re-renders ~32,000 times — enough main-thread work to starve the
 * transfer itself. Coalescing to this cadence costs nothing and keeps the
 * receive path free. The final 100% report always goes out regardless.
 */
export const PROGRESS_INTERVAL_MS = 100;

/**
 * Absolute sanity bound on a declared transfer size.
 *
 * This is not a capacity check — the receiver decides capacity from the sink it
 * actually got. It lives here so the signaling layer and the transfer layer
 * share one number instead of each carrying its own copy.
 */
export const MAX_DECLARED_BYTES = 64 * 1024 ** 3; // 64 GiB

/**
 * How many chunks the sender reads ahead of the send loop.
 *
 * Reading a slice is asynchronous, so a strictly serial `read → send` loop
 * exposes the disk's latency on every chunk. Keeping a few reads in flight
 * hides it behind the previous chunk's send.
 */
export const READ_AHEAD_CHUNKS = 8;

/** The byte offset, as a big-endian float64, that opens every chunk frame. */
export const CHUNK_OFFSET_BYTES = 8;

/**
 * SHA-256 of the chunk payload, carried in the frame itself.
 *
 * Truncating this would save 24 bytes per 64 KiB chunk, which is 0.04% of the
 * transfer, so the full digest is kept: it needs no explanation and leaves no
 * doubt about what was checked. The digest rides with its own chunk, so there
 * is no manifest to build, order for, or re-send after a resume.
 */
export const CHUNK_DIGEST_BYTES = 32;

/** Byte length of the offset-plus-digest header on every binary chunk frame. */
export const CHUNK_HEADER_BYTES = CHUNK_OFFSET_BYTES + CHUNK_DIGEST_BYTES;

/**
 * How long the sender waits for the receiver's list of missing ranges before
 * giving up on a resume round.
 */
export const RESUME_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * How often the sender re-announces `resume-ready` while waiting.
 *
 * The first announcement can be lost if the receiver has not yet attached its
 * message handler to the fresh channel, so the probe repeats until it is
 * answered. Both sides are idempotent, so a duplicate costs nothing.
 */
export const RESUME_PROBE_MS = 2_000;

/**
 * The byte ranges of a file that have not been stored yet, coalesced into as
 * few spans as possible.
 *
 * `seen` holds the offsets of the chunks the receiver already wrote. A drop
 * usually leaves one large hole (everything after the last stored chunk) plus
 * the odd missing chunk, so coalescing turns ~32,000 offsets into a couple of
 * numbers. Ordered, non-overlapping spans are also what the sender's read
 * pipeline wants, so no second pass is needed on arrival.
 */
export function missingRanges(
  seen: ReadonlySet<number>,
  totalSize: number,
  chunkSize: number = CHUNK_SIZE,
): ChunkRange[] {
  if (!Number.isFinite(totalSize) || totalSize <= 0) return [];

  const ranges: ChunkRange[] = [];
  for (let offset = 0; offset < totalSize; offset += chunkSize) {
    if (seen.has(offset)) continue;

    const length = Math.min(chunkSize, totalSize - offset);
    const previous = ranges[ranges.length - 1];
    if (previous && previous.offset + previous.length === offset) {
      previous.length += length;
    } else {
      ranges.push({ offset, length });
    }
  }
  return ranges;
}

/** Total bytes covered by a list of ranges. */
export function totalBytes(ranges: readonly ChunkRange[]): number {
  let sum = 0;
  for (const range of ranges) sum += range.length;
  return sum;
}

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
 * Frame one file chunk for the wire: an 8-byte big-endian byte offset, the
 * chunk's 32-byte SHA-256, then the raw bytes.  Binary frames keep the payload
 * exact (JSON would turn an ArrayBuffer into `{}`) and avoid base64's 33%
 * overhead.
 *
 * The digest covers the payload only. It travels with the chunk it describes,
 * so it catches corruption in flight; it is not a claim about the whole file
 * that a receiver could check independently.
 */
export function encodeChunk(
  offset: number,
  data: ArrayBuffer,
  digest: Uint8Array,
): ArrayBuffer {
  if (digest.byteLength !== CHUNK_DIGEST_BYTES) {
    throw new Error(
      `Chunk digest must be ${CHUNK_DIGEST_BYTES} bytes, got ${digest.byteLength}`,
    );
  }
  const frame = new Uint8Array(CHUNK_HEADER_BYTES + data.byteLength);
  new DataView(frame.buffer).setFloat64(0, offset, false);
  frame.set(digest, CHUNK_OFFSET_BYTES);
  frame.set(new Uint8Array(data), CHUNK_HEADER_BYTES);
  return frame.buffer;
}

/**
 * Inverse of `encodeChunk`; returns the offset, the claimed digest and the
 * chunk's bytes. The digest is a view into the frame, so it costs no copy.
 */
export function decodeChunk(frame: ArrayBuffer): {
  offset: number;
  digest: Uint8Array;
  data: Uint8Array;
} {
  if (frame.byteLength < CHUNK_HEADER_BYTES) {
    throw new Error("Chunk frame is missing its offset header");
  }
  const offset = new DataView(frame).getFloat64(0, false);
  const digest = new Uint8Array(frame, CHUNK_OFFSET_BYTES, CHUNK_DIGEST_BYTES);
  return { offset, digest, data: new Uint8Array(frame, CHUNK_HEADER_BYTES) };
}

