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
export function scanHeartbeatAt(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const progress = (snapshot as Record<string, unknown>)._scanProgress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return null;
  const value = (progress as Record<string, unknown>).lastProgressAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function isStaleScan(scan: { status: string; startedAt: string | null; heartbeatAt?: string | null }, now: number, timeoutMs: number = STALE_SCAN_TIMEOUT_MS): boolean {
  if (!(RECOVERABLE_SCAN_STATUSES as readonly string[]).includes(scan.status)) return false;
  const startedMs = scan.startedAt ? Date.parse(scan.startedAt) : Number.NaN;
  if (!Number.isFinite(startedMs)) return false;
  const heartbeatMs = scan.heartbeatAt ? Date.parse(scan.heartbeatAt) : Number.NaN;
  const lastActivityMs = Number.isFinite(heartbeatMs) ? Math.max(startedMs, heartbeatMs) : startedMs;
  return now - lastActivityMs >= timeoutMs;
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

export type ExistingSourceScanForResumption = { id: string; source: string; status: string; scanRunId: string | null };

export type ScanResumptionDecision =
  | { kind: "start_fresh" }
  | { kind: "resume"; runId: string }
  | { kind: "ambiguous_refuse"; reason: "SOURCE_RUNNING" | "MULTIPLE_RUN_IDS" | "MISSING_RUN_ID" };

/**
 * Decides whether a manual scan start can safely resume an existing,
 * unfinished run instead of either (a) creating a second scan_run_id for
 * the same filter, or (b) refusing with 429 forever while a dead
 * continuation (e.g. a GitHub Actions schedule that never fired) leaves
 * pending rows sitting there for hours.
 *
 * `nonTerminalRows` must already be filtered to RECOVERABLE_SCAN_STATUSES
 * (pending/running) for this filter's lockable sources, AFTER failStaleScans
 * has run -- so any row genuinely abandoned (no heartbeat for
 * STALE_SCAN_TIMEOUT_MS) has already been reaped to "failed" and will not
 * appear here. That ordering is what makes "any remaining running row ->
 * refuse" safe: it is never stale by the time this function sees it, so it
 * is either a live worker or an active, non-expired continuation lease --
 * either way, something may genuinely be touching it right now, and taking
 * it over would risk double-processing or clobbering that work. A "pending"
 * row never holds a continuation lease (deferPreparedSource/
 * failOwnedRunningScans both null it out when a row becomes pending), so
 * there is no separate lease check needed for the resumable case: the
 * per-row CAS in scanSource() is what actually prevents two resumers (or a
 * resumer racing a continuation claim) from both processing the same row,
 * regardless of how many callers independently reach a "resume" decision.
 */
export function decideScanResumption(nonTerminalRows: readonly ExistingSourceScanForResumption[]): ScanResumptionDecision {
  if (!nonTerminalRows.length) return { kind: "start_fresh" };
  if (nonTerminalRows.some((row) => row.status === "running")) return { kind: "ambiguous_refuse", reason: "SOURCE_RUNNING" };
  const runIds = new Set(nonTerminalRows.map((row) => row.scanRunId));
  if (runIds.size > 1) return { kind: "ambiguous_refuse", reason: "MULTIPLE_RUN_IDS" };
  const [runId] = runIds;
  if (!runId) return { kind: "ambiguous_refuse", reason: "MISSING_RUN_ID" };
  return { kind: "resume", runId };
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
