import "server-only";

import { evaluateListingAgainstFilter } from "@/features/flip-finder/filter-evaluation";
import { addMatchDiagnostic, createMatchDiagnostic, emptyMatchDiagnosticSummary, mergeMatchDiagnosticSummaries, type MatchDiagnosticSummary } from "@/features/flip-finder/match-diagnostics";
import { addScanItemCounts, type ScanItemCounts } from "@/features/flip-finder/scan-counters";
import { activeSources, type SourceFetchResult, type SourceListing, type SearchSource } from "@/features/flip-finder/server/search-source-registry";
import { enqueueOlxJob } from "@/features/flip-finder/server/olx-jobs";
import { persistListing } from "@/features/flip-finder/server/persist-listing";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import { recalculateFilterMatches } from "@/features/flip-finder/server/filter-match-recalculation";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient as DatabaseClient } from "@supabase/supabase-js";
import { isStaleScan, RECOVERABLE_SCAN_STATUSES, scanHeartbeatAt, STALE_SCAN_MESSAGE, staleScanCutoff } from "./scan-lifecycle";
import { CONTINUATION_LEASE_MS, classifySourceFailure, continuationCycleAt, isContinuationPending, nextContinuationAt } from "./scan-continuation";
export { scanStatus } from "./scan-start-errors";

export type SourceScanResult = { source: string; status: "pending" | "completed" | "failed"; fetched: number; normalized: number; matched: number; listingsCreated: number; newMatches: number; updated: number; priceDrops: number; rejected: number; durationMs: number; errorCode: string | null; errorMessage: string | null; warnings?: string[]; matchDiagnostics: MatchDiagnosticSummary };
export type ScanSummary = { runId: string; status: "running" | "completed" | "partial"; sourcesRun: number; sourcesCompleted: number; sourcesFailed: number; fetched: number; normalized: number; listingsCreated: number; newMatches: number; updated: number; priceDrops: number; rejected: number; actualErrors: number; sourceResults: SourceScanResult[]; matchDiagnostics: MatchDiagnosticSummary; scannedCount: number; matchedCount: number; newCount: number; updatedCount: number; priceDropCount: number; warnings: string[] };
type SupabaseClient = DatabaseClient;
type LoadedFilter = Awaited<ReturnType<typeof getSearchFilter>> & {};
type Progress = { fetched: number; matched: number; counters: ScanItemCounts; updated: number; priceDrops: number };
export type ScanClock = { startedAt: string; startedMs: number; continuationLeaseToken?: string | null };
export type PreparedSourceScan = { id: string; source: string; started_at: string; continuation_lease_token?: string | null };
type ManualScanOptions = { runId?: string; usePreparedRows?: boolean; skipLock?: boolean };

const SOURCE_TIMEOUT_MS = 75_000;
const DATABASE_TIMEOUT_MS = 12_000;
// Mirrors the scan route's `export const maxDuration = 300` (app/api/flip-finder/
// search-filters/[id]/scan/route.ts) -- keep these two numbers in sync.
const WORKER_MAX_DURATION_MS = 300_000;
// Reserves time for everything in runManualOtodomScan besides the sequential
// per-source fetch loop itself: getSearchFilter, the lock/staleness check,
// enqueueOlxJob, reconcileFacebookFromCanonicalListings, the final
// search_filters update, and the finally block's cleanup writes.
const WORKER_OVERHEAD_RESERVE_MS = 45_000;
// A scrape fetch cannot do meaningful work below this; if the number of
// sequential sources ever grows enough to hit this floor, the per-source
// budget below can no longer guarantee the worker stays inside
// WORKER_MAX_DURATION_MS on its own -- that would need real parallel source
// execution, not a smaller slice of a fixed budget.
const MIN_SOURCE_TIMEOUT_MS = 10_000;

/**
 * Bounds the per-source fetch timeout so that SOURCE_TIMEOUT_MS * sourceCount
 * can never collectively exceed the worker's own platform-enforced lifetime.
 * Every currently active source still runs -- nothing is disabled or skipped
 * -- it is only given a smaller abort window when many sources share one
 * worker invocation.
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
  if (!filter.isActive) throw statusError(409, "Filtr jest wstrzymany.");
  const sources = activeSources(filter);
  const sourceIds = [...sources.map((source) => source.id), ...(filter.sources.includes("facebook") ? ["facebook"] : [])];
  if (!sourceIds.length) throw statusError(400, "Filtr nie zawiera aktywnego obsługiwanego źródła.");
  // OLX is owned by its separate local-worker queue. Do not reserve a
  // Finder source_scans row for it; enqueueOlxJob creates the one async row.
  const lockableSourceIds = sources.filter((source) => source.id !== "olx").map((source) => source.id);
  if (lockableSourceIds.length) {
    const supabase = createAdminClient();
    await failStaleScans(supabase, filterId, lockableSourceIds);
    await reserveSourceScans(supabase, filterId, lockableSourceIds, runId, filter);
  }
  return { runId, status: "running", background: lockableSourceIds.length > 0 || sources.some((source) => source.id === "olx"), scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0 };
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
async function reserveSourceScans(supabase: SupabaseClient, filterId: string, lockableSourceIds: string[], runId: string, filter: LoadedFilter): Promise<void> {
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
  const filter = await getSearchFilter(filterId);
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
  const supabase = createAdminClient();
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
    const perSourceTimeoutMs = sourceTimeoutBudgetMs(sequentialSources.length);
    for (const source of sequentialSources) {
      const prepared = preparedScans.get(source.id);
      sourceResults.push(options.usePreparedRows && !prepared
        ? failedResult(source.id, 0, "SCAN_RESERVATION_MISSING", "Nie znaleziono zarezerwowanego etapu skanu.")
        : await scanSource(source, filterId, filter, supabase, runId, ownedScans, prepared, perSourceTimeoutMs));
    }
    if (sources.some((source) => source.id === "olx")) {
      try {
        await enqueueOlxJob(filter, runId);
        sourceResults.push(pendingResult("olx"));
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

/** Durable hourly continuation backed by the claim_finder_scan_source RPC. */
export async function runFinderScanContinuations(now = new Date()): Promise<FinderContinuationSummary> {
  const cycleAt = continuationCycleAt(now);
  const supabase = createAdminClient();
  const deadline = Date.now() + WORKER_MAX_DURATION_MS - WORKER_OVERHEAD_RESERVE_MS;
  let claimed = 0; let completed = 0; let deferred = 0; let failed = 0;
  const errors: string[] = [];

  while (Date.now() < deadline) {
    const { data, error } = await supabase.rpc("claim_finder_scan_source", {
      p_cycle_at: cycleAt,
      p_now: new Date().toISOString(),
      p_lease_seconds: Math.floor(CONTINUATION_LEASE_MS / 1_000),
    });
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
    if (!scanId || !filterId || !sourceId || !runId || !startedAt || !leaseToken) { errors.push("CONTINUATION_CLAIM_INVALID"); break; }
    claimed += 1;

    let filter: LoadedFilter | null;
    try {
      filter = await getSearchFilter(filterId);
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
    // initial request's 19.615s slice across the whole filter, so a source
    // that legitimately needs the normal 75s ceiling can finish on retry.
    const timeoutMs = sourceTimeoutBudgetMs(1);
    const prepared: PreparedSourceScan = { id: scanId, source: sourceId, started_at: startedAt, continuation_lease_token: leaseToken };
    const result = await scanSource(source, filterId, filter, supabase, runId, new Map(), prepared, timeoutMs, { preparedAlreadyRunning: true });
    if (result.status === "completed") completed += 1;
    else if (result.status === "pending") deferred += 1;
    else failed += 1;
  }
  return { status: errors.length || deferred > 0 ? "partial" : "completed", cycleAt, claimed, completed, deferred, failed, errors };
}

async function failClaimedContinuation(supabase: SupabaseClient, scanId: string, leaseToken: string, errorMessage: string): Promise<void> {
  await supabase.from("source_scans").update({ status: "failed", finished_at: new Date().toISOString(), error_message: errorMessage, continuation_next_at: null, continuation_lease_until: null, continuation_lease_token: null }).eq("id", scanId).eq("status", "running").eq("continuation_lease_token", leaseToken);
}

export async function scanSource(source: SearchSource, filterId: string, filter: LoadedFilter, supabase: SupabaseClient, runId: string, ownedScans: Map<string, ScanClock>, prepared?: PreparedSourceScan, timeoutMs: number = SOURCE_TIMEOUT_MS, options: { preparedAlreadyRunning?: boolean } = {}): Promise<SourceScanResult> {
  const started = Date.now();
  // Claims the prepared row with an atomic pending->running CAS, not a bare
  // update-by-id. The background callback that calls runManualOtodomScan
  // (see route.ts's runAfterResponse) has no guarantee against ever running
  // more than once for the same runId -- a platform-level retry or a second
  // after() firing would otherwise re-run source.fetch() and race its writes
  // against the first execution. The WHERE id=... AND status='pending' makes
  // Postgres itself the referee: at most one concurrent UPDATE can match a
  // given row, so at most one caller ever proceeds past this point for it.
  // The non-prepared insert path (tests, and the synchronous facebook-only
  // route) has no such row to race over, so it is unchanged.
  const { data: claimed, error } = prepared && options.preparedAlreadyRunning
    ? { data: [{ id: prepared.id, started_at: prepared.started_at, continuation_lease_token: prepared.continuation_lease_token ?? null }], error: null }
    : prepared
    ? await supabase.from("source_scans").update({ status: "running", filter_snapshot: filter }).eq("id", prepared.id).eq("status", "pending").select("id,started_at,continuation_lease_token").abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS))
    : await supabase.from("source_scans").insert({ search_filter_id: filterId, source: source.id, status: "running", scan_run_id: runId, filter_snapshot: filter }).select("id,started_at,continuation_lease_token").abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS)).single();
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

  let counters: ScanItemCounts = { listingsCreatedCount: 0, newMatchesCount: 0 };
  let updated = 0; let priceDrops = 0; let fetched = 0; let normalized = 0; let matched = 0; let warnings: string[] = [];
  let status: SourceScanResult["status"] = "completed"; let errorCode: string | null = null; let errorMessage: string | null = null;
  const otodomSummary = createOtodomFilterSummary();
  const matchDiagnostics = emptyMatchDiagnosticSummary();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await source.fetch(filter, controller.signal);
    fetched = result.fetched; normalized = result.listings.length; warnings = result.warnings;
    await updateSourceProgress(supabase, scan.id, filter, { fetched, matched, counters, updated, priceDrops }, controller.signal, scanClock.continuationLeaseToken);
    for (const listing of result.listings) {
      controller.signal.throwIfAborted();
      const decision = evaluateListingAgainstFilter(listing, filter);
      if (source.id === "otodom") addOtodomFilterDecision(otodomSummary, listing, decision);
      const saved = await persistListing(supabase, filterId, listing, decision.matches, decision.unknownFields, scan.id, scanTimestamp(scanClock), controller.signal);
      const diagnostic = createMatchDiagnostic(saved.listingId, listing, filter, decision);
      addMatchDiagnostic(matchDiagnostics, diagnostic);
      console.info("MATCH DIAGNOSTIC", JSON.stringify(diagnostic));
      if (decision.matches) matched += 1;
      counters = addScanItemCounts(counters, { listingCreated: saved.listingCreated, matchCreated: saved.matchCreated });
      updated += saved.updated; priceDrops += saved.priceDrop;
      await updateSourceProgress(supabase, scan.id, filter, { fetched, matched, counters, updated, priceDrops }, controller.signal, scanClock.continuationLeaseToken);
    }
    if (source.id === "otodom") console.info("OTODOM FILTER SUMMARY:", otodomSummary);
  } catch (reason) {
    const disposition = classifySourceFailure({ timedOut: controller.signal.aborted, error: reason });
    status = disposition.status;
    errorCode = disposition.errorCode;
    errorMessage = controller.signal.aborted ? `${source.label}: source timeout after ${timeoutMs / 1000}s` : disposition.errorCode === "SOURCE_FORBIDDEN" ? `${source.label}: access denied (HTTP 403); no retry` : reason instanceof Error ? reason.message : "Błąd źródła.";
  } finally {
    clearTimeout(timeoutId);
    await finalizeSourceScan(supabase, scan.id, scanClock, status, { fetched, matched, counters, updated, priceDrops, warnings, errorMessage });
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
 */
async function failStaleScans(supabase: SupabaseClient, filterId: string, sourceIds: string[]): Promise<void> {
  const { data: candidates, error: readError } = await supabase.from("source_scans").select("id,status,started_at,filter_snapshot,error_message").eq("search_filter_id", filterId).in("source", sourceIds).in("status", RECOVERABLE_SCAN_STATUSES).lt("started_at", staleScanCutoff(Date.now())).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
  if (readError) throw statusError(500, "Nie udało się sprawdzić wygasłej blokady skanu.");
  const staleIds = (Array.isArray(candidates) ? candidates : []).filter((candidate): candidate is { id: string; status: string; started_at: string | null; filter_snapshot: unknown; error_message: string | null } => Boolean(candidate && typeof candidate === "object" && typeof (candidate as { id?: unknown }).id === "string"))
    .filter((candidate) => !isContinuationPending(candidate.error_message))
    .filter((candidate) => isStaleScan({ status: candidate.status, startedAt: candidate.started_at, heartbeatAt: scanHeartbeatAt(candidate.filter_snapshot) }, Date.now()))
    .map((candidate) => candidate.id);
  if (!staleIds.length) return;
  const { error } = await supabase.from("source_scans").update({ status: "failed", finished_at: new Date().toISOString(), error_message: STALE_SCAN_MESSAGE }).in("id", staleIds).in("status", RECOVERABLE_SCAN_STATUSES).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
  if (error) throw statusError(500, "Nie udało się zwolnić wygasłej blokady skanu.");
}

async function loadPreparedSourceScans(supabase: SupabaseClient, runId: string, sourceIds: string[]): Promise<Map<string, PreparedSourceScan>> {
  const { data, error } = await supabase.from("source_scans").select("id,source,started_at,continuation_lease_token").eq("scan_run_id", runId).in("source", sourceIds).in("status", ["pending", "running"]).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
  if (error) throw statusError(500, "Nie udało się odczytać zarezerwowanego skanu.");
  return new Map((Array.isArray(data) ? data : []).flatMap((row) => {
    if (!row || typeof row !== "object" || typeof (row as { id?: unknown }).id !== "string" || typeof (row as { source?: unknown }).source !== "string" || typeof (row as { started_at?: unknown }).started_at !== "string") return [];
    return [[(row as { source: string }).source, row as PreparedSourceScan]] as const;
  }));
}

async function updateSourceProgress(supabase: SupabaseClient, scanId: string, filter: LoadedFilter, progress: Progress, signal: AbortSignal, continuationLeaseToken?: string | null): Promise<void> {
  const heartbeat = { lastProgressAt: new Date().toISOString(), checked: progress.fetched, matched: progress.matched, new: progress.counters.newMatchesCount };
  let query = supabase.from("source_scans").update({ scanned_count: progress.fetched, listings_found: progress.fetched, matched_count: progress.matched, listings_created: progress.counters.listingsCreatedCount, new_count: progress.counters.newMatchesCount, listings_updated: progress.updated, price_drop_count: progress.priceDrops, filter_snapshot: { ...filter, _scanProgress: heartbeat } }).eq("id", scanId);
  if (continuationLeaseToken) query = query.eq("continuation_lease_token", continuationLeaseToken);
  const { error } = await query.abortSignal(signal);
  if (error) throw new Error(`Nie udało się zapisać postępu skanu: ${error.message}`);
}

async function finalizeSourceScan(supabase: SupabaseClient, scanId: string, scanClock: ScanClock, status: SourceScanResult["status"], input: Progress & { warnings: string[]; errorMessage: string | null }): Promise<void> {
  const payload = { status, finished_at: status === "pending" ? null : scanTimestamp(scanClock), error_message: input.errorMessage, scanned_count: input.fetched, listings_found: input.fetched, matched_count: input.matched, listings_created: input.counters.listingsCreatedCount, new_count: input.counters.newMatchesCount, listings_updated: input.updated, price_drop_count: input.priceDrops, warnings: input.warnings, continuation_next_at: status === "pending" ? nextContinuationAt(Date.now()) : null, continuation_lease_until: null, continuation_lease_token: null };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let query = supabase.from("source_scans").update(payload).eq("id", scanId);
    if (scanClock.continuationLeaseToken) query = query.eq("continuation_lease_token", scanClock.continuationLeaseToken);
    const { error } = await query.abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
    if (!error) return;
    console.error("FLIP FINDER SOURCE FINALIZE ERROR:", { scanId, status, attempt, error });
  }
  throw new Error(`Nie udało się sfinalizować skanu źródła ${scanId}.`);
}

async function failOwnedRunningScans(supabase: SupabaseClient, scans: Map<string, ScanClock>): Promise<void> {
  for (const [scanId, scanClock] of scans) {
    const payload = { status: "pending", finished_at: null, error_message: "SOURCE_TIMEOUT: scan interrupted before finalization; waiting for continuation", continuation_next_at: nextContinuationAt(Date.now()), continuation_lease_until: null, continuation_lease_token: null };
    let query = supabase.from("source_scans").update(payload).eq("id", scanId).eq("status", "running");
    if (scanClock.continuationLeaseToken) query = query.eq("continuation_lease_token", scanClock.continuationLeaseToken);
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
function pendingResult(source: string, errorMessage = `${source === "olx" ? "OLX" : "Facebook"}: oczekuje na lokalny worker`): SourceScanResult { return { source, status: "pending", fetched: 0, normalized: 0, matched: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, durationMs: 0, errorCode: null, errorMessage, warnings: [], matchDiagnostics: emptyMatchDiagnosticSummary() }; }
function total(results: SourceScanResult[], key: "fetched" | "newMatches" | "matched"): number { return results.reduce((sum, result) => sum + result[key], 0); }
function scanLog(event: "SCAN START" | "SOURCE START" | "SOURCE DONE" | "SOURCE ERROR" | "SCAN FINALIZE", data: { scanId: string; source: string; checked: number; new: number; matched: number; durationMs: number }): void { if (process.env.NODE_ENV === "development") console.info(event, data); }

type OtodomFilterSummary = { evaluated: number; matched: number; rejectedByPricePerSqm: number; rejectedByPrice: number; rejectedByArea: number; rejectedByFloor: number; rejectedByBuildingType: number; rejectedByDistrict: number; rejectedByOtherCriteria: number; acceptedWithUnknownMetadata: number; examples: Array<{ title: string | null; price: number | null; area: number | null; calculatedPricePerSqm: number | null; rejectionReasons: string[] }> };
function createOtodomFilterSummary(): OtodomFilterSummary { return { evaluated: 0, matched: 0, rejectedByPricePerSqm: 0, rejectedByPrice: 0, rejectedByArea: 0, rejectedByFloor: 0, rejectedByBuildingType: 0, rejectedByDistrict: 0, rejectedByOtherCriteria: 0, acceptedWithUnknownMetadata: 0, examples: [] }; }
function addOtodomFilterDecision(summary: OtodomFilterSummary, listing: SourceListing, decision: ReturnType<typeof evaluateListingAgainstFilter>): void { summary.evaluated += 1; if (decision.matches) { summary.matched += 1; if (decision.unknownFields.length) summary.acceptedWithUnknownMetadata += 1; return; } const reasons = decision.reasons; if (reasons.includes("max_price_per_sqm")) summary.rejectedByPricePerSqm += 1; else if (reasons.some((reason) => reason.startsWith("price_"))) summary.rejectedByPrice += 1; else if (reasons.some((reason) => reason.startsWith("area_"))) summary.rejectedByArea += 1; else if (reasons.some((reason) => reason.startsWith("floor_") || reason === "ground_floor")) summary.rejectedByFloor += 1; else if (reasons.includes("building_type")) summary.rejectedByBuildingType += 1; else if (reasons.includes("district")) summary.rejectedByDistrict += 1; else summary.rejectedByOtherCriteria += 1; if (summary.examples.length < 5) summary.examples.push({ title: listing.title, price: listing.price, area: listing.area, calculatedPricePerSqm: listing.price !== null && listing.area !== null && listing.area > 0 ? listing.price / listing.area : null, rejectionReasons: reasons }); }

type StatusError = Error & { status: number };
function statusError(status: number, message: string): StatusError { return Object.assign(new Error(message), { status }); }
