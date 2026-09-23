export type MonotonicGalleryStatus = "FAILED" | "PARTIAL" | "COMPLETE";

/**
 * A gallery request queued for the browser extension has no proactive
 * reaper anywhere in this codebase: unlike Finder's own source_scans
 * (failStaleScans, scan-lifecycle.ts), nothing ever transitions a listing's
 * gallery out of PENDING/RUNNING if no extension instance ever claims the
 * job. Confirmed live in production: facebook_scan_jobs' own
 * FACEBOOK_JOB_LEASE_EXPIRED check only fires for a job an extension
 * already claimed and then went silent on — a job that was never claimed
 * at all just sits PENDING forever, showing "Oczekuje na pobranie galerii"
 * with no way to tell the user it has effectively failed.
 *
 * This is a display-time computation, not a database writer: the next real
 * "Napraw galerię" click still re-requests a fresh job exactly as before.
 * A generous bound (much longer than the extension's own ~30s per-step
 * timeout) — this is meant to catch "no worker ever came," not to race a
 * legitimately slow but active fetch.
 */
export const GALLERY_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export const FACEBOOK_GALLERY_TIMEOUT_CODE = "FACEBOOK_GALLERY_TIMEOUT";

export function isGalleryRequestTimedOut(
  status: "NOT_REQUESTED" | "PENDING" | "RUNNING" | "PARTIAL" | "COMPLETE" | "FAILED" | null | undefined,
  requestedAt: string | null | undefined,
  now: number,
  timeoutMs: number = GALLERY_REQUEST_TIMEOUT_MS,
): boolean {
  if (status !== "PENDING" && status !== "RUNNING") return false;
  if (!requestedAt) return false;
  const requestedMs = Date.parse(requestedAt);
  if (!Number.isFinite(requestedMs)) return false;
  return now - requestedMs >= timeoutMs;
}

/**
 * The single canonical place a raw gallery_status/gallery_requested_at pair
 * is turned into what the UI actually shows — used by both Finder
 * (filter-results.ts) and the Watcher (server.ts) so a stuck PENDING/RUNNING
 * gallery reads as a normal, actionable FAILED state (the existing "Ponów
 * pobieranie zdjęć" retry copy already covers it) in both places identically,
 * never duplicated or allowed to drift between the two.
 */
export function effectiveGalleryDisplayState(
  status: "NOT_REQUESTED" | "PENDING" | "RUNNING" | "PARTIAL" | "COMPLETE" | "FAILED" | null,
  requestedAt: string | null,
  errorCode: string | null,
  now: number = Date.now(),
): { status: "NOT_REQUESTED" | "PENDING" | "RUNNING" | "PARTIAL" | "COMPLETE" | "FAILED" | null; error: string | null } {
  if (isGalleryRequestTimedOut(status, requestedAt, now)) {
    return { status: "FAILED", error: FACEBOOK_GALLERY_TIMEOUT_CODE };
  }
  return { status, error: errorCode };
}

export type MonotonicGalleryFailure = {
  status: MonotonicGalleryStatus;
  persistedTotal: number;
  total: number;
};

/**
 * A failed hydration must never erase an already persisted gallery. The
 * metadata count is only evidence that a prior exact gallery existed; it is
 * never used to invent new images or increase the gallery total.
 */
export function deriveMonotonicGalleryFailure(input: {
  currentStatus: unknown;
  imageCount: number;
  persistedCount: number;
  total: number;
  exactMetadataCount: number;
}): MonotonicGalleryFailure {
  const imageCount = bounded(input.imageCount);
  const persistedCount = bounded(input.persistedCount);
  const total = bounded(input.total);
  const exactMetadataCount = bounded(input.exactMetadataCount);
  const persistedTotal = Math.max(imageCount, persistedCount);
  const hasPriorResult = persistedTotal > 0 || exactMetadataCount > 0;
  const currentStatus = input.currentStatus === "COMPLETE" ? "COMPLETE" : input.currentStatus === "PARTIAL" ? "PARTIAL" : null;
  const status: MonotonicGalleryStatus = currentStatus === "COMPLETE" ? "COMPLETE" : !hasPriorResult ? "FAILED" : "PARTIAL";
  return { status, persistedTotal, total: Math.max(total, persistedTotal) };
}

function bounded(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(50, Math.floor(value)) : 0;
}
