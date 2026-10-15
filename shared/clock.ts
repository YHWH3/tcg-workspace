/**
 * Hybrid-logical-clock drift bound shared by server and client.
 *
 * Field timestamps are client-generated hybrid logical clocks. Without a bound
 * one wrong device clock (or one hostile write) wins every later
 * last-writer-wins merge on a field, and `hlc.observe()` on pull carries the
 * value into every peer's persisted clock. A timestamp more than this far ahead
 * of the observer's wall clock is not trusted: the server clamps incoming
 * values to `now + MAX_FUTURE_SKEW_MS`; the client refuses to adopt larger ones.
 */
export const MAX_FUTURE_SKEW_MS = 60_000;

/** Is `ts` an acceptable timestamp to adopt at wall-clock `now`? */
export function isTrustedTimestamp(ts: unknown, now: number): ts is number {
  return typeof ts === 'number' && Number.isFinite(ts) && ts <= now + MAX_FUTURE_SKEW_MS;
}

/**
 * Timestamps already stored beyond the drift ceiling (written before it
 * existed) cannot be trusted as "when this field was written". They are
 * treated as the row's last server write time — a value that is never in the
 * future — so a poisoned field becomes writable again at once. (Clamping to
 * the moving ceiling instead would leave it permanently ahead of every ordinary
 * client write.) The row is healed on its next write.
 */
export function healTimestamps(ts: Record<string, number>, now: number, writtenAt: number | null | undefined): Record<string, number> {
  const ceiling = now + MAX_FUTURE_SKEW_MS;
  const healTo = Math.min(writtenAt ?? 0, ceiling);
  let out = ts;
  for (const [field, value] of Object.entries(ts)) {
    if (!(value <= ceiling)) {
      if (out === ts) out = { ...ts };
      out[field] = healTo;
    }
  }
  return out;
}
