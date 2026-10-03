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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
