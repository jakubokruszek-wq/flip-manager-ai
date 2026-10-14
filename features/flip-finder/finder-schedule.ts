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
 * OLX has its own durable schedule, independent of finder_scan_interval_minutes:
 * fixed slots at finder_olx_start_time (Europe/Warsaw) every 12/24/48/72 h
 * (migration 20261016120000). The database accepts exactly these intervals;
 * 12 h needs the automatic limit raised to 2 per 24 h after a budget check,
 * otherwise its second daily slot is skipped as AUTOMATIC_DAILY_BUDGET_USED.
 */
export const FINDER_OLX_INTERVAL_OPTIONS_MINUTES = [720, 1440, 2880, 4320] as const;
export const FINDER_OLX_TIME_ZONE = "Europe/Warsaw";
export const FINDER_OLX_DEFAULT_START_TIME = "08:00";
/** HH:mm in 5-minute steps (00:00 ... 23:55). */
export const FINDER_OLX_START_TIME_OPTIONS: readonly string[] = Array.from({ length: 288 }, (_, index) => `${String(Math.floor(index / 12)).padStart(2, "0")}:${String((index % 12) * 5).padStart(2, "0")}`);

export function isFinderOlxStartTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5][05]$/.test(value);
}

/** "08:00:00" (Postgres time) or "08:00" -> "08:00"; anything else -> null. */
export function normalizeFinderOlxStartTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const short = /^(\d{2}:\d{2})(?::00)?$/.exec(value.trim())?.[1] ?? null;
  return short && isFinderOlxStartTime(short) ? short : null;
}
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
