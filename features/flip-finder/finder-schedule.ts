/** Pure cadence rules used by the server scheduler, independent of page lifetime. */
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

/**
 * OLX has its own durable cadence (search_filters.finder_olx_scan_interval_minutes),
 * independent of finder_scan_interval_minutes. Only these values are offered;
 * the database refuses anything below 24 h, so a shorter interval needs a
 * separate migration together with a reviewed Cloudflare budget.
 */
export const FINDER_OLX_INTERVAL_OPTIONS_MINUTES = [1440, 2880, 4320] as const;
export const FINDER_OLX_DEFAULT_INTERVAL_MINUTES = 1440;
export type FinderOlxIntervalMinutes = (typeof FINDER_OLX_INTERVAL_OPTIONS_MINUTES)[number];

export function isFinderOlxIntervalMinutes(value: unknown): value is FinderOlxIntervalMinutes {
  return typeof value === "number" && (FINDER_OLX_INTERVAL_OPTIONS_MINUTES as readonly number[]).includes(value);
}

/**
 * Shared OLX budget: OLX jobs of every kind (automatic, manual Finder, Price
 * Radar) in the last 24 h must stay below this number before an automatic
 * Finder OLX job is queued. Default 1; FINDER_OLX_SHARED_DAILY_JOB_BUDGET
 * may set 1..20 after a separate budget review. Anything else falls back to 1.
 */
export const FINDER_OLX_SHARED_DAILY_JOB_BUDGET_DEFAULT = 1;
export function finderOlxSharedDailyJobBudget(value: string | undefined): number {
  const trimmed = value?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) return FINDER_OLX_SHARED_DAILY_JOB_BUDGET_DEFAULT;
  const parsed = Number(trimmed);
  return parsed >= 1 && parsed <= 20 ? parsed : FINDER_OLX_SHARED_DAILY_JOB_BUDGET_DEFAULT;
}
