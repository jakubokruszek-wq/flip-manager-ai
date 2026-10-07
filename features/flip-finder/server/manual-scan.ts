import "server-only";

import { evaluateListingAgainstFilter } from "@/features/flip-finder/filter-evaluation";
import { addMatchDiagnostic, createMatchDiagnostic, emptyMatchDiagnosticSummary, mergeMatchDiagnosticSummaries, type MatchDiagnosticSummary } from "@/features/flip-finder/match-diagnostics";
import { addScanItemCounts, type ScanItemCounts } from "@/features/flip-finder/scan-counters";
import { activeSources, type SourceFetchResult, type SourceListing, type SearchSource } from "@/features/flip-finder/server/search-source-registry";
import { enqueueOlxJob, existingOlxScanResult, resumableOlxRunId } from "@/features/flip-finder/server/olx-jobs";
import { persistListing } from "@/features/flip-finder/server/persist-listing";
import { reuseExistingListingAttributes } from "@/features/flip-finder/server/listing-attribute-reuse";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import { recalculateFilterMatches } from "@/features/flip-finder/server/filter-match-recalculation";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient as DatabaseClient } from "@supabase/supabase-js";
import { decideScanResumption, isStaleScan, RECOVERABLE_SCAN_STATUSES, scanHeartbeatAt, STALE_SCAN_MESSAGE, STALE_SCAN_TIMEOUT_MS, staleScanCutoff, type ExistingSourceScanForResumption } from "./scan-lifecycle";
import { CONTINUATION_LEASE_MS, CONTINUATION_MAX_WAIT_MS, classifySourceFailure, continuationCycleAt, isContinuationExpired, isContinuationPending, nextContinuationAt } from "./scan-continuation";
import { assertCheckpointSize, emptySourceCheckpoint, readSourceCheckpoint, SourceSliceYield, type SourceCheckpoint } from "./source-checkpoint";
import type { SourceBatch } from "../source-batches";
export { scanStatus } from "./scan-start-errors";

export type SourceScanResult = { source: string; status: "pending" | "completed" | "failed"; fetched: number; normalized: number; matched: number; listingsCreated: number; newMatches: number; updated: number; priceDrops: number; rejected: number; durationMs: number; errorCode: string | null; errorMessage: string | null; warnings?: string[]; matchDiagnostics: MatchDiagnosticSummary };
export type ScanSummary = { runId: string; status: "running" | "completed" | "partial"; sourcesRun: number; sourcesCompleted: number; sourcesFailed: number; fetched: number; normalized: number; listingsCreated: number; newMatches: number; updated: number; priceDrops: number; rejected: number; actualErrors: number; sourceResults: SourceScanResult[]; matchDiagnostics: MatchDiagnosticSummary; scannedCount: number; matchedCount: number; newCount: number; updatedCount: number; priceDropCount: number; warnings: string[] };
type SupabaseClient = DatabaseClient;
type LoadedFilter = NonNullable<Awaited<ReturnType<typeof getSearchFilter>>>;
type Progress = { fetched: number; matched: number; counters: ScanItemCounts; updated: number; priceDrops: number };
export type ScanClock = { startedAt: string; startedMs: number; continuationLeaseToken?: string | null };
export type PreparedSourceScan = { id: string; source: string; status?: string; started_at: string; continuation_lease_token?: string | null; continuation_attempt?: number | null; continuation_next_at?: string | null; continuation_lease_until?: string | null; filter_snapshot?: unknown };
export type ManualScanOptions = {
  runId?: string;
  usePreparedRows?: boolean;
  skipLock?: boolean;
  /** Service scheduler override; user-facing routes keep loading by id. */
  filter?: LoadedFilter;
  /** Reuse the scheduler's already-created service client. */
  supabase?: SupabaseClient;
};
export type FinderScanOrigin = "manual" | "scheduler";

// The current routes explicitly cap execution at 60s. The actual project's
// Fluid Compute configuration is unverified, so keep a finalization margin.
export const SOURCE_TIMEOUT_MS = 30_000;
const DATABASE_TIMEOUT_MS = 12_000;
// Mirrors the scan routes' `export const maxDuration = 60` -- keep this
// internal deadline below the platform limit.
export const WORKER_MAX_DURATION_MS = 50_000;
// Reserves time for everything in runManualOtodomScan besides the sequential
// per-source fetch loop itself: getSearchFilter, lock/staleness checks,
// enqueueOlxJob, reconciliation, final updates, and cleanup writes.
export const WORKER_OVERHEAD_RESERVE_MS = 15_000;
// A meaningful lower bound when a caller supplies a shorter remaining slice.
// The worker's deadline defers sources rather than dividing 35s among all
// configured sources. Normal attempts use sourceTimeoutBudgetMs(1).
export const MIN_SOURCE_TIMEOUT_MS = 10_000;

/**
 * Bounds the per-source fetch timeout for one bounded worker portion. When
 * many sources are active the minimum timeout is intentional: the caller's
 * deadline defers any rows that cannot fit to the durable continuation rather
 * than starting work it cannot finish before the platform limit.
 */
export function sourceTimeoutBudgetMs(sourceCount: number, ceilingMs: number = SOURCE_TIMEOUT_MS): number {
  if (sourceCount <= 0) return ceilingMs;
  const available = WORKER_MAX_DURATION_MS - WORKER_OVERHEAD_RESERVE_MS;
  return Math.max(MIN_SOURCE_TIMEOUT_MS, Math.min(ceilingMs, Math.floor(available / sourceCount)));
}

export function sourceScanMetrics(result: SourceFetchResult, matchedCount: number) {
  return { scannedCount: result.fetched, listingsFound: result.fetched, matchedCount };
}

export type ManualScanStart = { runId: string; status: "running"; background: boolean; scannedCount: number; matchedCount: number; newCount: number; updatedCount: number; priceDropCount: number };

/**
 * Reserves Finder-owned source rows before returning the HTTP response. The
 * worker is then scheduled by the route through next/server's after(), so a
 * slow adapter cannot leave the browser waiting on a request that never
 * returns a run id. Facebook-only Finder recalculations deliberately do not
 * use this reservation because their source_scans rows belong exclusively to
 * the independent Watcher.
 */
export async function startManualOtodomScan(filterId: string): Promise<ManualScanStart> {
  const runId = crypto.randomUUID();
  const filter = await getSearchFilter(filterId);
  if (!filter) throw statusError(404, "Nie znaleziono filtra.");
  return startFinderScanForFilter(filter, runId);
}

/**
 * Starts a Finder-owned run for a filter already loaded by a trusted server
 * caller. The scheduler uses this to avoid a browser-session dependency while
 * preserving the same source reservation and duplicate-scan lock as the
 * operator-facing route.
 *
 * The returned runId may differ from the one passed in: when an existing,
 * unambiguous, unfinished run for this filter is found (see
 * reserveOrResumeSourceScans), that run is resumed and ITS id is returned
 * instead, so the caller's own runAfterResponse(() =>
 * runManualOtodomScan(filterId, { runId: start.runId, usePreparedRows: true,
 * ... })) naturally continues the right run without any further change.
 */
export async function startFinderScanForFilter(filter: LoadedFilter, runId = crypto.randomUUID(), supabase = createAdminClient(), origin: FinderScanOrigin = "manual"): Promise<ManualScanStart> {
  if (!filter.isActive) throw statusError(409, "Filtr jest wstrzymany.");
  const sources = activeSources(filter);
  const sourceIds = [...sources.map((source) => source.id), ...(filter.sources.includes("facebook") ? ["facebook"] : [])];
  if (!sourceIds.length) throw statusError(400, "Filtr nie zawiera aktywnego obsługiwanego źródła.");
  // OLX is owned by its separate local-worker queue. Do not reserve a
  // Finder source_scans row for it; enqueueOlxJob creates the one async row.
  const lockableSourceIds = sources.filter((source) => source.id !== "olx").map((source) => source.id);
  let olxRunId: string | null = null;
  if (sources.some((source) => source.id === "olx")) {
    try {
      olxRunId = await resumableOlxRunId(filter.id, supabase);
    } catch (error) {
      if (error instanceof Error && error.message === "OLX_MULTIPLE_RUN_IDS") throw statusError(429, "Kolejka OLX ma niespójne, równoległe przebiegi.");
      throw statusError(500, error instanceof Error ? error.message : "Nie udało się sprawdzić kolejki OLX.");
    }
  }
  let actualRunId = olxRunId ?? runId;
  if (lockableSourceIds.length) {
    await failStaleScans(supabase, filter.id, lockableSourceIds);
    actualRunId = await reserveOrResumeSourceScans(supabase, filter.id, lockableSourceIds, actualRunId, filter, origin);
    if (olxRunId && actualRunId !== olxRunId) throw statusError(429, "Filtr ma niezgodne, równoległe przebiegi skanu.");
  }
  if (sources.some((source) => source.id === "olx") && !(await existingOlxScanResult(actualRunId, supabase))) {
    await enqueueOlxJob(filter, actualRunId, supabase);
  }
  console.info("FINDER_SCAN_START_REQUEST", { filterId: filter.id, runId: actualRunId, requestedBy: origin, resumed: actualRunId !== runId });
  return { runId: actualRunId, status: "running", background: lockableSourceIds.length > 0 || sources.some((source) => source.id === "olx"), scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0 };
}

/**
 * Checks whether this filter already has an unambiguous, unfinished run
 * (every non-terminal lockable-source row sharing one scan_run_id, none of
 * them "running") before ever reserving a fresh one -- the fix for a
 * dead/delayed continuation (e.g. a GitHub Actions schedule that never
 * fires) otherwise leaving pending rows that block every later manual start
 * with 429 for up to CONTINUATION_MAX_WAIT_MS (2h), even though no worker is
 * actually touching them.
 *
 * Deliberately NOT a new atomic SQL claim: every write this can lead to is
 * already individually race-safe without one. "resume" never writes
 * anything itself -- it only returns an existing runId, and the real
 * protection against two resumers (or a resumer racing a continuation
 * claim) touching the same source is scanSource()'s own pending->running
 * CAS and claim_finder_scan_source's FOR UPDATE SKIP LOCKED, both already
 * proven elsewhere (manual-scan-lock-separation.test.ts, 20261004120000's
 * own claim function). "start_fresh" still goes through
 * reserveSourceScans()'s existing RPC-or-fallback reservation, unchanged.
 * A genuinely ambiguous state (any running row, or non-terminal rows
 * spanning more than one run_id) still safely refuses with the exact same
 * message as before.
 */
async function reserveOrResumeSourceScans(supabase: SupabaseClient, filterId: string, lockableSourceIds: string[], runId: string, filter: LoadedFilter, origin: FinderScanOrigin): Promise<string> {
  const { data: existing, error: existingError } = await supabase
    .from("source_scans")
    .select("id,source,status,scan_run_id")
    .eq("search_filter_id", filterId)
    .in("source", lockableSourceIds)
    .in("status", [...RECOVERABLE_SCAN_STATUSES])
    .abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
  if (existingError) throw statusError(500, "Nie udało się sprawdzić statusu skanu.");

  const decision = decideScanResumption(toResumptionRows(existing));
  if (decision.kind === "ambiguous_refuse") throw statusError(429, "Skan tego filtra już trwa.");
  if (decision.kind === "resume") {
    console.info("FLIP FINDER SCAN RESUMED", { filterId, runId: decision.runId });
    return decision.runId;
  }

  await reserveSourceScans(supabase, filterId, lockableSourceIds, runId, { ...filter, _finderRunOrigin: origin });
  return runId;
}

function toResumptionRows(data: unknown): ExistingSourceScanForResumption[] {
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const { id, source, status, scan_run_id: scanRunId } = row as Record<string, unknown>;
    if (typeof id !== "string" || typeof source !== "string" || typeof status !== "string") return [];
    return [{ id, source, status, scanRunId: typeof scanRunId === "string" ? scanRunId : null }];
  });
}

/**
 * Issue 1 from the scan-lifecycle review: a plain SELECT-then-INSERT has no
 * database-level mutual exclusion, so two concurrent requests for the same
 * filter can both pass the "already running" check before either commits,
 * reserving two active source_scans rows for the same filter+source pair.
 * reserve_source_scans (supabase/migrations/20261004020000_add_manual_scan_
 * reservation_lock.sql -- a DRAFT, NOT applied) closes this by locking the
 * parent search_filters row with SELECT ... FOR UPDATE, so a second
 * concurrent call blocks until the first transaction commits and then
 * correctly observes it. Until a human applies that migration the function
 * does not exist in the real database, so this must never assume it is
 * live -- calling a function Postgres does not have would break every scan
 * start in production. The fallback below is the exact pre-existing
 * behavior, unchanged, so today's deploys are unaffected either way; once
 * the migration is applied, the very next call here starts getting the real
 * guarantee with no further code change.
 */
async function reserveSourceScans(supabase: SupabaseClient, filterId: string, lockableSourceIds: string[], runId: string, filter: LoadedFilter & { _finderRunOrigin?: FinderScanOrigin }): Promise<void> {
  const { error: rpcError } = await supabase.rpc("reserve_source_scans", {
    p_search_filter_id: filterId,
    p_sources: lockableSourceIds,
    p_scan_run_id: runId,
    p_filter_snapshot: filter,
  });
  if (!rpcError) return;
  if (!isMissingReservationFunction(rpcError)) {
    if (isScanAlreadyRunningError(rpcError)) throw statusError(429, "Skan tego filtra już trwa.");
    throw statusError(500, "Nie udało się zarezerwować skanu.");
  }
  const { data: running, error: runningError } = await supabase.from("source_scans").select("id").eq("search_filter_id", filterId).in("source", lockableSourceIds).in("status", [...RECOVERABLE_SCAN_STATUSES]).limit(1).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
  if (runningError) throw statusError(500, "Nie udało się sprawdzić statusu skanu.");
  if (running?.length) throw statusError(429, "Skan tego filtra już trwa.");
  const { error: reserveError } = await supabase.from("source_scans").insert(lockableSourceIds.map((source) => ({ search_filter_id: filterId, source, status: "pending", scan_run_id: runId, filter_snapshot: filter }))).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
  if (reserveError) throw statusError(500, "Nie udało się zarezerwować skanu.");
}

/**
 * Deliberately code-only, not a message/regex heuristic: PostgREST always
 * sets PGRST202 (and a direct Postgres call would set 42883) for exactly
 * "this function does not exist", so these two codes are both necessary and
 * sufficient. A message-pattern fallback (e.g. matching "does not exist")
 * would also match unrelated errors -- a different missing table/column, a
 * permission error's wording, anything -- and silently route them into the
 * legacy fallback instead of surfacing them, which is precisely the
 * "wyłącznie przy dokładnym błędzie braku funkcji" guarantee this must hold:
 * a permission or validation error from reserve_source_scans itself (e.g.
 * SEARCH_FILTER_NOT_FOUND, SCAN_ALREADY_RUNNING, or a 42501 if the grant is
 * ever missing) must always be treated as a real error, never as "not
 * deployed yet".
 */
function isMissingReservationFunction(error: { code?: unknown }): boolean {
  return error.code === "42883" || error.code === "PGRST202";
}

function isScanAlreadyRunningError(error: { message?: unknown }): boolean {
  return typeof error.message === "string" && /SCAN_ALREADY_RUNNING/.test(error.message);
}

export async function runManualOtodomScan(filterId: string, options: ManualScanOptions = {}): Promise<ScanSummary> {
  const runId = options.runId ?? crypto.randomUUID();
  const scanStarted = Date.now();
  const ownedScans = new Map<string, ScanClock>();
  const sourceResults: SourceScanResult[] = [];
  const filter = options.filter ?? await getSearchFilter(filterId);
  if (!filter) throw statusError(404, "Nie znaleziono filtra.");
  if (!filter.isActive) throw statusError(409, "Filtr jest wstrzymany.");
  const sources = activeSources(filter);
  const facebookEnabled = filter.sources.includes("facebook");
  const sourceIds = [...sources.map((source) => source.id), ...(facebookEnabled ? ["facebook"] : [])];
  if (!sourceIds.length) throw statusError(400, "Filtr nie zawiera aktywnego obsługiwanego źródła.");
  // Second Finder/Watcher separation bug, proven live: source_scans has no
  // per-row owner. Every source_scans row with source="facebook" is written
  // exclusively by the Watcher's own scheduler (features/facebook-worker/
  // jobs.ts's enqueueAutomaticSource) -- a Finder-triggered scan NEVER
  // inserts one for facebook; its own facebook step is the synchronous
  // reconcileFacebookFromCanonicalListings call below, which never touches
  // this table at all (activeSources() only ever returns otodom/olx/
  // morizon). Locking/staleness-recovering "facebook" here therefore never
  // protects Finder against itself -- it can only ever collide with a
  // concurrently active Watcher scan for the same filter, which is exactly
  // what produced "Skan tego filtra już trwa." on Production while the
  // Watcher's own scheduler cycle was genuinely running. Watcher's own
  // scans are already self-healing on the Watcher's own schedule
  // (scheduler.ts's repairOrphanedCycleScans/FAIL_NEVER_CLAIMED), so Finder
  // must never lock on, or "recover", a source_scans row it did not create.
  // OLX is dispatched exclusively to olx_scan_jobs/local worker below.
  const lockableSourceIds = sources.filter((source) => source.id !== "olx").map((source) => source.id);
  // The scan/persist/reconciliation pipeline below writes through
  // reconcile_canonical_listing_decision (a service_role-only RPC, by
  // design — see the grant migration), plus source_scans/listings rows.
  // This whole function is trusted, already-authorized server code (the
  // API route above it is the actual authorization boundary), so it must
  // use the admin client, not the anon/publishable one: the anon key has
  // been explicitly revoked from that RPC and fails every call with
  // "permission denied", which previously surfaced as
  // CANONICAL_RECONCILIATION_FAILED and silently failed every listing a
  // live scan tried to persist.
  const supabase = options.supabase ?? createAdminClient();
  if (lockableSourceIds.length && !options.skipLock) {
    await failStaleScans(supabase, filterId, lockableSourceIds);
    const { data: running, error: runningError } = await supabase.from("source_scans").select("id").eq("search_filter_id", filterId).in("source", lockableSourceIds).in("status", ["pending", "running"]).limit(1).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
    if (runningError) throw statusError(500, "Nie udało się sprawdzić statusu skanu.");
    if (running?.length) throw statusError(429, "Skan tego filtra już trwa.");
  }

  const preparedScans = options.usePreparedRows && lockableSourceIds.length
    ? await loadPreparedSourceScans(supabase, runId, lockableSourceIds)
    : new Map<string, PreparedSourceScan>();

  scanLog("SCAN START", { scanId: runId, source: "all", checked: 0, new: 0, matched: 0, durationMs: 0 });
  try {
    const sequentialSources = sources.filter((item) => item.id !== "olx");
    // One source gets a useful portion; untouched reservations remain ready
    // immediately, rather than splitting 35s across every portal in a filter.
    const perSourceTimeoutMs = sourceTimeoutBudgetMs(1);
    const workerDeadline = scanStarted + WORKER_MAX_DURATION_MS - WORKER_OVERHEAD_RESERVE_MS;
    let budgetExhausted = false;
    for (const source of sequentialSources) {
      const prepared = preparedScans.get(source.id);
      if (options.usePreparedRows && !prepared) {
        sourceResults.push(failedResult(source.id, 0, "SCAN_RESERVATION_MISSING", "Nie znaleziono zarezerwowanego etapu skanu."));
        continue;
      }
      if (prepared && (prepared.status === "completed" || prepared.status === "failed")) continue;
      if (prepared && (prepared.status !== "pending" || (prepared.continuation_next_at && Date.parse(prepared.continuation_next_at) > Date.now()) || (prepared.continuation_lease_until && Date.parse(prepared.continuation_lease_until) > Date.now()))) {
        sourceResults.push(pendingResult(source.id, "Etap oczekuje na zwolnienie lease lub upłynięcie retry/backoff."));
        continue;
      }
      // Leave the reservation pending when this invocation no longer has
      // enough time for a complete source attempt. The next durable
      // continuation cycle claims the same row/run; no synthetic failure is
      // written and no source is started after the worker budget expires.
      if (budgetExhausted || Date.now() + perSourceTimeoutMs > workerDeadline) {
        budgetExhausted = true;
        if (prepared) await deferPreparedSource(supabase, prepared.id);
        sourceResults.push(pendingResult(source.id, "SOURCE_BUDGET_EXHAUSTED: oczekuje na kontynuację", "SOURCE_BUDGET_EXHAUSTED"));
        continue;
      }
      sourceResults.push(await scanSource(source, filterId, filter, supabase, runId, ownedScans, prepared, perSourceTimeoutMs));
    }
    if (sources.some((source) => source.id === "olx")) {
      try {
        const existing = await existingOlxScanResult(runId, supabase);
        if (existing) {
          sourceResults.push(existing);
        } else {
          await enqueueOlxJob(filter, runId, supabase);
          sourceResults.push((await existingOlxScanResult(runId, supabase)) ?? pendingResult("olx"));
        }
      } catch (error) {
        sourceResults.push(failedResult("olx", 0, "OLX_ENQUEUE_FAILED", error instanceof Error ? error.message : "Nie udało się dodać OLX do kolejki."));
      }
    }
    if (facebookEnabled) {
      sourceResults.push(await reconcileFacebookFromCanonicalListings(filterId, runId));
    }
    const completed = sourceResults.filter((result) => result.status === "completed");
    const pending = sourceResults.filter((result) => result.status === "pending");
    const failed = sourceResults.filter((result) => result.status === "failed").length;
    if (!completed.length && !pending.length) {
      if (!sourceResults.length) {
        const terminalFailures = [...preparedScans.values()].filter((scan) => scan.status === "failed").length;
        return { runId, status: terminalFailures ? "partial" : "completed", sourcesRun: sourceIds.length, sourcesCompleted: sourceIds.length - terminalFailures, sourcesFailed: terminalFailures, fetched: 0, normalized: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, actualErrors: terminalFailures, sourceResults: [], matchDiagnostics: emptyMatchDiagnosticSummary(), scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0, warnings: [] };
      }
      throw statusError(500, sourceResults.map((result) => result.errorMessage).filter(Boolean).join(" ") || "Wszystkie źródła skanu zakończyły się błędem.");
    }
    const sum = (key: keyof Pick<SourceScanResult, "fetched" | "normalized" | "matched" | "listingsCreated" | "newMatches" | "updated" | "priceDrops" | "rejected">) => sourceResults.reduce((total, result) => total + result[key], 0);
    const warnings = sourceResults.flatMap((result) => [
      ...(result.warnings ?? []).map((warning) => `${result.source}: ${warning}`),
      ...(result.errorMessage ? [`${result.source}: ${result.errorMessage}`] : []),
    ]);
    const matchDiagnostics = mergeMatchDiagnosticSummaries(sourceResults.map((result) => result.matchDiagnostics));
    console.info("MATCH DIAGNOSTICS SUMMARY", JSON.stringify(matchDiagnostics));
    const { error: updateError } = await supabase.from("search_filters").update({ last_scanned_at: new Date().toISOString() }).eq("id", filterId).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
    if (updateError) console.error("FLIP FINDER LAST SCANNED UPDATE ERROR:", { scanId: runId, filterId, error: updateError });
    return { runId, status: pending.length ? "running" : failed ? "partial" : "completed", sourcesRun: sourceIds.length, sourcesCompleted: completed.length, sourcesFailed: failed, fetched: sum("fetched"), normalized: sum("normalized"), listingsCreated: sum("listingsCreated"), newMatches: sum("newMatches"), updated: sum("updated"), priceDrops: sum("priceDrops"), rejected: sum("rejected"), actualErrors: failed, sourceResults, matchDiagnostics, scannedCount: sum("fetched"), matchedCount: sum("matched"), newCount: sum("newMatches"), updatedCount: sum("updated"), priceDropCount: sum("priceDrops"), warnings };
  } finally {
    await failOwnedRunningScans(supabase, ownedScans);
    scanLog("SCAN FINALIZE", { scanId: runId, source: "all", checked: total(sourceResults, "fetched"), new: total(sourceResults, "newMatches"), matched: total(sourceResults, "matched"), durationMs: Date.now() - scanStarted });
  }
}

export type FinderContinuationSummary = {
  status: "completed" | "partial" | "schema_unavailable";
  cycleAt: string;
  claimed: number;
  completed: number;
  deferred: number;
  failed: number;
  errors: string[];
};

export type FinderRunPortionResult = { runId: string; status: "running" | "completed" | "partial"; claimed: number; completed: number; failed: number };

/** Operator continuation: only existing rows of the explicitly requested run. */
export async function runFinderScanPortion(runId: string, options: {
  supabase?: SupabaseClient;
  loadFilter?: typeof getSearchFilter;
  timeoutMs?: number;
} = {}): Promise<FinderRunPortionResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) throw statusError(400, "INVALID_SCAN_RUN_ID");
  const supabase = options.supabase ?? createAdminClient();
  const deadline = Date.now() + WORKER_MAX_DURATION_MS - WORKER_OVERHEAD_RESERVE_MS;
  const readRows = async () => {
    const { data, error } = await supabase.from("source_scans").select("id,source,status,search_filter_id,started_at,filter_snapshot,continuation_next_at,continuation_lease_until,continuation_lease_token,continuation_attempt").eq("scan_run_id", runId).abortSignal(AbortSignal.timeout(5_000));
    if (error) throw statusError(502, "SCAN_PROGRESS_READ_FAILED");
    return (Array.isArray(data) ? data : []) as (PreparedSourceScan & { search_filter_id: string })[];
  };
  const rows = await readRows();
  if (!rows.length) throw statusError(404, "SCAN_RUN_NOT_FOUND");
  if (rows.some((row) => row.source === "facebook")) throw statusError(409, "NOT_FINDER_RUN");
  if (new Set(rows.map((row) => row.search_filter_id)).size !== 1 || new Set(rows.map((row) => row.source)).size !== rows.length) throw statusError(409, "SCAN_RUN_INCONSISTENT");
  const summarize = (current: typeof rows, claimed: number): FinderRunPortionResult => ({
    runId, claimed,
    status: current.some((row) => row.status === "pending" || row.status === "running") ? "running" : current.some((row) => row.status === "failed") ? "partial" : "completed",
    completed: current.filter((row) => row.status === "completed").length,
    failed: current.filter((row) => row.status === "failed").length,
  });
  if (!rows.some((row) => row.source !== "olx" && (row.status === "pending" || row.status === "running"))) return summarize(rows, 0);
  const filter = await (options.loadFilter ?? getSearchFilter)(rows[0].search_filter_id, { supabase, signal: AbortSignal.timeout(5_000) });
  if (!filter) throw statusError(404, "FILTER_NOT_FOUND");
  if (!filter.isActive) throw statusError(409, "FILTER_PAUSED");
  const sources = activeSources(filter);
  const owned = new Map<string, ScanClock>();
  let claimed = 0;
  try {
    for (const initial of rows) {
      const source = sources.find((item) => item.id === initial.source && item.id !== "olx");
      if (initial.source === "olx" || initial.status === "completed" || initial.status === "failed") continue;
      const now = Date.now();
      const timeoutMs = Math.min(options.timeoutMs ?? SOURCE_TIMEOUT_MS, deadline - now);
      if (timeoutMs < (options.timeoutMs ?? MIN_SOURCE_TIMEOUT_MS)) break;
      if (initial.continuation_next_at && Date.parse(initial.continuation_next_at) > now) continue;
      if (initial.continuation_lease_until && Date.parse(initial.continuation_lease_until) > now) continue;
      let prepared = initial;
      if (initial.status === "running") {
        // Recover a crashed owner only after its observed lease expired (or
        // the legacy five-minute orphan grace). Compare its token and lease,
        // so this cannot release a replacement owner's lock.
        if (!initial.continuation_lease_until && now - Date.parse(initial.started_at) < 5 * 60_000) continue;
        let recovery = supabase.from("source_scans").update({ status: "pending", continuation_lease_until: null, continuation_lease_token: null, continuation_next_at: new Date(now).toISOString(), error_message: "SOURCE_BUDGET_EXHAUSTED: expired worker; ready for continuation" }).eq("id", initial.id).eq("status", "running");
        recovery = initial.continuation_lease_token ? recovery.eq("continuation_lease_token", initial.continuation_lease_token) : recovery.is("continuation_lease_token", null);
        recovery = initial.continuation_lease_until ? recovery.eq("continuation_lease_until", initial.continuation_lease_until) : recovery.is("continuation_lease_until", null);
        const { data, error } = await recovery.select("*").abortSignal(AbortSignal.timeout(4_000));
        if (error) throw statusError(502, "SCAN_RECOVERY_FAILED");
        if (!Array.isArray(data) || !data.length) continue;
        prepared = data[0];
      }
      if (!source) {
        // An unavailable source cannot be fetched, but leaving its pending
        // row forever would keep the exact-run client continuation spinning.
        let inactive = supabase.from("source_scans").update({ status: "failed", finished_at: new Date(now).toISOString(), error_message: "SOURCE_NOT_ACTIVE: source no longer eligible", continuation_next_at: null, continuation_lease_until: null, continuation_lease_token: null }).eq("id", prepared.id).eq("status", "pending");
        inactive = prepared.continuation_lease_token ? inactive.eq("continuation_lease_token", prepared.continuation_lease_token) : inactive.is("continuation_lease_token", null);
        inactive = prepared.continuation_lease_until ? inactive.eq("continuation_lease_until", prepared.continuation_lease_until) : inactive.is("continuation_lease_until", null);
        inactive = prepared.continuation_next_at ? inactive.eq("continuation_next_at", prepared.continuation_next_at) : inactive.is("continuation_next_at", null);
        const result = await inactive.abortSignal(AbortSignal.timeout(4_000));
        if (result.error) throw statusError(502, "SCAN_FINALIZE_FAILED");
        continue;
      }
      const result = await scanSource(source, filter.id, filter, supabase, runId, owned, prepared, timeoutMs);
      if (!["SCAN_ALREADY_CLAIMED", "SCAN_CREATE_FAILED", "SOURCE_NOT_READY"].includes(result.errorCode ?? "")) claimed += 1;
    }
  } finally {
    await failOwnedRunningScans(supabase, owned);
  }
  return summarize(await readRows(), claimed);
}

/** Durable periodic continuation backed by the claim_finder_scan_source RPC. */
export async function runFinderScanContinuations(now = new Date()): Promise<FinderContinuationSummary> {
  const cycleAt = continuationCycleAt(now);
  const supabase = createAdminClient();
  const deadline = Date.now() + WORKER_MAX_DURATION_MS - WORKER_OVERHEAD_RESERVE_MS;
  let claimed = 0; let completed = 0; let deferred = 0; let failed = 0;
  const errors: string[] = [];
  // Never claim a new row unless the worker still has room for the complete
  // per-source timeout. The reserved overhead remains available for the claim,
  // filter load, finalization and cleanup around that bounded source run.
  const continuationTimeoutMs = sourceTimeoutBudgetMs(1);

  while (Date.now() + continuationTimeoutMs <= deadline) {
    const claim = supabase.rpc("claim_finder_scan_source", {
      p_cycle_at: cycleAt,
      p_now: new Date().toISOString(),
      p_lease_seconds: Math.floor(CONTINUATION_LEASE_MS / 1_000),
    }).abortSignal(AbortSignal.timeout(Math.min(DATABASE_TIMEOUT_MS, Math.max(1_000, deadline - Date.now()))));
    const { data, error } = await claim;
    if (error) {
      if (error.code === "42883" || error.code === "PGRST202") return { status: "schema_unavailable", cycleAt, claimed, completed, deferred, failed, errors: ["CONTINUATION_SCHEMA_NOT_READY"] };
      errors.push(`CONTINUATION_CLAIM_FAILED: ${error.message}`);
      return { status: "partial", cycleAt, claimed, completed, deferred, failed, errors };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") break;
    const claimedRow = row as Record<string, unknown>;
    const scanId = typeof claimedRow.id === "string" ? claimedRow.id : null;
    const filterId = typeof claimedRow.search_filter_id === "string" ? claimedRow.search_filter_id : null;
    const sourceId = typeof claimedRow.source === "string" ? claimedRow.source : null;
    const runId = typeof claimedRow.scan_run_id === "string" ? claimedRow.scan_run_id : null;
    const startedAt = typeof claimedRow.started_at === "string" ? claimedRow.started_at : null;
    const leaseToken = typeof claimedRow.continuation_lease_token === "string" ? claimedRow.continuation_lease_token : null;
    const continuationAttempt = typeof claimedRow.continuation_attempt === "number" ? claimedRow.continuation_attempt : null;
    if (!scanId || !filterId || !sourceId || !runId || !startedAt || !leaseToken) { errors.push("CONTINUATION_CLAIM_INVALID"); break; }
    claimed += 1;

    let filter: LoadedFilter | null;
    try {
      filter = await getSearchFilter(filterId, { supabase, signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      await failClaimedContinuation(supabase, scanId, leaseToken, `FILTER_LOAD_FAILED: ${error instanceof Error ? error.message : "Nie udało się odczytać filtra."}`);
      failed += 1;
      continue;
    }
    const source = filter ? activeSources(filter).find((candidate) => candidate.id === sourceId) : null;
    if (!filter || !source || sourceId === "olx" || sourceId === "facebook") {
      await failClaimedContinuation(supabase, scanId, leaseToken, "SOURCE_NOT_ACTIVE: continuation source is not Finder-owned");
      failed += 1;
      continue;
    }
    // A continuation owns one source at a time. It no longer shares the
    // initial request's slice across the whole filter, so one source gets the
    // full bounded retry window while the next source waits for another cycle.
    const prepared: PreparedSourceScan = { id: scanId, source: sourceId, status: "running", started_at: startedAt, continuation_lease_token: leaseToken, continuation_attempt: continuationAttempt, filter_snapshot: claimedRow.filter_snapshot };
    const remainingMs = Math.min(continuationTimeoutMs, deadline - Date.now());
    if (remainingMs < MIN_SOURCE_TIMEOUT_MS) {
      const { error } = await supabase.from("source_scans").update({ status: "pending", finished_at: null, error_message: "SOURCE_BUDGET_EXHAUSTED: ready for next portion", continuation_next_at: new Date().toISOString(), continuation_lease_until: null, continuation_lease_token: null }).eq("id", scanId).eq("status", "running").eq("continuation_lease_token", leaseToken).gt("continuation_lease_until", new Date().toISOString()).abortSignal(AbortSignal.timeout(4_000));
      if (error) errors.push(`SOURCE_RELEASE_FAILED: ${error.message}`);
      deferred += 1;
      break;
    }
    const result = await scanSource(source, filterId, filter, supabase, runId, new Map(), prepared, remainingMs, { preparedAlreadyRunning: true });
    if (result.status === "completed") completed += 1;
    else if (result.status === "pending") deferred += 1;
    else failed += 1;
  }
  return { status: errors.length || deferred > 0 ? "partial" : "completed", cycleAt, claimed, completed, deferred, failed, errors };
}

async function failClaimedContinuation(supabase: SupabaseClient, scanId: string, leaseToken: string, errorMessage: string): Promise<void> {
  await supabase.from("source_scans").update({ status: "failed", finished_at: new Date().toISOString(), error_message: errorMessage, continuation_next_at: null, continuation_lease_until: null, continuation_lease_token: null }).eq("id", scanId).eq("status", "running").eq("continuation_lease_token", leaseToken).gt("continuation_lease_until", new Date().toISOString());
}

class ContinuationLeaseLostError extends Error {
  constructor() {
    super("CONTINUATION_LEASE_LOST");
    this.name = "ContinuationLeaseLostError";
  }
}

/**
 * A continuation token is an ownership lease, not just an audit value.  The
 * claim RPC can hand the row to a newer worker after the old lease expires;
 * every old worker must therefore verify both the token and its expiry before
 * it fetches or persists any source data.  This read is deliberately scoped
 * to the one row and uses the same service-role client as the guarded writes.
 */
async function assertContinuationLease(supabase: SupabaseClient, scanId: string, leaseToken: string | null | undefined, signal: AbortSignal): Promise<void> {
  if (!leaseToken) return;
  const { data, error } = await supabase
    .from("source_scans")
    .select("id")
    .eq("id", scanId)
    .eq("status", "running")
    .eq("continuation_lease_token", leaseToken)
    .gt("continuation_lease_until", new Date().toISOString())
    .abortSignal(signal)
    .maybeSingle();
  if (error) throw new Error(`Nie udało się zweryfikować dzierżawy kontynuacji: ${error.message}`);
  if (!data) throw new ContinuationLeaseLostError();
}

export async function scanSource(source: SearchSource, filterId: string, filter: LoadedFilter, supabase: SupabaseClient, runId: string, ownedScans: Map<string, ScanClock>, prepared?: PreparedSourceScan, timeoutMs: number = SOURCE_TIMEOUT_MS, options: { preparedAlreadyRunning?: boolean } = {}): Promise<SourceScanResult> {
  const started = Date.now();
  if (prepared && !options.preparedAlreadyRunning && (prepared.status !== "pending" || (prepared.continuation_next_at && Date.parse(prepared.continuation_next_at) > started) || (prepared.continuation_lease_until && Date.parse(prepared.continuation_lease_until) > started))) {
    return pendingResult(source.id, "SOURCE_NOT_READY: live owner or retry/backoff", "SOURCE_NOT_READY");
  }
  // Claims the prepared row with an atomic pending->running CAS, not a bare
  // update-by-id. The background callback that calls runManualOtodomScan
  // (see route.ts's runAfterResponse) has no guarantee against ever running
  // more than once for the same runId -- a platform-level retry or a second
  // after() firing would otherwise re-run source.fetch() and race its writes
  // against the first execution. The WHERE id=... AND status='pending' makes
  // Postgres itself the referee: at most one concurrent UPDATE can match a
  // given row, so at most one caller ever proceeds past this point for it.
  // The winner also gets a short continuation lease. Without that lease, an
  // old pending reservation could be switched to running by a manual worker
  // and then stolen by continuation's five-minute orphan rule before the
  // worker had finalized it.
  const manualLeaseToken = crypto.randomUUID();
  const manualLeaseUntil = new Date(started + CONTINUATION_LEASE_MS).toISOString();
  let claimQuery = prepared && !options.preparedAlreadyRunning ? supabase.from("source_scans").update({ status: "running", continuation_lease_token: manualLeaseToken, continuation_lease_until: manualLeaseUntil }).eq("id", prepared.id).eq("status", "pending") : null;
  if (claimQuery && prepared) {
    // The returned snapshot, not the caller's earlier read, is authoritative.
    // Comparing retry/lease state also prevents claiming a newly deferred row
    // based on an obsolete ready-state read.
    claimQuery = prepared.continuation_next_at ? claimQuery.eq("continuation_next_at", prepared.continuation_next_at) : claimQuery.is("continuation_next_at", null);
    claimQuery = prepared.continuation_lease_until ? claimQuery.eq("continuation_lease_until", prepared.continuation_lease_until) : claimQuery.is("continuation_lease_until", null);
  }
  const { data: claimed, error } = prepared && options.preparedAlreadyRunning
    ? { data: [{ id: prepared.id, started_at: prepared.started_at, continuation_lease_token: prepared.continuation_lease_token ?? null, filter_snapshot: prepared.filter_snapshot }], error: null }
    : claimQuery
    ? await claimQuery.select("id,started_at,continuation_lease_token,filter_snapshot").abortSignal(AbortSignal.timeout(Math.min(DATABASE_TIMEOUT_MS, 5_000)))
    : await supabase.from("source_scans").insert({ search_filter_id: filterId, source: source.id, status: "running", scan_run_id: runId, filter_snapshot: filter, continuation_lease_token: manualLeaseToken, continuation_lease_until: manualLeaseUntil }).select("id,started_at,continuation_lease_token,filter_snapshot").abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS)).single();
  // Never assume the API returns a row just because there was no transport
  // error: a lost CAS (someone else already claimed this row) is zero rows,
  // not an error, from a plain .update().select() call -- unlike .single(),
  // which the unprepared insert path above still uses since an insert always
  // produces exactly one row. A genuine transport/DB error (checked first,
  // separately) is never relabeled as a lost claim: a real outage or a
  // permissions problem must surface as SCAN_CREATE_FAILED, the same code
  // this path already used before the CAS existed, not be masked as "someone
  // else won the race" -- that would misdirect anyone debugging a real error.
  if (error) return failedResult(source.id, Date.now() - started, "SCAN_CREATE_FAILED", "Nie udało się rozpocząć skanu źródła.");
  const scan = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!scan || typeof scan.id !== "string" || typeof scan.started_at !== "string") {
    return prepared
      ? failedResult(source.id, Date.now() - started, "SCAN_ALREADY_CLAIMED", "Ten etap skanu już przejęło inne wykonanie tego samego przebiegu.")
      : failedResult(source.id, Date.now() - started, "SCAN_CREATE_FAILED", "Nie udało się rozpocząć skanu źródła.");
  }
  const scanClock = { startedAt: scan.started_at, startedMs: started, continuationLeaseToken: typeof (scan as { continuation_lease_token?: unknown }).continuation_lease_token === "string" ? (scan as { continuation_lease_token: string }).continuation_lease_token : null };
  ownedScans.set(scan.id, scanClock);
  scanLog("SOURCE START", { scanId: runId, source: source.id, checked: 0, new: 0, matched: 0, durationMs: 0 });

  let checkpoint = emptySourceCheckpoint();
  let counters: ScanItemCounts = { listingsCreatedCount: 0, newMatchesCount: 0 };
  let updated = 0; let priceDrops = 0; let fetched = 0; let normalized = 0; let matched = 0; let warnings: string[] = [];
  let status: SourceScanResult["status"] = "completed"; let errorCode: string | null = null; let errorMessage: string | null = null; let continuationNextAtOverride: string | null = null;
  const otodomSummary = createOtodomFilterSummary();
  const matchDiagnostics = emptyMatchDiagnosticSummary();
  const controller = new AbortController();
  // Include the claim's DB time in the stage budget, not just its fetch.
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1, started + timeoutMs - Date.now()));
  try {
    await assertContinuationLease(supabase, scan.id, scanClock.continuationLeaseToken, controller.signal);
    checkpoint = readSourceCheckpoint(scan.filter_snapshot ?? prepared?.filter_snapshot);
    if (!checkpoint.timeoutAttempts && !(scan.filter_snapshot && typeof scan.filter_snapshot === "object" && "_finderCheckpoint" in scan.filter_snapshot)) checkpoint.timeoutAttempts = Math.max(0, (prepared?.continuation_attempt ?? 0) - (options.preparedAlreadyRunning ? 1 : 0));
    ({ fetched, normalized, matched, counters, updated, priceDrops, warnings } = checkpoint);
    const saveCheckpoint = async () => {
      Object.assign(checkpoint, { fetched, normalized, matched, counters, updated, priceDrops, warnings });
      assertCheckpointSize(checkpoint);
      await updateSourceProgress(supabase, scan.id, filter, { fetched, matched, counters, updated, priceDrops }, controller.signal, scanClock.continuationLeaseToken, checkpoint);
    };
    const requireTime = () => {
      controller.signal.throwIfAborted();
      // Leave time for a final guarded checkpoint and lease release. Yielding
      // after committed work is not a network timeout and needs no backoff.
      if (Date.now() >= started + timeoutMs - Math.min(5_000, Math.floor(timeoutMs / 6))) throw new SourceSliceYield();
    };
    const drainBuffer = async () => {
      if (checkpoint.offset < checkpoint.buffer.length) {
        await assertContinuationLease(supabase, scan.id, scanClock.continuationLeaseToken, controller.signal);
        const alreadyProcessed = checkpoint.buffer.slice(0, checkpoint.offset);
        const notYetProcessed = await reuseExistingListingAttributes(supabase, checkpoint.buffer.slice(checkpoint.offset));
        checkpoint.buffer = [...alreadyProcessed, ...notYetProcessed];
      }
      while (checkpoint.offset < checkpoint.buffer.length) {
        requireTime();
        const listing = checkpoint.buffer[checkpoint.offset];
        const decision = evaluateListingAgainstFilter(listing, filter);
        if (source.id === "otodom") addOtodomFilterDecision(otodomSummary, listing, decision);
        await assertContinuationLease(supabase, scan.id, scanClock.continuationLeaseToken, controller.signal);
        const saved = await persistListing(supabase, filterId, listing, decision.matches, decision.unknownFields, scan.id, scanTimestamp(scanClock), controller.signal, { bucket: decision.bucket, reasons: decision.reasons, unknownFields: decision.unknownFields });
        const diagnostic = createMatchDiagnostic(saved.listingId, listing, filter, decision);
        addMatchDiagnostic(matchDiagnostics, diagnostic);
        console.info("MATCH DIAGNOSTIC", JSON.stringify(diagnostic));
        if (decision.matches) matched += 1;
        counters = addScanItemCounts(counters, { listingCreated: saved.listingCreated, matchCreated: saved.matchCreated });
        updated += saved.updated; priceDrops += saved.priceDrop;
        checkpoint.offset += 1;
        await saveCheckpoint();
      }
      checkpoint.buffer = []; checkpoint.offset = 0;
      await saveCheckpoint();
    };
    // A page fetched by the previous owner survives in JSONB. Finish its
    // uncommitted listings first, then advance to the next page/site.
    await drainBuffer();
    if (!checkpoint.complete) {
      requireTime();
      await assertContinuationLease(supabase, scan.id, scanClock.continuationLeaseToken, controller.signal);
      let emitted = false;
      const onBatch = async (batch: SourceBatch, nextCursor: number | null) => {
        await assertContinuationLease(supabase, scan.id, scanClock.continuationLeaseToken, controller.signal);
        emitted = true;
        fetched += batch.fetched; normalized += batch.listings.length;
        warnings = [...new Set([...warnings, ...batch.warnings])].slice(0, 100);
        checkpoint.buffer = batch.listings; checkpoint.offset = 0;
        checkpoint.cursor = nextCursor; checkpoint.complete = nextCursor === null;
        await saveCheckpoint();
        await drainBuffer();
        if (!checkpoint.complete) requireTime();
      };
      const result = await source.fetch(filter, controller.signal, { cursor: checkpoint.cursor ?? 0, onBatch });
      // Existing single-response adapters keep their contract. Cache their
      // parsed payload too, so a persistence timeout never refetches it.
      if (!emitted) await onBatch(result, null);
    }
    if (source.id === "otodom") console.info("OTODOM FILTER SUMMARY:", otodomSummary);
  } catch (reason) {
    if (reason instanceof ContinuationLeaseLostError) {
      // A newer owner has the row now.  Do not mark its work failed or retry
      // the old result; the guarded finalization below becomes a no-op.
      status = "pending";
      errorCode = "CONTINUATION_LEASE_LOST";
      errorMessage = `${source.label}: continuation lease lost; stale result discarded`;
    } else if (reason instanceof SourceSliceYield) {
      status = "pending"; errorCode = "SOURCE_SLICE_YIELD";
      errorMessage = reason.message; continuationNextAtOverride = new Date(Date.now()).toISOString();
    } else {
      // "attempt" is how many times THIS source has now timed out, including
      // this one. preparedAlreadyRunning means the row came from the
      // continuation claim RPC, which already incremented continuation_attempt
      // before returning it -- that value already represents this attempt.
      // Otherwise (a fresh reservation or a manual resume) it represents only
      // PRIOR attempts, so this one adds 1.
      const attemptNumber = checkpoint.timeoutAttempts + 1;
      if (controller.signal.aborted) checkpoint.timeoutAttempts = attemptNumber;
      const disposition = classifySourceFailure({ timedOut: controller.signal.aborted, error: reason, attempt: attemptNumber });
      status = disposition.status;
      errorCode = disposition.errorCode;
      continuationNextAtOverride = disposition.nextAttemptAt;
      errorMessage = disposition.errorCode === "SOURCE_FORBIDDEN"
        ? `${source.label}: access denied (HTTP 403); no retry`
        : controller.signal.aborted
        ? disposition.errorCode === "SOURCE_CONTINUATION_EXHAUSTED"
          ? `${source.label}: gave up after ${attemptNumber} timed-out attempts`
          : `SOURCE_TIMEOUT: ${source.label}: source timeout after ${timeoutMs / 1000}s`
        : reason instanceof Error ? reason.message : "Błąd źródła.";
    }
  } finally {
    clearTimeout(timeoutId);
    Object.assign(checkpoint, { fetched, normalized, matched, counters, updated, priceDrops, warnings });
    let checkpointFits = true;
    try { assertCheckpointSize(checkpoint); } catch { checkpointFits = false; }
    await finalizeSourceScan(supabase, scan.id, scanClock, status, { fetched, matched, counters, updated, priceDrops, warnings, errorMessage, continuationNextAt: continuationNextAtOverride, filterSnapshot: { ...filter, ...(checkpointFits ? { _finderCheckpoint: checkpoint } : {}), _scanProgress: { lastProgressAt: new Date().toISOString(), checked: fetched, matched, new: counters.newMatchesCount } } });
    // Successful guarded finalization already released our token. Do not
    // spend another DB round trip on every completed source in cleanup.
    ownedScans.delete(scan.id);
  }
  const result = { source: source.id, status, fetched, normalized, matched, listingsCreated: counters.listingsCreatedCount, newMatches: counters.newMatchesCount, updated, priceDrops, rejected: Math.max(0, fetched - normalized), durationMs: Date.now() - started, errorCode, errorMessage, warnings, matchDiagnostics };
  scanLog(status === "completed" ? "SOURCE DONE" : "SOURCE ERROR", { scanId: runId, source: source.id, checked: fetched, new: counters.newMatchesCount, matched, durationMs: result.durationMs });
  return result;
}

/**
 * Releases the duplicate-scan lock held by scans that never reached a terminal
 * state. It must cover every status the lock blocks on: a Facebook row stays
 * "pending" until a collector claims it, so reaping only "running" left an
 * unclaimed job blocking that filter's scans permanently.
 *
 * A "pending" row that was reserved up front (reserveSourceScans' own bulk
 * insert creates one row per lockable source at run start) but never actually
 * reached by a worker carries no error_message and no heartbeat at all -- it
 * is indistinguishable in shape from a row whose worker genuinely
 * crashed/abandoned it. But it is NOT abandoned: it is still exactly where
 * the periodic continuation (or a manual resume) is supposed to find it,
 * exactly like a row that already got one attempt and a SOURCE_TIMEOUT:
 * defer. The only thing distinguishing "merely queued" from "worker died
 * immediately after reserving" is time, so it gets the same
 * CONTINUATION_MAX_WAIT_MS grace period a deferred row already gets via
 * isContinuationPending/isContinuationExpired above, not the much shorter
 * STALE_SCAN_TIMEOUT_MS meant to catch a crash mid-fetch. Without this, every
 * source queued behind the first SOURCE_TIMEOUT defer in a run stuck on a
 * dead/delayed continuation (e.g. the GitHub Actions schedule outage this
 * session's cron-job.org fallback addresses) gets silently, permanently
 * marked "failed" -- and the resume fix in reserveOrResumeSourceScans then
 * skips every "failed" prepared row -- defeating the entire point of
 * resuming instead of refusing.
 */
async function failStaleScans(supabase: SupabaseClient, filterId: string, sourceIds: string[]): Promise<void> {
  const now = Date.now();
  const { data: candidates, error: readError } = await supabase.from("source_scans").select("id,status,started_at,filter_snapshot,error_message,continuation_next_at,continuation_lease_until,continuation_lease_token").eq("search_filter_id", filterId).in("source", sourceIds).in("status", RECOVERABLE_SCAN_STATUSES).lt("started_at", staleScanCutoff(now)).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
  if (readError) throw statusError(500, "Nie udało się sprawdzić wygasłej blokady skanu.");
  const staleRows = (Array.isArray(candidates) ? candidates : []).filter((candidate): candidate is { id: string; status: string; started_at: string | null; filter_snapshot: unknown; error_message: string | null; continuation_next_at: string | null; continuation_lease_until: string | null; continuation_lease_token: string | null } => Boolean(candidate && typeof candidate === "object" && typeof (candidate as { id?: unknown }).id === "string"))
    .filter((candidate) => !isContinuationPending(candidate.error_message) || isContinuationExpired(candidate.error_message, candidate.continuation_next_at, Date.now()))
    // A live continuation/manual lease is stronger than the age heuristic.
    // Never reap a row another worker still owns, even when its original
    // reservation timestamp is old and no progress heartbeat has arrived yet.
    .filter((candidate) => !(typeof candidate.continuation_lease_until === "string" && Number.isFinite(Date.parse(candidate.continuation_lease_until)) && Date.parse(candidate.continuation_lease_until) > now))
    .filter((candidate) => {
      const heartbeatAt = scanHeartbeatAt(candidate.filter_snapshot);
      const neverAttempted = candidate.status === "pending" && !candidate.error_message && !heartbeatAt;
      return isStaleScan({ status: candidate.status, startedAt: candidate.started_at, heartbeatAt }, now, neverAttempted ? CONTINUATION_MAX_WAIT_MS : STALE_SCAN_TIMEOUT_MS);
    });
  for (const candidate of staleRows) {
    let cleanup = supabase.from("source_scans").update({ status: "failed", finished_at: new Date().toISOString(), error_message: STALE_SCAN_MESSAGE }).eq("id", candidate.id).eq("status", candidate.status);
    cleanup = candidate.continuation_lease_token ? cleanup.eq("continuation_lease_token", candidate.continuation_lease_token) : cleanup.is("continuation_lease_token", null);
    cleanup = candidate.continuation_lease_until ? cleanup.eq("continuation_lease_until", candidate.continuation_lease_until) : cleanup.is("continuation_lease_until", null);
    cleanup = candidate.continuation_next_at ? cleanup.eq("continuation_next_at", candidate.continuation_next_at) : cleanup.is("continuation_next_at", null);
    const { error } = await cleanup.abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
    if (error) throw statusError(500, "Nie udało się zwolnić wygasłej blokady skanu.");
  }
}

async function loadPreparedSourceScans(supabase: SupabaseClient, runId: string, sourceIds: string[]): Promise<Map<string, PreparedSourceScan>> {
  const { data, error } = await supabase.from("source_scans").select("id,source,status,started_at,continuation_lease_token,continuation_attempt,continuation_next_at,continuation_lease_until,filter_snapshot").eq("scan_run_id", runId).in("source", sourceIds).in("status", ["pending", "running", "completed", "failed"]).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
  if (error) throw statusError(500, "Nie udało się odczytać zarezerwowanego skanu.");
  return new Map((Array.isArray(data) ? data : []).flatMap((row) => {
    if (!row || typeof row !== "object" || typeof (row as { id?: unknown }).id !== "string" || typeof (row as { source?: unknown }).source !== "string" || typeof (row as { status?: unknown }).status !== "string" || typeof (row as { started_at?: unknown }).started_at !== "string") return [];
    return [[(row as { source: string }).source, row as PreparedSourceScan]] as const;
  }));
}

async function deferPreparedSource(supabase: SupabaseClient, scanId: string): Promise<void> {
  const { error } = await supabase
    .from("source_scans")
    .update({
      status: "pending",
      finished_at: null,
      error_message: "SOURCE_BUDGET_EXHAUSTED: ready for next portion",
      continuation_next_at: new Date(Date.now()).toISOString(),
    })
    .eq("id", scanId)
    .eq("status", "pending")
    .is("error_message", null)
    .is("continuation_lease_until", null)
    .abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
  if (error) console.error("FLIP FINDER SOURCE DEFER ERROR:", { scanId, error });
}

async function updateSourceProgress(supabase: SupabaseClient, scanId: string, filter: LoadedFilter, progress: Progress, signal: AbortSignal, continuationLeaseToken?: string | null, checkpoint?: SourceCheckpoint): Promise<void> {
  const heartbeat = { lastProgressAt: new Date().toISOString(), checked: progress.fetched, matched: progress.matched, new: progress.counters.newMatchesCount };
  let query = supabase.from("source_scans").update({ scanned_count: progress.fetched, listings_found: progress.fetched, matched_count: progress.matched, listings_created: progress.counters.listingsCreatedCount, new_count: progress.counters.newMatchesCount, listings_updated: progress.updated, price_drop_count: progress.priceDrops, filter_snapshot: { ...filter, ...(checkpoint ? { _finderCheckpoint: checkpoint } : {}), _scanProgress: heartbeat } }).eq("id", scanId).eq("status", "running");
  if (continuationLeaseToken) query = query.eq("continuation_lease_token", continuationLeaseToken).gt("continuation_lease_until", new Date().toISOString());
  const { data, error } = await query.select("id").abortSignal(signal);
  if (error) throw new Error(`Nie udało się zapisać postępu skanu: ${error.message}`);
  if (!Array.isArray(data) || !data.length) throw new ContinuationLeaseLostError();
}

async function finalizeSourceScan(supabase: SupabaseClient, scanId: string, scanClock: ScanClock, status: SourceScanResult["status"], input: Progress & { warnings: string[]; errorMessage: string | null; continuationNextAt?: string | null; filterSnapshot?: unknown }): Promise<void> {
  // continuationNextAt lets a timed-out fetch apply its own backoff
  // (classifySourceFailure's nextAttemptAt) instead of always retrying at the
  // very next cycle boundary; every other "pending" path (budget-exhausted
  // defer, lease-lost discard) keeps the plain immediate-next-cycle behavior.
  const continuationNextAt = status === "pending" ? (input.continuationNextAt ?? nextContinuationAt(Date.now())) : null;
  const payload = { status, finished_at: status === "pending" ? null : scanTimestamp(scanClock), error_message: input.errorMessage, scanned_count: input.fetched, listings_found: input.fetched, matched_count: input.matched, listings_created: input.counters.listingsCreatedCount, new_count: input.counters.newMatchesCount, listings_updated: input.updated, price_drop_count: input.priceDrops, warnings: input.warnings, continuation_next_at: continuationNextAt, continuation_lease_until: null, continuation_lease_token: null, ...(input.filterSnapshot ? { filter_snapshot: input.filterSnapshot } : {}) };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let query = supabase.from("source_scans").update(payload).eq("id", scanId).eq("status", "running");
    if (scanClock.continuationLeaseToken) query = query.eq("continuation_lease_token", scanClock.continuationLeaseToken).gt("continuation_lease_until", new Date().toISOString());
    const { error } = await query.abortSignal(AbortSignal.timeout(4_000));
    if (!error) return;
    console.error("FLIP FINDER SOURCE FINALIZE ERROR:", { scanId, status, attempt, error });
  }
  throw new Error(`Nie udało się sfinalizować skanu źródła ${scanId}.`);
}

async function failOwnedRunningScans(supabase: SupabaseClient, scans: Map<string, ScanClock>): Promise<void> {
  for (const [scanId, scanClock] of scans) {
    const payload = { status: "pending", finished_at: null, error_message: "SOURCE_TIMEOUT: scan interrupted before finalization; waiting for continuation", continuation_next_at: nextContinuationAt(Date.now()), continuation_lease_until: null, continuation_lease_token: null };
    let query = supabase.from("source_scans").update(payload).eq("id", scanId).eq("status", "running");
    if (scanClock.continuationLeaseToken) query = query.eq("continuation_lease_token", scanClock.continuationLeaseToken).gt("continuation_lease_until", new Date().toISOString());
    const { error } = await query.abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
    if (error) console.error("FLIP FINDER GLOBAL FINALIZE ERROR:", { scanId, error });
  }
}

/**
 * finished_at (and every intermediate progress timestamp persisted during a
 * source's own fetch/persist loop) is deliberately NOT Date.now() at write
 * time. It is `startedAt` (source_scans.started_at -- the shared RESERVATION
 * timestamp every prepared row gets, stamped once by startManualOtodomScan,
 * identical across all sources in a run) plus however much real time THIS
 * scanSource call has itself been running. That means finished_at encodes
 * "how long did this one source actually take", never "how much wall-clock
 * time had elapsed since the scan as a whole began" -- the latter would be
 * inflated by queueing behind however many earlier sequential sources ran
 * first, which would misrepresent a source's own duration.
 *
 * Side effect worth documenting because it was already mistaken for evidence
 * of concurrent/duplicate execution once: under the strictly sequential for
 * loop in runManualOtodomScan, several sources that each hit the exact same
 * timeoutMs ceiling will ALL compute a finished_at within a few ms of
 * `startedAt + timeoutMs` of each other, regardless of how far apart their
 * real wall-clock finish times were. A cluster of near-identical finished_at
 * values is therefore NOT by itself proof of overlap -- see
 * manual-scan-lock-separation.test.ts's "two concurrent executions of the
 * same background callback" test for what would actually prove it
 * (source.fetch() call counts), and the CAS claim in scanSource below for
 * why overlap is now harmless either way.
 */
export function scanTimestamp({ startedAt, startedMs }: ScanClock): string {
  return new Date(Date.parse(startedAt) + Math.max(1, Date.now() - startedMs)).toISOString();
}

/**
 * Facebook contract: Flip Finder never acquires Facebook posts itself — the
 * Facebook Watcher/Collector pipeline collects them independently, on its own
 * schedule. Scanning a filter that includes source="facebook" must therefore
 * create zero facebook_scan_jobs rows and send zero commands to the browser
 * extension; it only re-evaluates the canonical listings Watcher already
 * stored against this filter's current criteria, entirely in the database.
 */
async function reconcileFacebookFromCanonicalListings(filterId: string, runId: string): Promise<SourceScanResult> {
  const started = Date.now();
  try {
    const result = await recalculateFilterMatches(filterId, { allowWithoutScan: true, scanRunId: runId, sourcesOverride: ["facebook"] });
    if (!result) return failedResult("facebook", Date.now() - started, "FACEBOOK_RECONCILIATION_FILTER_NOT_FOUND", "Nie znaleziono filtra do przeliczenia ofert z Facebooka.");
    return {
      source: "facebook",
      status: "completed",
      fetched: result.evaluated,
      normalized: result.evaluated,
      matched: result.matchesAfter,
      listingsCreated: 0,
      newMatches: result.addedMatches,
      updated: 0,
      priceDrops: 0,
      rejected: result.rejectedByPricePerSqm + result.rejectedByOtherCriteria,
      durationMs: Date.now() - started,
      errorCode: null,
      errorMessage: null,
      matchDiagnostics: emptyMatchDiagnosticSummary(),
    };
  } catch (error) {
    return failedResult("facebook", Date.now() - started, "FACEBOOK_RECONCILIATION_FAILED", error instanceof Error ? error.message : "Nie udało się przeliczyć ofert z Facebooka.");
  }
}

function failedResult(source: string, durationMs: number, errorCode: string, errorMessage: string): SourceScanResult { return { source, status: "failed", fetched: 0, normalized: 0, matched: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, durationMs, errorCode, errorMessage, warnings: [], matchDiagnostics: emptyMatchDiagnosticSummary() }; }
function pendingResult(source: string, errorMessage = `${source === "olx" ? "OLX" : "Facebook"}: oczekuje na lokalny worker`, errorCode: string | null = null): SourceScanResult { return { source, status: "pending", fetched: 0, normalized: 0, matched: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, durationMs: 0, errorCode, errorMessage, warnings: [], matchDiagnostics: emptyMatchDiagnosticSummary() }; }
function total(results: SourceScanResult[], key: "fetched" | "newMatches" | "matched"): number { return results.reduce((sum, result) => sum + result[key], 0); }
function scanLog(event: "SCAN START" | "SOURCE START" | "SOURCE DONE" | "SOURCE ERROR" | "SCAN FINALIZE", data: { scanId: string; source: string; checked: number; new: number; matched: number; durationMs: number }): void { if (process.env.NODE_ENV === "development") console.info(event, data); }

type OtodomFilterSummary = { evaluated: number; matched: number; rejectedByPricePerSqm: number; rejectedByPrice: number; rejectedByArea: number; rejectedByFloor: number; rejectedByBuildingType: number; rejectedByDistrict: number; rejectedByOtherCriteria: number; acceptedWithUnknownMetadata: number; examples: Array<{ title: string | null; price: number | null; area: number | null; calculatedPricePerSqm: number | null; rejectionReasons: string[] }> };
function createOtodomFilterSummary(): OtodomFilterSummary { return { evaluated: 0, matched: 0, rejectedByPricePerSqm: 0, rejectedByPrice: 0, rejectedByArea: 0, rejectedByFloor: 0, rejectedByBuildingType: 0, rejectedByDistrict: 0, rejectedByOtherCriteria: 0, acceptedWithUnknownMetadata: 0, examples: [] }; }
function addOtodomFilterDecision(summary: OtodomFilterSummary, listing: SourceListing, decision: ReturnType<typeof evaluateListingAgainstFilter>): void { summary.evaluated += 1; if (decision.matches) { summary.matched += 1; if (decision.unknownFields.length) summary.acceptedWithUnknownMetadata += 1; return; } const reasons = decision.reasons; if (reasons.includes("max_price_per_sqm")) summary.rejectedByPricePerSqm += 1; else if (reasons.some((reason) => reason.startsWith("price_"))) summary.rejectedByPrice += 1; else if (reasons.some((reason) => reason.startsWith("area_"))) summary.rejectedByArea += 1; else if (reasons.some((reason) => reason.startsWith("floor_") || reason === "ground_floor")) summary.rejectedByFloor += 1; else if (reasons.includes("building_type")) summary.rejectedByBuildingType += 1; else if (reasons.includes("district")) summary.rejectedByDistrict += 1; else summary.rejectedByOtherCriteria += 1; if (summary.examples.length < 5) summary.examples.push({ title: listing.title, price: listing.price, area: listing.area, calculatedPricePerSqm: listing.price !== null && listing.area !== null && listing.area > 0 ? listing.price / listing.area : null, rejectionReasons: reasons }); }

type StatusError = Error & { status: number };
function statusError(status: number, message: string): StatusError { return Object.assign(new Error(message), { status }); }
