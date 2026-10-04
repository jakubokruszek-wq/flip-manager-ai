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
export const CONTINUATION_INTERVAL_MS = 60 * 60 * 1000;
export const CONTINUATION_LEASE_MS = 4 * 60 * 1000;
// A first invocation may be killed after changing a row to `running`, before
// it can attach a continuation lease. Keep a short grace period so a healthy
// adapter is not stolen while it is still inside its original timeout, then
// let the hourly claim recover that orphaned row.
export const CONTINUATION_ORPHAN_GRACE_MS = 5 * 60 * 1000;

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
  const cycle = Math.floor(timestamp / CONTINUATION_INTERVAL_MS) * CONTINUATION_INTERVAL_MS;
  return new Date(cycle).toISOString();
}

export function nextContinuationAt(now: number | Date): string {
  const timestamp = now instanceof Date ? now.getTime() : now;
  return new Date(Math.floor(timestamp / CONTINUATION_INTERVAL_MS) * CONTINUATION_INTERVAL_MS + CONTINUATION_INTERVAL_MS).toISOString();
}

export function isContinuationPending(errorMessage: string | null | undefined): boolean {
  return typeof errorMessage === "string" && errorMessage.startsWith("SOURCE_TIMEOUT:");
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
  const lastCycleMs = state.continuationCycleAt ? Date.parse(state.continuationCycleAt) : Number.NaN;
  const cycleMs = Date.parse(cycleAt);
  if (Number.isFinite(lastCycleMs) && lastCycleMs >= cycleMs) return false;
  if (state.status === "running") {
    const leaseUntilMs = state.continuationLeaseUntil ? Date.parse(state.continuationLeaseUntil) : Number.NaN;
    if (Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) return false;
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
  errorCode: "SOURCE_TIMEOUT" | "SOURCE_FORBIDDEN" | "SOURCE_FAILED";
  nextAttemptAt: string | null;
};

export function classifySourceFailure(input: { timedOut: boolean; error: unknown; now?: number | Date }): SourceFailureDisposition {
  const now = input.now ?? Date.now();
  if (input.timedOut) return { status: "pending", errorCode: "SOURCE_TIMEOUT", nextAttemptAt: nextContinuationAt(now) };
  if (isPermanentSourceFailure(input.error)) return { status: "failed", errorCode: "SOURCE_FORBIDDEN", nextAttemptAt: null };
  return { status: "failed", errorCode: "SOURCE_FAILED", nextAttemptAt: null };
}
