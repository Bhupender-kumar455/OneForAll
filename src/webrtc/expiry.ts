/**
 * Expiry for abandoned signaling records.
 *
 * A transfer record is only ever deleted by an explicit cancel, so a sender
 * that closes its tab abruptly (or a browser crash) leaves the record behind
 * forever.  Every record carries an `expiresAt`, and this decides which ones
 * are past it and should be swept.
 *
 * Kept free of Firebase imports so it can be unit tested directly.
 */

export interface ExpirableRecord {
  expiresAt?: number | null;
}

/** Treat a record as expired when its deadline has passed or is unreadable. */
export function isExpired(record: ExpirableRecord | null, now: number): boolean {
  if (!record) return true;
  if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) {
    return true;
  }
  return record.expiresAt < now;
}

/** IDs of every record that is past its deadline. */
export function selectExpired<T extends ExpirableRecord>(
  records: Record<string, T | null> | null,
  now: number,
): string[] {
  if (!records) return [];
  return Object.entries(records)
    .filter(([, record]) => isExpired(record, now))
    .map(([id]) => id);
}
