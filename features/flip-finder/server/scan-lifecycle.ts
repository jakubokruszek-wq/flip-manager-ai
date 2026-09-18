/**
 * Pure scan-lifecycle rules shared by the manual scan runner and the filter list.
 * Kept free of the "server-only" guard so the recovery semantics can be tested
 * directly instead of only through a live Supabase client.
 */

/** Non-terminal scan states. A row left in one of these blocks every future scan of the same filter. */
export const RECOVERABLE_SCAN_STATUSES = ["pending", "running"] as const;
export type RecoverableScanStatus = (typeof RECOVERABLE_SCAN_STATUSES)[number];

export const STALE_SCAN_TIMEOUT_MS = 15 * 60 * 1000;
export const STALE_SCAN_MESSAGE = "Scan timed out";

/**
 * Newest-first page size for the filter list's scan history. The list only ever
 * needs each filter's most recent scan, so an unordered unbounded select is both
 * wasteful and unsafe: PostgREST truncates at its own row cap in arbitrary order,
 * which can hide the newest rows entirely.
 */
export const SOURCE_SCAN_PAGE_LIMIT = 200;

export function staleScanCutoff(now: number, timeoutMs: number = STALE_SCAN_TIMEOUT_MS): string {
  return new Date(now - timeoutMs).toISOString();
}

/**
 * A scan is recoverable only once it has been non-terminal for longer than the
 * timeout. A row whose age cannot be established is never reaped, so a missing or
 * malformed timestamp can never cancel a scan that is genuinely in flight.
 */
export function isStaleScan(scan: { status: string; startedAt: string | null }, now: number, timeoutMs: number = STALE_SCAN_TIMEOUT_MS): boolean {
  if (!(RECOVERABLE_SCAN_STATUSES as readonly string[]).includes(scan.status)) return false;
  const startedMs = scan.startedAt ? Date.parse(scan.startedAt) : Number.NaN;
  if (!Number.isFinite(startedMs)) return false;
  return now - startedMs >= timeoutMs;
}

type ScanLike = { searchFilterId: string; status: string; startedAt: string; finishedAt?: string | null };

function isActiveScan(scan: { status: string } | undefined): boolean {
  return scan ? (RECOVERABLE_SCAN_STATUSES as readonly string[]).includes(scan.status) : false;
}

/**
 * Each filter's current scan: an in-flight scan outranks a newer finished one,
 * otherwise the most recently started wins. Independent of input order, so the
 * result never depends on the order rows happen to arrive in.
 */
export function selectLatestScans<T extends ScanLike>(scans: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const scan of scans) {
    const current = latest.get(scan.searchFilterId);
    const scanActive = isActiveScan(scan);
    const currentActive = isActiveScan(current);
    if (!current || (scanActive && !currentActive) || (scanActive === currentActive && scan.startedAt > current.startedAt)) {
      latest.set(scan.searchFilterId, scan);
    }
  }
  return latest;
}

/** Each filter's most recently finished successful scan, which is where `newMatches` comes from. */
export function selectLatestCompletedScans<T extends ScanLike>(scans: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const scan of scans) {
    if (scan.status !== "completed" || !scan.finishedAt) continue;
    const current = latest.get(scan.searchFilterId);
    if (!current || scan.finishedAt > (current.finishedAt ?? "")) {
      latest.set(scan.searchFilterId, scan);
    }
  }
  return latest;
}
