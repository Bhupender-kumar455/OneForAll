/**
 * Where incoming chunks are written.
 *
 * The receiver used to keep every chunk in a Map and then assemble a second
 * full copy plus a Blob, peaking at roughly three to four times the file size.
 * A sink writes each chunk once, straight to its final offset, so the memory
 * path holds a single buffer and the disk path (Origin Private File System)
 * holds almost nothing regardless of file size.
 */
import { sha256Hex, sha256Streamed } from "./checksum.ts";

/** Upper bound on a single transfer, matching the record validation. */
export const MAX_TRANSFER_BYTES = 1_000_000_000;

/** Disk entries older than this are leftovers from an interrupted session. */
const STALE_ENTRY_MS = 60 * 60 * 1000;
const ENTRY_PREFIX = "code-compact-transfer-";

export interface TransferSink {
  /** "disk" uses the Origin Private File System; "memory" is a plain buffer. */
  readonly kind: "disk" | "memory";
  /** Copy one chunk to its byte offset. Rejects if it would overrun. */
  write(offset: number, data: Uint8Array): Promise<void>;
  /** Seal the sink and return the finished payload. */
  finish(): Promise<Blob>;
  /** SHA-256 of the finished payload. */
  digest(): Promise<string>;
  /** Release any temporary storage. Safe to call more than once. */
  dispose(): Promise<void>;
}

/** True when this browser can stream to disk without a user gesture. */
export function canStreamToDisk(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

class MemorySink implements TransferSink {
  readonly kind = "memory" as const;
  private readonly buffer: Uint8Array<ArrayBuffer>;

  constructor(totalSize: number) {
    this.buffer = new Uint8Array(totalSize);
  }

  public async write(offset: number, data: Uint8Array): Promise<void> {
    if (offset < 0 || offset + data.byteLength > this.buffer.byteLength) {
      throw new Error("Chunk overruns the declared file size");
    }
    this.buffer.set(data, offset);
  }

  public async finish(): Promise<Blob> {
    return new Blob([this.buffer]);
  }

  /** Digest the buffer in place: no second copy of the file is made. */
  public async digest(): Promise<string> {
    return sha256Hex(this.buffer.buffer);
  }

  public async dispose(): Promise<void> {
    // The buffer is reclaimed with the sink.
  }
}

/** The handful of OPFS shapes used here, kept structural to avoid lib gaps. */
interface WritableLike {
  write(chunk: unknown): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
  getFile(): Promise<File>;
}
interface DirHandleLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string): Promise<void>;
  values?(): AsyncIterableIterator<FileHandleLike & { name: string }>;
}

class DiskSink implements TransferSink {
  readonly kind = "disk" as const;
  private closed = false;
  /** Memoised so concurrent `finish()`/`digest()` cannot double-close. */
  private sealPromise: Promise<File> | null = null;

  private readonly dir: DirHandleLike;
  private readonly entryName: string;
  private readonly handle: FileHandleLike;
  private readonly writable: WritableLike;
  private readonly totalSize: number;

  private constructor(
    dir: DirHandleLike,
    entryName: string,
    handle: FileHandleLike,
    writable: WritableLike,
    totalSize: number,
  ) {
    this.dir = dir;
    this.entryName = entryName;
    this.handle = handle;
    this.writable = writable;
    this.totalSize = totalSize;
  }

  public static async create(entryName: string, totalSize: number): Promise<DiskSink> {
    const storage = navigator.storage as unknown as {
      getDirectory(): Promise<DirHandleLike>;
    };
    const root = await storage.getDirectory();
    await pruneStaleEntries(root);
    const handle = await root.getFileHandle(entryName, { create: true });
    const writable = await handle.createWritable();
    return new DiskSink(root, entryName, handle, writable, totalSize);
  }

  public async write(offset: number, data: Uint8Array): Promise<void> {
    if (offset < 0 || offset + data.byteLength > this.totalSize) {
      throw new Error("Chunk overruns the declared file size");
    }
    // Positional writes mean chunks may arrive in any order.
    await this.writable.write({ type: "write", position: offset, data });
  }

  public seal(): Promise<File> {
    if (!this.sealPromise) {
      this.sealPromise = (async () => {
        if (!this.closed) {
          await this.writable.close();
          this.closed = true;
        }
        return this.handle.getFile();
      })();
    }
    return this.sealPromise;
  }

  public async finish(): Promise<Blob> {
    return this.seal();
  }

  /**
   * Hash the file from disk one window at a time, so verification does not put
   * the whole payload back on the heap.
   */
  public async digest(): Promise<string> {
    return sha256Streamed(await this.seal());
  }

  public async dispose(): Promise<void> {
    if (!this.closed) {
      try {
        await this.writable.abort();
      } catch {
        // Already closed or gone; nothing to release.
      }
      this.closed = true;
    }
    // Never drop the entry while a sealed File may still be downloading.
    if (this.sealPromise) return;
    try {
      await this.dir.removeEntry(this.entryName);
    } catch {
      // A failed cleanup must not fail the transfer.
    }
  }
}

/** Best-effort removal of entries abandoned by an earlier session. */
async function pruneStaleEntries(dir: DirHandleLike): Promise<void> {
  if (!dir.values) return;
  try {
    const now = Date.now();
    for await (const handle of dir.values()) {
      if (!handle.name.startsWith(ENTRY_PREFIX)) continue;
      try {
        const file = await handle.getFile();
        if (now - file.lastModified > STALE_ENTRY_MS) {
          await dir.removeEntry(handle.name);
        }
      } catch {
        // Unreadable entry: leave it alone.
      }
    }
  } catch {
    // Iteration unsupported: skipping the sweep is harmless.
  }
}

/**
 * Pick the best sink for this transfer.  Falls back to memory whenever the
 * browser lacks OPFS or the disk write cannot be set up.
 */
export async function createSink(
  entryName: string,
  totalSize: number,
): Promise<TransferSink> {
  if (canStreamToDisk()) {
    try {
      return await DiskSink.create(`${ENTRY_PREFIX}${entryName}`, totalSize);
    } catch {
      // Private mode, quota, or unsupported: the memory sink still works.
    }
  }
  return new MemorySink(totalSize);
}
