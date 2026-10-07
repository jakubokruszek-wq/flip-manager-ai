import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import { activeSources } from "@/features/flip-finder/server/search-source-registry";
import { listActiveSearchFiltersForScheduler } from "@/features/flip-finder/server/search-filters";
import {
  runManualOtodomScan,
  startFinderScanForFilter,
  type ManualScanStart,
  type ScanSummary,
} from "@/features/flip-finder/server/manual-scan";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient as DatabaseClient } from "@supabase/supabase-js";
import { FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES, finderScanIntervalMinutes, isFinderScanDue } from "@/features/flip-finder/finder-schedule";

export { FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES, finderScanIntervalMinutes, isFinderScanDue };

// A Finder run itself can spend nearly the full 50-second worker window.
// Starting one filter per HTTP invocation keeps the endpoint safely below
// the routes' current 60-second limit; the five-minute trigger picks up the
// next due filter on its next invocation.
export const FINDER_SCHEDULER_MAX_FILTERS_PER_RUN = 1;
const FINDER_SCHEDULER_DB_TIMEOUT_MS = 8_000;

export type FinderSchedulerSummary = {
  status: "completed" | "partial";
  checked: number;
  due: number;
  started: number;
  skippedRunning: number;
  skippedNotDue: number;
  completed: number;
  partial: number;
  errors: string[];
  runs: Array<{ filterId: string; runId: string; status: ScanSummary["status"] }>;
};

export type FinderSchedulerDependencies = {
  listFilters: () => Promise<SearchFilter[]>;
  hasRunningScan: (filter: SearchFilter) => Promise<boolean>;
  /** Atomic cadence claim; prevents two scheduler instances from starting one filter. */
  claimFilter: (filter: SearchFilter, now: Date) => Promise<boolean>;
  /**
   * Restores the cadence clock a successful claimFilter just advanced, for
   * when the scan it claimed for never actually started. Without this, a
   * single transient reservation failure (a DB timeout, a dropped
   * connection -- anything other than "a scan is already running") would
   * silently delay the next automatic attempt by a full
   * finder_scan_interval_minutes, even though the five-minute scheduler
   * trigger could have retried it on its very next tick.
   */
  revertClaim: (filter: SearchFilter, claimedAt: Date) => Promise<void>;
  startScan: (filter: SearchFilter) => Promise<ManualScanStart>;
  runScan: (filter: SearchFilter, start: ManualScanStart) => Promise<ScanSummary>;
};

/** A filter with only unavailable source IDs is never handed to a worker. */
export function finderFilterCanRun(filter: SearchFilter): boolean {
  return activeSources(filter).length > 0 || filter.sources.includes("facebook");
}

export function dueFinderFilters(filters: readonly SearchFilter[], now: Date | number): SearchFilter[] {
  return filters.filter((filter) => finderFilterCanRun(filter) && isFinderScanDue({
    isActive: filter.isActive,
    lastScannedAt: filter.lastScannedAt,
    scanIntervalMinutes: filter.finderScanIntervalMinutes ?? FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES,
    now,
  }));
}

export async function runFinderScanScheduler(now = new Date(), overrides: Partial<FinderSchedulerDependencies> = {}): Promise<FinderSchedulerSummary> {
  const dependencies = defaultDependencies(overrides);
  const filters = await dependencies.listFilters();
  const due = dueFinderFilters(filters, now);
  const summary: FinderSchedulerSummary = {
    status: "completed",
    checked: filters.length,
    due: due.length,
    started: 0,
    skippedRunning: 0,
    skippedNotDue: Math.max(0, filters.length - due.length),
    completed: 0,
    partial: 0,
    errors: [],
    runs: [],
  };

  for (const filter of due) {
    if (summary.started >= FINDER_SCHEDULER_MAX_FILTERS_PER_RUN) break;
    try {
      if (await dependencies.hasRunningScan(filter)) {
        summary.skippedRunning += 1;
        continue;
      }
      if (!await dependencies.claimFilter(filter, now)) {
        summary.skippedRunning += 1;
        continue;
      }
      let start: ManualScanStart;
      try {
        start = await dependencies.startScan(filter);
      } catch (startError) {
        if (isRunningScanError(startError)) {
          summary.skippedRunning += 1;
          continue;
        }
        // The claim already advanced last_scanned_at, but no scan actually
        // started -- revert it so this filter is still due on the next
        // (five-minute) scheduler tick instead of waiting out a full
        // interval for nothing.
        await dependencies.revertClaim(filter, now).catch((revertError) => {
          console.error("FINDER_SCHEDULER_CLAIM_REVERT_FAILED", {
            filterId: filter.id,
            error: revertError instanceof Error ? revertError.message : "unknown",
          });
        });
        throw startError;
      }
      summary.started += 1;
      const result = await dependencies.runScan(filter, start);
      summary.runs.push({ filterId: filter.id, runId: result.runId, status: result.status });
      if (result.status === "completed") summary.completed += 1;
      else summary.partial += 1;
    } catch (error) {
      if (isRunningScanError(error)) {
        summary.skippedRunning += 1;
        continue;
      }
      summary.status = "partial";
      summary.errors.push(`${filter.id}: ${error instanceof Error ? error.message : "Nie udało się uruchomić skanu."}`);
    }
  }

  if (summary.errors.length) summary.status = "partial";
  return summary;
}

function defaultDependencies(overrides: Partial<FinderSchedulerDependencies>): FinderSchedulerDependencies {
  const supabase = createAdminClient();
  return {
    listFilters: listActiveSearchFiltersForScheduler,
    hasRunningScan: (filter) => hasRunningFinderScan(supabase, filter),
    claimFilter: (filter, now) => claimFinderFilter(supabase, filter, now),
    revertClaim: (filter, claimedAt) => revertFinderFilterClaim(supabase, filter, claimedAt),
    startScan: (filter) => startFinderScanForFilter(filter, undefined, supabase, "scheduler"),
    runScan: (filter, start) => runManualOtodomScan(filter.id, {
      filter,
      runId: start.runId,
      supabase,
      skipLock: true,
      usePreparedRows: true,
    }),
    ...overrides,
  };
}

/**
 * Exported (beyond defaultDependencies' own use) so a test can drive this
 * exact query -- the real CAS, not a stand-in for it -- against a real
 * Postgres engine (see finder-scheduler-postgres-cas.test.ts), proving the
 * UPDATE...WHERE pattern itself is a sound compare-and-swap, not just that
 * finder-scheduler.test.ts's injected-dependency stubs behave as told.
 */
export async function claimFinderFilter(supabase: DatabaseClient, filter: SearchFilter, now: Date): Promise<boolean> {
  let query = supabase
    .from("search_filters")
    .update({ last_scanned_at: now.toISOString() })
    .eq("id", filter.id);
  query = filter.lastScannedAt
    ? query.eq("last_scanned_at", filter.lastScannedAt)
    : query.is("last_scanned_at", null);
  const { data, error } = await query
    .select("id")
    .abortSignal(AbortSignal.timeout(FINDER_SCHEDULER_DB_TIMEOUT_MS))
    .maybeSingle();
  if (error) throw new Error(`FINDER_SCHEDULER_CLAIM_FAILED: ${error.message}`);
  return Boolean(data && typeof data === "object" && "id" in data);
}

/**
 * CAS'd on the exact value claimFinderFilter just wrote: if last_scanned_at
 * has since moved again (e.g. a concurrently completed scan from a
 * different trigger wrote a newer, more accurate timestamp), this must not
 * clobber that newer value back to the filter's pre-claim state.
 */
export async function revertFinderFilterClaim(supabase: DatabaseClient, filter: SearchFilter, claimedAt: Date): Promise<void> {
  const { error } = await supabase
    .from("search_filters")
    .update({ last_scanned_at: filter.lastScannedAt ?? null })
    .eq("id", filter.id)
    .eq("last_scanned_at", claimedAt.toISOString())
    .abortSignal(AbortSignal.timeout(FINDER_SCHEDULER_DB_TIMEOUT_MS));
  if (error) throw new Error(`FINDER_SCHEDULER_CLAIM_REVERT_FAILED: ${error.message}`);
}

async function hasRunningFinderScan(supabase: DatabaseClient, filter: SearchFilter): Promise<boolean> {
  const sourceIds = activeSources(filter).map((source) => source.id);
  if (!sourceIds.length) return false;
  const { data, error } = await supabase
    .from("source_scans")
    .select("id")
    .eq("search_filter_id", filter.id)
    .in("source", sourceIds)
    .in("status", ["pending", "running"])
    .limit(1)
    .abortSignal(AbortSignal.timeout(FINDER_SCHEDULER_DB_TIMEOUT_MS));
  if (error) throw new Error(`FINDER_SCHEDULER_LOCK_READ_FAILED: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

function isRunningScanError(error: unknown): boolean {
  const status = error && typeof error === "object" && "status" in error ? (error as { status?: unknown }).status : null;
  if (status === 409 || status === 429) return true;
  return error instanceof Error && /Skan tego filtra|SCAN_ALREADY_RUNNING/i.test(error.message);
}
