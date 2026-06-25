// Small timing utilities used to close a response-timing side-channel.
//
// The public signup endpoint must not reveal whether an email already exists.
// The response *shape* is already identical for new vs existing emails (see
// app/api/signup/route.ts + tests/anti-enumeration.test.ts), but the *work*
// differs (a brand-new signup inserts a row + mints a code; a duplicate just
// re-sends a benign email), which leaves a wall-clock timing oracle. We blunt it
// by padding every enumeration-relevant response up to a fixed floor, so both
// paths take roughly the same time regardless of the work done underneath.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until at least `minMs` has elapsed since `startedAt` (epoch ms). If the
 * work already took longer than the floor, returns immediately. A floor <= 0 is
 * a no-op. Returns the number of ms it slept (useful for tests).
 */
export async function enforceMinDuration(startedAt: number, minMs: number): Promise<number> {
  if (!Number.isFinite(minMs) || minMs <= 0) return 0;
  const elapsed = Date.now() - startedAt;
  const remaining = minMs - elapsed;
  if (remaining <= 0) return 0;
  await sleep(remaining);
  return remaining;
}
