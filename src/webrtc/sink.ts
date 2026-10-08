/**
 * Where incoming chunks are written.
 *
 * The receiver used to keep every chunk in a Map and then assemble a second
 * full copy plus a Blob, peaking at roughly three to four times the file size.
 * A sink writes each chunk once, straight to its final offset, so the memory
 * path holds a single buffer and the disk path (Origin Private File System)
 * holds almost nothing regardless of file size.
 */
/**
 * Largest payload a memory sink will hold.
 *
 * This is a RAM ceiling, not a protocol one: `MemorySink` allocates the whole
 * file as a single buffer. A disk sink streams instead and is limited by the
 * disk's quota, which is why the receiver validates against the sink it got
 * rather than against this number.
 */
export const MAX_TRANSFER_BYTES = 1_000_000_000;

/** Compact size for user-facing errors; `lib/bytes` stops at megabytes. */
function describeSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const step = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / 1024 ** step).toFixed(1))} ${units[step]}`;
}

/** Disk entries older than this are leftovers from an interrupted session. */
const STALE_ENTRY_MS = 60 * 60 * 1000;
const ENTRY_PREFIX = "code-compact-transfer-";

export interface TransferSink {
  /** "disk" uses the Origin Private File System; "memory" is a plain buffer. */
  readonly kind: "disk" | "memory";
  /** Copy one chunk to its byte offset. Rejects if it would overrun. */
  write(offset: number, data: Uint8Array): Promise<void>;
  /**
   * Seal the sink and return the finished payload.
   *
   * There is no whole-payload digest here by design: integrity is settled one
   * chunk at a time as the bytes arrive (see `checksum.ts`), so sealing is the
   * last step rather than the start of a second pass over the file.
   */
  finish(): Promise<Blob>;
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
  // Why the disk path could not be set up: private mode, quota, unsupported.
  let diskFailure: string | null = null;
  if (canStreamToDisk()) {
    try {
      return await DiskSink.create(`${ENTRY_PREFIX}${entryName}`, totalSize);
    } catch (err: unknown) {
      // Falling back to memory is right — the memory sink still works — but the
      // reason is kept, because the refusal below is the only message a user
      // sees when the file is too large for RAM and it does not otherwise say
      // what to fix.
      diskFailure = err instanceof Error ? err.message : String(err);
    }
  }
  // Refuse before allocating. Handing a multi-gigabyte size to `new
  // Uint8Array()` would either throw or take the tab down with it.
  if (totalSize > MAX_TRANSFER_BYTES) {
    throw new Error(
      `This browser cannot stream to disk${diskFailure ? ` (${diskFailure})` : ""}, ` +
        `so a ${describeSize(totalSize)} file would have to be held in memory; ` +
        `the limit is ${describeSize(MAX_TRANSFER_BYTES)}.`,
    );
  }
  return new MemorySink(totalSize);
}
