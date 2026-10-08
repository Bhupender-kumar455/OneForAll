/**
 * Per-chunk compression for file transfers.
 *
 * Deflate is applied to one chunk at a time — never across the whole file —
 * because the transfer's recovery model depends on chunks being independent:
 * they are written at absolute offsets in any order, each carries its own
 * digest, and a resume asks for an arbitrary byte range. A single deflate stream
 * would be smaller still, but it cannot be seeked into, so one lost packet would
 * mean sending the file again.
 *
 * The measured cost of that choice is small: this project's own source
 * compresses to 28.5% in independent 64 KiB chunks against 27.1% for one
 * continuous stream.
 *
 * What it buys, measured on the same corpus: source, logs, CSV and JSON shrink
 * by roughly 3.5x, while anything already compressed (zip, apk, ROM, JPEG, MP4,
 * PDF) shrinks by nothing at all. That is why the sender probes before it
 * commits — see `COMPRESSION_PROBE_BYTES` in `protocol.ts`.
 *
 * The digest always covers the *original* bytes, so the receiver's guarantee is
 * unchanged: every chunk it stores is checked against what the sender read,
 * after expansion.
 */

/** True when this browser can both deflate and inflate. */
export function compressionAvailable(): boolean {
  return (
    typeof CompressionStream === "function" && typeof DecompressionStream === "function"
  );
}

/** The wire shape of a transform one buffer can be pushed through. */
interface ChunkTransform {
  writable: WritableStream<BufferSource>;
  readable: ReadableStream<Uint8Array>;
}

/**
 * Push one buffer through `transform` and collect the result.
 *
 * `maxOutputBytes` bounds the read rather than trusting the transform to stop: a
 * payload that decodes to more than the space it claims to fill is either
 * corrupt or a decompression bomb, and the rest of it must never be pulled into
 * memory. The write is deliberately not awaited before the read — the transform
 * cannot finish while its input is still queued, so waiting first would stall.
 */
async function transformChunk(
  transform: ChunkTransform,
  // Pinned to an `ArrayBuffer`-backed view: that is the only flavour of
  // `BufferSource` a stream's writer accepts, and saying so here keeps the
  // callers honest instead of casting at the write.
  data: Uint8Array<ArrayBuffer>,
  maxOutputBytes: number,
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  void writer
    .write(data)
    .then(() => writer.close())
    .catch(() => {
      // The read below surfaces the same failure; nothing to add here.
    });

  const reader = transform.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxOutputBytes) {
        throw new Error(
          `Decoded payload is larger than the ${maxOutputBytes} bytes it fills`,
        );
      }
      parts.push(value);
    }
  } finally {
    // Released on every path, including the over-size throw above.
    void reader.cancel().catch(() => {});
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * Compress one chunk, or return `null` when the result would not be smaller.
 *
 * Returning `null` rather than a larger buffer is what keeps the flag on the
 * wire meaningful: "deflated" always means genuinely smaller, so an
 * incompressible chunk is stored as it is and the receiver never expands
 * something that was not worth compressing.
 */
export async function deflateChunk(
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array | null> {
  if (!compressionAvailable()) return null;
  try {
    // `deflate-raw` skips the zlib header and its Adler-32 trailer, which for a
    // 64 KiB chunk would be six bytes of pure overhead per chunk.
    const packed = await transformChunk(
      new CompressionStream("deflate-raw"),
      data,
      data.byteLength,
    );
    return packed.byteLength < data.byteLength ? packed : null;
  } catch {
    // An unsupported format or a broken stream: raw bytes are always valid.
    return null;
  }
}

/**
 * Expand one chunk back to the bytes it describes.
 *
 * `expectedBytes` is how much of the file this chunk fills, so the cap here plus
 * the caller's digest check together prove the expansion is exactly right.
 * Throws when the payload cannot be decoded or would grow past that bound.
 */
export async function inflateChunk(
  data: Uint8Array<ArrayBuffer>,
  expectedBytes: number,
): Promise<Uint8Array> {
  if (!compressionAvailable()) {
    throw new Error("This browser cannot decompress the incoming file");
  }
  return transformChunk(new DecompressionStream("deflate-raw"), data, expectedBytes);
}
