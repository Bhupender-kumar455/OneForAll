/**
 * Bounded waits.
 *
 * Every network call the app makes is allowed to hang: a WebSocket that never
 * opens, a fetch that stalls behind a captive portal, a database write that
 * never settles. Without a bound the UI sits on one line forever and the user
 * has no idea whether it is working. `withTimeout` turns "still waiting" into
 * a specific, actionable failure.
 */

/**
 * Reject with `message` if `promise` has not settled within `ms`.
 *
 * The original promise is left running — a timeout is a report, not a cancel —
 * but its eventual rejection is absorbed so a late failure cannot surface as an
 * unhandled rejection after the timeout has already won the race.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  void promise.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  // The timer is always cleared: an abandoned one would keep the process (or a
  // test run) alive after the real answer arrived.
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}