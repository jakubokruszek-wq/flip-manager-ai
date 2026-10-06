import "server-only";

/**
 * Durable continuation rules for Finder-owned source scans.
 *
 * The first invocation can only spend the platform's remaining execution
 * window on a bounded slice of each source. A timeout is therefore a queued
 * continuation, not a terminal source failure. These pure helpers keep the
 * retry policy explicit and make the database claim RPC easy to test without
 * contacting Supabase.
 */
// How often a pending/timed-out source becomes eligible for another
// continuation claim. Was 1 hour; a read-only diagnosis of this repo's own
// GitHub Actions logs found the `schedule` trigger firing only every 6-9h in
// practice, so the hourly figure was never really "once an hour" on
// Production -- shrinking it only helps once something actually calls the
// continuation route this often (the GitHub Actions cron below, and/or
// cron-job.org as a more reliable external trigger).
export const CONTINUATION_RETRY_INTERVAL_MS = 5 * 60 * 1000;
export const CONTINUATION_LEASE_MS = 4 * 60 * 1000;
// Deliberately NOT derived from CONTINUATION_RETRY_INTERVAL_MS any more (it
// used to be exactly 2x the old hourly interval). Shrinking the retry cadence
// must never shrink how long a genuinely pending row is tolerated before
// failStaleScans/expireStaleFinderSourceScans or this module's own
// isContinuationExpired treat it as abandoned -- a real external trigger gap
// (GitHub Actions' own `schedule` event has been observed idle for 6-9h) must
// never cause a still-legitimately-queued row to be reaped just because
// retries are now more frequent. Kept at its previous literal value (2h).
export const CONTINUATION_MAX_WAIT_MS = 2 * 60 * 60 * 1000;
// A first invocation may be killed after changing a row to `running`, before
// it can attach a continuation lease. Keep a short grace period so a healthy
// adapter is not stolen while it is still inside its original timeout, then
// let the next claim recover that orphaned row. Independent of the retry
// cadence above -- this is about in-flight "running" time, not how often a
// waiting row gets retried.
export const CONTINUATION_ORPHAN_GRACE_MS = 5 * 60 * 1000;
// A single worker invocation can never exceed the platform's own hard
// function-kill ceiling (every Finder scan route declares `maxDuration = 60`
// -- see app/api/flip-finder/search-filters/[id]/scan/route.ts and the
// scheduler/continuation routes). A "pending" source that has sat untouched
// for longer than that cannot possibly still be inside the invocation that
// reserved it, regardless of whether that invocation got around to writing a
// SOURCE_TIMEOUT: marker on it before being killed.
export const SOURCE_INVOCATION_CEILING_MS = 60_000;
// A source that keeps hitting its own per-fetch timeout is backed off
// instead of retried at the full cadence forever -- a chronically slow or
// blocked portal must not be hammered every single cycle. Grows
// geometrically with the row's own continuation_attempt count, capped well
// under CONTINUATION_MAX_WAIT_MS so a run can still make several more
// attempts within its abandonment window.
export const MAX_CONTINUATION_TIMEOUT_BACKOFF_MS = 30 * 60 * 1000;
// Hard ceiling on how many times a single source may be retried after its own
// fetch timed out, independent of backoff. Without this, a portal that always
// times out (never 403s, never completes) would be retried forever. At the
// capped 30-minute backoff this is up to ~6h of attempts -- deliberately
// longer than CONTINUATION_MAX_WAIT_MS alone, so in practice the attempt cap
// is what ends a chronically-failing source, not a race with age-based expiry.
export const MAX_CONTINUATION_ATTEMPTS = 12;

export type ContinuationSourceState = {
  id: string;
  source: string;
  status: string;
  continuationNextAt?: string | null;
  continuationCycleAt?: string | null;
  continuationLeaseUntil?: string | null;
  startedAt?: string | null;
};

export function continuationCycleAt(now: number | Date): string {
  const timestamp = now instanceof Date ? now.getTime() : now;
  const cycle = Math.floor(timestamp / CONTINUATION_RETRY_INTERVAL_MS) * CONTINUATION_RETRY_INTERVAL_MS;
  return new Date(cycle).toISOString();
}

export function nextContinuationAt(now: number | Date): string {
  const timestamp = now instanceof Date ? now.getTime() : now;
  return new Date(Math.floor(timestamp / CONTINUATION_RETRY_INTERVAL_MS) * CONTINUATION_RETRY_INTERVAL_MS + CONTINUATION_RETRY_INTERVAL_MS).toISOString();
}

export function isContinuationPending(errorMessage: string | null | undefined): boolean {
  return typeof errorMessage === "string" && /^(SOURCE_TIMEOUT|SOURCE_BUDGET_EXHAUSTED|SOURCE_SLICE_YIELD):/.test(errorMessage);
}

export function isContinuationExpired(errorMessage: string | null | undefined, continuationNextAt: string | null | undefined, now: number | Date): boolean {
  if (!isContinuationPending(errorMessage) || !continuationNextAt) return false;
  const nextAtMs = Date.parse(continuationNextAt);
  const nowMs = now instanceof Date ? now.getTime() : now;
  return Number.isFinite(nextAtMs) && nextAtMs + CONTINUATION_MAX_WAIT_MS <= nowMs;
}

export function isPermanentSourceFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /(?:HTTP\s*)?403\b|FORBIDDEN|ACCESS_DENIED/i.test(message);
}

export function continuationEligible(state: ContinuationSourceState, now: number | Date, cycleAt = continuationCycleAt(now)): boolean {
  if (state.source === "olx" || state.source === "facebook") return false;
  if (state.status !== "pending" && state.status !== "running") return false;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const nextAtMs = state.continuationNextAt ? Date.parse(state.continuationNextAt) : Number.NaN;
  if (Number.isFinite(nextAtMs) && nextAtMs > nowMs) return false;
  const leaseUntilMs = state.continuationLeaseUntil ? Date.parse(state.continuationLeaseUntil) : Number.NaN;
  if (Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) return false;
  const lastCycleMs = state.continuationCycleAt ? Date.parse(state.continuationCycleAt) : Number.NaN;
  const cycleMs = Date.parse(cycleAt);
  if (Number.isFinite(lastCycleMs) && lastCycleMs >= cycleMs) return false;
  if (state.status === "running") {
    if (!Number.isFinite(leaseUntilMs)) {
      const startedAtMs = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
      if (!Number.isFinite(startedAtMs) || startedAtMs + CONTINUATION_ORPHAN_GRACE_MS > nowMs) return false;
    }
  }
  return true;
}

export function claimContinuationRows<T extends ContinuationSourceState>(rows: readonly T[], now: number | Date, cycleAt = continuationCycleAt(now)): T[] {
  const seen = new Set<string>();
  return rows
    .filter((row) => continuationEligible(row, now, cycleAt))
    .filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
}

export type SourceFailureDisposition = {
  status: "pending" | "failed";
  errorCode: "SOURCE_TIMEOUT" | "SOURCE_FORBIDDEN" | "SOURCE_FAILED" | "SOURCE_CONTINUATION_EXHAUSTED";
  nextAttemptAt: string | null;
};

/**
 * Geometric backoff keyed on the row's own continuation_attempt count (1 =
 * its first timeout). Capped at MAX_CONTINUATION_TIMEOUT_BACKOFF_MS so a
 * chronically slow/blocked portal is retried less and less often instead of
 * being hammered every single CONTINUATION_RETRY_INTERVAL_MS cycle forever.
 */
export function continuationBackoffMs(attempt: number): number {
  const steps = Math.max(0, Math.floor(attempt) - 1);
  const scaled = CONTINUATION_RETRY_INTERVAL_MS * Math.min(2 ** steps, 64);
  return Math.min(scaled, MAX_CONTINUATION_TIMEOUT_BACKOFF_MS);
}

/**
 * `attempt` is "how many times has this source now timed out, including this
 * one" (1 on its first timeout). Callers that have not yet threaded a real
 * continuation_attempt count through default to 1 -- the same behavior as
 * before backoff existed, just no longer snapped to the next cycle boundary
 * (see continuationBackoffMs; the claim RPC's own continuation_cycle_at check
 * does not require next_at to be cycle-aligned, only that it is <= now).
 */
export function classifySourceFailure(input: { timedOut: boolean; error: unknown; attempt?: number; now?: number | Date }): SourceFailureDisposition {
  const now = input.now ?? Date.now();
  // A returned access denial remains terminal even if the deadline fired
  // while its response was being handled.
  if (isPermanentSourceFailure(input.error)) return { status: "failed", errorCode: "SOURCE_FORBIDDEN", nextAttemptAt: null };
  if (input.timedOut) {
    const attempt = input.attempt && input.attempt > 0 ? input.attempt : 1;
    if (attempt >= MAX_CONTINUATION_ATTEMPTS) {
      return { status: "failed", errorCode: "SOURCE_CONTINUATION_EXHAUSTED", nextAttemptAt: null };
    }
    const nowMs = now instanceof Date ? now.getTime() : now;
    return { status: "pending", errorCode: "SOURCE_TIMEOUT", nextAttemptAt: new Date(nowMs + continuationBackoffMs(attempt)).toISOString() };
  }
  return { status: "failed", errorCode: "SOURCE_FAILED", nextAttemptAt: null };
}

/**
 * A "pending" source is genuinely waiting on continuation -- not possibly
 * still being actively worked on by the invocation that reserved it -- once
 * either it already carries a SOURCE_TIMEOUT: marker, or more time than a
 * single invocation can ever legally run (SOURCE_INVOCATION_CEILING_MS) has
 * passed since its reservation. The second arm matters because a prepared
 * row the sequential worker loop never reached before being killed outright
 * (not merely timing out one source, but the whole platform-level 60s cutoff
 * landing mid-loop) is left with no error_message at all -- previously that
 * made it look identical to one still being actively scanned, forever,
 * instead of just until this threshold passes. expireStaleFinderSourceScans
 * (server/scan-progress.ts) already self-heals this by writing a real marker
 * once SOURCE_INVOCATION_CEILING_MS has elapsed, but only on a poll that
 * actually reaches it; this function makes the UI-facing read correct even on
 * a cold first read, before any such write has happened.
 */
export function isGenuinelyAwaitingContinuation(status: string, errorMessage: string | null | undefined, startedAt: string | null | undefined, now: number | Date): boolean {
  if (status !== "pending") return false;
  if (isContinuationPending(errorMessage)) return true;
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(startedMs)) return false;
  const nowMs = now instanceof Date ? now.getTime() : now;
  return nowMs - startedMs >= SOURCE_INVOCATION_CEILING_MS;
}
