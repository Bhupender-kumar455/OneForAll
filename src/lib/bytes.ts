/** Text metrics shared by the formatter and the extractor panel headers. */

export interface TextStats {
  lines: number;
  characters: number;
  bytes: number;
}

export function countStats(value: string): TextStats {
  if (!value) return { lines: 0, characters: 0, bytes: 0 };
  return {
    lines: value.split('\n').length,
    characters: value.length,
    bytes: new TextEncoder().encode(value).length,
  };
}

/**
 * Human-readable byte count.
 *
 * Extends past megabytes so transferred files read correctly: everything below
 * a gigabyte formats exactly as it always did, and a transfer's progress can be
 * shown without a second formatter that stops at a different unit.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}
