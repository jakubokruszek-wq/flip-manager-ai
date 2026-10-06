/**
 * Pure Finder cadence math, deliberately free of "server-only" so the exact
 * same due-check the server-side scheduler (features/flip-finder/server/
 * finder-scheduler.ts, which re-exports these) uses can also run client-side
 * -- see flip-finder-page.tsx's auto-pilot effect, which starts a due
 * filter's scan itself while the page is open, since GitHub Actions' own
 * `schedule` event has been confirmed (via a read-only Production
 * diagnosis) to not reliably fire for this repo at all.
 */
export const FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES = 60;

/**
 * Finder's finder_scan_interval_minutes is its durable per-filter cadence.
 * The legacy scan_interval_minutes column remains the global Facebook
 * Watcher setting and is deliberately not read here.
 */
export function finderScanIntervalMinutes(value: unknown): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isInteger(numeric) && numeric > 0
    ? numeric
    : FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES;
}

export function isFinderScanDue(input: {
  isActive: boolean;
  lastScannedAt: string | null | undefined;
  scanIntervalMinutes: unknown;
  now?: Date | number;
}): boolean {
  if (!input.isActive) return false;
  if (!input.lastScannedAt) return true;
  const last = Date.parse(input.lastScannedAt);
  if (!Number.isFinite(last)) return true;
  const now = input.now instanceof Date ? input.now.getTime() : input.now ?? Date.now();
  return now - last >= finderScanIntervalMinutes(input.scanIntervalMinutes) * 60_000;
}
