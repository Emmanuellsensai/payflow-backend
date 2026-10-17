/** Shared helpers for the per-resource routers. */

/** Upper bound on `limit` so one query cannot drag the synchronous SQLite. */
export const MAX_LIMIT = 200;

/** Both recurring-revenue figures normalise each mandate's period to these. */
export const SECONDS_PER_MONTH = 2_592_000; // a 30-day month
export const SECONDS_PER_YEAR = 31_536_000; // a 365-day year

export function limitOf(raw: unknown, fallback = 50): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}
