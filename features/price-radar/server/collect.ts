import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { activeSources } from "@/features/flip-finder/server/search-source-registry";
import { isDisabledSource, SCHEMA_READY_SOURCE_IDS } from "@/features/flip-finder/source-availability";
import { assessRadarDistrictOnlyCandidate, isRadarQualificationRejectionReason, normalizeRadarQualificationRejections, qualifyRadarCandidate, recordRadarQualificationRejection } from "@/features/price-radar/qualification";
import { activeRadarListingExternalIds, markExistingRadarListingForReview, persistRadarListing } from "@/features/price-radar/server/persist-radar-listing";
import { radarDistrictQueueFailureWarning, rejectedRadarDistrictQueueExternalIds, upsertPendingDistrictCandidate } from "@/features/price-radar/server/radar-district-queue";
import { createRadarDistrictAiBudget } from "@/features/price-radar/server/radar-district-ai";
import { applyRadarVerificationDecision, confirmedRadarVerificationDecisions, isReviewableRadarVerificationCandidate, rejectedRadarVerificationExternalIds, upsertPendingRadarVerificationCandidate } from "@/features/price-radar/server/radar-verification-queue";
import { findRadarOwnListingConflicts } from "@/features/price-radar/own-listing-consistency";
import { enqueueRadarOlxJob } from "@/features/price-radar/server/radar-olx-queue";
import { SourceBatchYield, type RadarDetailCursor, type RadarDetailDiagnostic, type SourceBatch, type SourceBatchContext, type SourceBatchCursor } from "@/features/flip-finder/source-batches";
import type { RadarCheckpoint, RadarRun, RadarRunMetrics, RadarRunStatus, RadarSearchCriteria, RadarSource, RadarSourceMetrics, RadarWaitingReason } from "@/features/price-radar/types";
import type { SearchFilter } from "@/features/flip-finder";
import { classifyRadarSourceWarning, radarSourceStatusFromWarnings, sourceRejectionCountsFromWarnings } from "@/features/price-radar/source-diagnostics";

type Row = Record<string, unknown>;
/**
 * Time budget of one portion. Production uses the defaults; the performance
 * test passes a scaled copy so a whole run can be simulated in seconds.
 */
export type RadarPortionTiming = {
  /** Hard abort of one portion (inside Vercel Hobby's 60 s function limit). */
  portionBudgetMs: number;
  /** No new source attempt starts within this margin before the hard abort. */
  yieldMarginMs: number;
  /** Shortest per-source time slice; an attempt with less time left is not held against the portal. */
  minSliceMs: number;
  /** Time reserved for one detail request before the portion deadline. */
  detailReserveMs: number;
  /** Checkpoints are coalesced to at most one per interval while a source is being read. */
  checkpointIntervalMs: number;
  /** Active HTTP work per run; afterwards unfinished portals end as partial coverage. */
  httpRunLimitMs: number;
  /** Independent portals read at the same time (each by exactly one lane). */
  parallelSources: number;
};
export const RADAR_PORTION_TIMING: RadarPortionTiming = {
  portionBudgetMs: 42_000,
  yieldMarginMs: 8_000,
  minSliceMs: 10_000,
  detailReserveMs: 8_000,
  checkpointIntervalMs: 3_000,
  httpRunLimitMs: 30 * 60_000,
  parallelSources: 3,
};
export const RADAR_HTTP_TIME_LIMIT_ERROR = "RADAR_HTTP_TIME_LIMIT";
/** Stable portal context (e.g. city location IDs) is re-verified at least this often. */
const CONTEXT_VALUE_TTL_MS = 60 * 60_000;
/** Offers already committed in this run (`source:externalListingId`), bounded. */
const CHECKED_LISTING_KEYS_LIMIT = 4_000;
// The portion hard-aborts at 42s; 75s leaves 33s for checkpointing and avoids
// making the browser wait a full two minutes before its next CAS continuation.
const LEASE_SECONDS = 75;
const SOURCE_DONE_CURSOR = "__RADAR_SOURCE_DONE__";
// Confirmed on Production (runs 0938a6b6 and b525b4aa, 2026-10-13): portals
// that timed out or yielded on every portion were retried forever at the same
// cursor, so the run stayed "running" at the same counts and OLX (always last)
// never started. A detail timeout first commits a diagnostics-only batch with
// the SAME cursor, so "a batch was saved" is not progress. Only a counter
// increase or a cursor move is. After this many consecutive attempts without
// such progress the source is closed for this run only (rows already saved
// stay); other portals continue and the run can finish as partial.
export const RADAR_SOURCE_NO_PROGRESS_LIMIT = 3;
export const RADAR_SOURCE_NO_PROGRESS_ERROR = "RADAR_SOURCE_NO_PROGRESS_LIMIT";
const DETAIL_DIAGNOSTIC_SAMPLE_LIMIT = 5;
export const RADAR_STOPPED_BY_OPERATOR = "RADAR_STOPPED_BY_OPERATOR";
const DETAIL_DIAGNOSTIC_FIELDS = new Set(["total_price", "area", "rooms", "floor", "location", "city_lodz", "district", "building_type", "market_type", "apartment_sale", "finish_evidence", "renovation_completion", "renovation_recency", "move_in_readiness", "turnkey_finish", "active_listing", "identity"]);

/** Radar may only use sources that are both in the shared schema gate and have a registered adapter. */
export const RADAR_SOURCES: RadarSource[] = SCHEMA_READY_SOURCE_IDS.filter((id) => {
  const filter = syntheticCriteria(id as RadarSource);
  return activeSources(filter).some((source) => source.id === id);
});

function syntheticCriteria(sourceId: RadarSource, searchCriteria?: RadarSearchCriteria): SearchFilter {
  return {
    id: "price-radar-collection", name: "Radar cen po remoncie", sources: [sourceId], city: "Łódź", districts: [],
    priceMin: null, priceMax: null, areaMin: searchCriteria?.areaMin ?? null, areaMax: searchCriteria?.areaMax ?? null, rooms: searchCriteria?.rooms ?? [], floorMin: null, floorMax: null,
    excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
    privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
    minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 1440, isActive: true,
    lastScannedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

function defaultCheckpoint(sources: RadarSource[], searchCriteria?: RadarSearchCriteria): RadarCheckpoint {
  return {
    sourceQueue: sources,
    currentSourceIndex: 0,
    perSourceCursor: {},
    sourceStatuses: Object.fromEntries(sources.map((source) => [source, "pending"])),
    sourceErrors: {},
    sourceWarnings: {},
    sourceRejectionCounts: {},
    qualificationRejections: {},
    rejectedCount: 0,
    verificationQueuedCount: 0,
    districtQueuedCount: 0,
    ...(searchCriteria ? { searchCriteria: { ...searchCriteria, rooms: [...searchCriteria.rooms] } } : {}),
    buffer: [],
    bufferOffset: 0,
  };
}

function toRadarRun(row: Row): RadarRun {
  const raw = row.checkpoint;
  const checkpoint = isRecord(raw) && Array.isArray(raw.sourceQueue)
    ? raw as unknown as RadarCheckpoint
    : defaultCheckpoint(RADAR_SOURCES);
  const normalizedCheckpoint = { ...checkpoint, qualificationRejections: normalizeRadarQualificationRejections(checkpoint.qualificationRejections) };
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    leaseToken: typeof row.lease_token === "string" ? row.lease_token : null,
    leaseUntil: typeof row.lease_until === "string" ? row.lease_until : null,
    stopRequestedAt: typeof row.stop_requested_at === "string" ? row.stop_requested_at : null,
    userTerminatedAt: typeof row.user_terminated_at === "string" ? row.user_terminated_at : null,
    status: isRunStatus(row.status) ? row.status : "pending",
    startedAt: String(row.started_at),
    finishedAt: typeof row.finished_at === "string" ? row.finished_at : null,
    lastProgressAt: typeof checkpoint.lastProgressAt === "string" ? checkpoint.lastProgressAt : null,
    checkpoint: normalizedCheckpoint,
    scannedCount: typeof row.scanned_count === "number" ? row.scanned_count : 0,
    qualifiedCount: typeof row.qualified_count === "number" ? row.qualified_count : 0,
    errorMessage: typeof row.error_message === "string" ? row.error_message : null,
    sourceStatuses: isRecord(row.source_statuses) ? row.source_statuses as RadarRun["sourceStatuses"] : checkpoint.sourceStatuses,
    sourceErrors: checkpoint.sourceErrors ?? {},
    ...(isRecord(checkpoint.sourceWarnings) ? { sourceWarnings: checkpoint.sourceWarnings as RadarRun["sourceWarnings"] } : {}),
    ...(isRecord(checkpoint.sourceRejectionCounts) ? { sourceRejectionCounts: checkpoint.sourceRejectionCounts as RadarRun["sourceRejectionCounts"] } : {}),
    qualificationRejections: normalizedCheckpoint.qualificationRejections,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isRunStatus(value: unknown): value is RadarRunStatus { return value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "partial"; }
function rpcRow(value: unknown): Row | null { return Array.isArray(value) ? isRecord(value[0]) ? value[0] : null : isRecord(value) ? value : null; }
function sourceError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]/g, " ").slice(0, 500); }
function recordRadarSourceWarnings(checkpoint: RadarCheckpoint, sourceId: string, warnings: readonly string[]): void {
  const informational: string[] = [];
  const failures: string[] = [];
  for (const warning of warnings) {
    (classifyRadarSourceWarning(warning) === "source_error" ? failures : informational).push(sourceError(warning));
  }
  if (informational.length) {
    checkpoint.sourceWarnings ??= {};
    const existing = checkpoint.sourceWarnings[sourceId] ?? [];
    checkpoint.sourceWarnings[sourceId] = [...new Set([...existing, ...informational])].slice(0, 20);
  }
  if (failures.length) {
    const existing = checkpoint.sourceErrors[sourceId];
    checkpoint.sourceErrors[sourceId] = [...new Set([...(existing ? [existing] : []), ...failures])].join("; ").slice(0, 1_000);
  }
}

function addSourceRejectionCounts(checkpoint: RadarCheckpoint, sourceId: string, counts: Readonly<Record<string, number>>): void {
  const valid = Object.entries(counts).filter((entry): entry is [string, number] => /^[a-z_]{1,64}$/u.test(entry[0]) && Number.isSafeInteger(entry[1]) && entry[1] > 0);
  if (!valid.length) return;
  checkpoint.sourceRejectionCounts ??= {};
  const sourceCounts = checkpoint.sourceRejectionCounts[sourceId] ?? {};
  for (const [reason, count] of valid) sourceCounts[reason] = (sourceCounts[reason] ?? 0) + count;
  checkpoint.sourceRejectionCounts[sourceId] = sourceCounts;
}

function isRetryableTimeout(error: unknown, signal: AbortSignal): boolean { return signal.aborted || (error instanceof Error && (error.name === "AbortError" || /timeout|aborted/i.test(error.message))); }
function isTerminalAccessError(error: unknown): boolean { return /\b403\b|forbidden|captcha|access denied/i.test(sourceError(error)); }
function sourceDate(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return null;
}

export type RadarClaimResult = { kind: "claimed"; run: RadarRun } | { kind: "blocked" };
export type RadarResumeResult = { kind: "claimed"; run: RadarRun } | { kind: "blocked"; reason: "run_changed" | "lease_active" | "olx_queue_owns_source" | "inconsistent_run" };
export type RadarStopResult = { kind: "stopping" | "stopped" } | { kind: "blocked"; reason: "run_changed" | "not_active" };

/** Requests a stop for only the authenticated owner's exact Radar run. */
export async function requestRadarRunStop(ownerId: string, expectedRunId: string, supabase: SupabaseClient = createAdminClient()): Promise<RadarStopResult> {
  const { data, error } = await supabase.rpc("request_price_radar_run_stop", {
    p_owner_id: ownerId,
    p_run_id: expectedRunId,
  });
  if (error) throw new Error("RADAR_RUN_STOP_FAILED");
  const result = typeof data === "string" ? data : rpcRow(data)?.result;
  if (result === "stopping" || result === "stopped") return { kind: result };
  if (result === "not_active") return { kind: "blocked", reason: "not_active" };
  return { kind: "blocked", reason: "run_changed" };
}

export type RadarTerminationResult = { kind: "terminated" } | { kind: "blocked"; reason: "run_changed" | "not_active" };

/** Permanently ends only the authenticated owner's exact Radar run. */
export async function requestRadarRunTermination(ownerId: string, expectedRunId: string, supabase: SupabaseClient = createAdminClient()): Promise<RadarTerminationResult> {
  const { data, error } = await supabase.rpc("terminate_price_radar_run", {
    p_owner_id: ownerId,
    p_run_id: expectedRunId,
  });
  if (error) throw new Error("RADAR_RUN_TERMINATION_FAILED");
  const result = typeof data === "string" ? data : rpcRow(data)?.result;
  if (result === "terminated") return { kind: "terminated" };
  if (result === "not_active") return { kind: "blocked", reason: "not_active" };
  return { kind: "blocked", reason: "run_changed" };
}

/** The DB RPC serializes claims by owner and returns a fenced lease token. */
export async function claimOrCreateRadarRun(ownerId: string, selectedSources: readonly RadarSource[] = RADAR_SOURCES, supabase: SupabaseClient = createAdminClient(), searchCriteria?: RadarSearchCriteria): Promise<RadarClaimResult> {
  const allowed = new Set(RADAR_SOURCES);
  const sourceQueue = selectedSources.length ? selectedSources.filter((source) => allowed.has(source)) : [...RADAR_SOURCES];
  const initialCheckpoint = defaultCheckpoint(sourceQueue, searchCriteria);
  const { data, error } = await supabase.rpc("claim_price_radar_run", {
    p_owner_id: ownerId,
    p_initial_checkpoint: initialCheckpoint,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("RADAR_RUN_CLAIM_FAILED");
  const row = rpcRow(data);
  return row ? { kind: "claimed", run: toRadarRun({ ...row, id: row.run_id, owner_id: ownerId, lease_token: row.lease_token }) } : { kind: "blocked" };
}

/**
 * Reclaims only the exact nonterminal run observed by the UI. The old lease
 * token and expiry are part of the UPDATE predicate, so only one concurrent
 * resume can win. This deliberately never inserts a run. The OLX source stays
 * under claim_price_radar_run because that RPC also atomically fences/requeues
 * its separate worker job; the browser must wait for that queue instead.
 */
export async function resumeExistingRadarRun(ownerId: string, expectedRunId: string, supabase: SupabaseClient = createAdminClient()): Promise<RadarResumeResult> {
  const selected = await supabase.from("price_radar_runs").select("*").eq("id", expectedRunId).eq("owner_id", ownerId).maybeSingle();
  if (selected.error || !selected.data) return { kind: "blocked", reason: "run_changed" };
  const row = selected.data as Row;
  if (typeof row.user_terminated_at === "string") return { kind: "blocked", reason: "run_changed" };
  const stoppedRun = row.status === "partial" && row.error_message === RADAR_STOPPED_BY_OPERATOR && typeof row.stop_requested_at === "string";
  if (row.stop_requested_at && !stoppedRun) return { kind: "blocked", reason: "run_changed" };
  if (row.status !== "pending" && row.status !== "running" && !stoppedRun) return { kind: "blocked", reason: "run_changed" };

  const run = toRadarRun(row);
  const now = Date.now();
  const oldLeaseUntil = typeof row.lease_until === "string" ? row.lease_until : null;
  if (oldLeaseUntil && !Number.isFinite(Date.parse(oldLeaseUntil))) return { kind: "blocked", reason: "inconsistent_run" };
  if (oldLeaseUntil && Date.parse(oldLeaseUntil) > now) return { kind: "blocked", reason: "lease_active" };

  const checkpoint = run.checkpoint;
  if (!Array.isArray(checkpoint.sourceQueue) || !isRecord(checkpoint.sourceStatuses)) return { kind: "blocked", reason: "inconsistent_run" };
  if (!Number.isInteger(checkpoint.currentSourceIndex) || checkpoint.currentSourceIndex < 0 || checkpoint.currentSourceIndex > checkpoint.sourceQueue.length
    || checkpoint.sourceQueue.some((source) => !Object.hasOwn(checkpoint.sourceStatuses, source))) return { kind: "blocked", reason: "inconsistent_run" };
  if (nextUnfinishedSourceIndex(checkpoint, checkpoint.currentSourceIndex) === null) return { kind: "blocked", reason: "inconsistent_run" };
  if (checkpoint.sourceQueue.some((source) => source === "olx" && checkpoint.sourceStatuses.olx === "running")) {
    const job = await supabase.from("olx_scan_jobs").select("status")
      .eq("context_type", "price_radar").eq("radar_owner_id", ownerId).eq("radar_run_id", expectedRunId)
      .maybeSingle();
    // The separate worker keeps ownership while a queued/running reservation
    // exists. A terminal job, however, must release the Radar checkpoint so
    // collect() can record its actual outcome and continue later portals.
    if (job.error || (job.data?.status !== "failed" && job.data?.status !== "completed")) {
      return { kind: "blocked", reason: "olx_queue_owns_source" };
    }
  }

  const leaseToken = randomUUID();
  let update = supabase.from("price_radar_runs").update({
    status: "running",
    lease_token: leaseToken,
    lease_until: new Date(now + LEASE_SECONDS * 1000).toISOString(),
    error_message: null,
    finished_at: null,
    stop_requested_at: null,
  }).eq("id", expectedRunId).eq("owner_id", ownerId).eq("status", row.status);
  update = row.lease_token === null || row.lease_token === undefined ? update.is("lease_token", null) : update.eq("lease_token", row.lease_token);
  if (oldLeaseUntil === null) update = update.is("lease_until", null);
  else update = update.eq("lease_until", oldLeaseUntil).lte("lease_until", new Date(now).toISOString());
  const claimed = await update.select("*").maybeSingle();
  if (claimed.error) throw new Error("RADAR_RUN_RESUME_FAILED");
  if (!claimed.data) return { kind: "blocked", reason: "run_changed" };
  return { kind: "claimed", run: toRadarRun(claimed.data as Row) };
}

/**
 * Ends the caller's own lease right after its portion returned "running", so
 * the very next continuation (server chain, scheduler or browser) can claim
 * the same checkpoint immediately instead of waiting for the lease to expire.
 * Fenced by the exact lease token: it can never release another worker's
 * lease, and it keeps the token so resumeExistingRadarRun's CAS stays exact.
 */
export async function releaseRadarRunLease(input: { runId: string; ownerId: string; leaseToken: string }, supabase: SupabaseClient = createAdminClient()): Promise<boolean> {
  const released = await supabase.from("price_radar_runs").update({ lease_until: new Date().toISOString() })
    .eq("id", input.runId).eq("owner_id", input.ownerId).eq("status", "running").eq("lease_token", input.leaseToken)
    .select("id").maybeSingle();
  return !released.error && Boolean(released.data);
}

/**
 * Stores why the server could not hand the run to its next hop, so the PWA and
 * Supabase show it. Fenced by the releasing worker's lease token: once another
 * worker has claimed the run this is a no-op and never overwrites its state.
 */
export async function recordRadarContinuationFailure(input: { runId: string; ownerId: string; leaseToken: string }, failure: { hop: number; reason: string }, supabase: SupabaseClient = createAdminClient()): Promise<void> {
  const current = await supabase.from("price_radar_runs").select("checkpoint")
    .eq("id", input.runId).eq("owner_id", input.ownerId).eq("status", "running").eq("lease_token", input.leaseToken).maybeSingle();
  if (current.error || !current.data || !isRecord(current.data.checkpoint)) return;
  const checkpoint = current.data.checkpoint as unknown as RadarCheckpoint;
  checkpoint.progress = { ...(checkpoint.progress ?? {}), lastContinuationError: { at: new Date().toISOString(), hop: failure.hop, reason: failure.reason.slice(0, 200) } };
  await supabase.from("price_radar_runs").update({ checkpoint })
    .eq("id", input.runId).eq("owner_id", input.ownerId).eq("status", "running").eq("lease_token", input.leaseToken)
    .select("id").maybeSingle();
}

export type RadarPortionResult ={ status: "running" | "completed" | "failed" | "partial"; scannedCount: number; qualifiedCount: number; sourceStatuses: RadarRun["sourceStatuses"]; sourceErrors: Record<string, string>; sourceWarnings?: RadarRun["sourceWarnings"]; sourceRejectionCounts?: RadarRun["sourceRejectionCounts"]; qualificationRejections: NonNullable<RadarRun["qualificationRejections"]>; waitingReason?: RadarWaitingReason | null; waitingUntil?: string | null };

/**
 * Runs one time-boxed source portion. Every listing write and every checkpoint
 * is lease-fenced in SQL. A timeout keeps the current source pending and moves
 * it behind other unfinished sources, so a repeatedly slow portal cannot starve
 * the rest of this run. A permanent source error is terminal for this run.
 */
export async function runRadarCollectionPortion(input: { runId: string; ownerId: string; leaseToken: string }, supabase: SupabaseClient = createAdminClient(), timing: RadarPortionTiming = RADAR_PORTION_TIMING): Promise<RadarPortionResult> {
  const started = Date.now();
  const portionYieldAt = started + timing.portionBudgetMs - timing.yieldMarginMs;
  const { data: runRow, error } = await supabase.from("price_radar_runs").select("*").eq("id", input.runId).eq("owner_id", input.ownerId).maybeSingle();
  if (error || !runRow) throw new Error("RADAR_RUN_NOT_FOUND");
  const run = toRadarRun(runRow);
  if (run.status === "completed" || run.status === "failed" || run.status === "partial") return resultOf(run);
  if (run.userTerminatedAt) return resultOf(run);
  if (run.leaseToken !== input.leaseToken) throw new Error("RADAR_LEASE_LOST");

  const checkpoint = run.checkpoint;
  let scanned = run.scannedCount;
  let qualified = run.qualifiedCount;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timing.portionBudgetMs);
  let stopCheckInFlight = false;
  let operatorStopDetected = false;
  let userTerminationDetected = false;
  const stopCheckId = setInterval(() => {
    if (stopCheckInFlight || operatorStopDetected || userTerminationDetected) return;
    stopCheckInFlight = true;
    void Promise.resolve(supabase.from("price_radar_runs").select("status,lease_token,stop_requested_at,error_message,user_terminated_at")
      .eq("id", input.runId).eq("owner_id", input.ownerId).maybeSingle())
      .then(({ data: current, error: stopReadError }) => {
        if (stopReadError || !current) return;
        if (current.user_terminated_at || current.error_message === RADAR_TERMINATED_BY_USER) {
          userTerminationDetected = true;
          controller.abort(new DOMException("Radar run terminated by its owner", "AbortError"));
          return;
        }
        if (current.stop_requested_at || current.status !== "running" || current.lease_token !== input.leaseToken) {
          operatorStopDetected = Boolean(current.stop_requested_at || current.error_message === RADAR_STOPPED_BY_OPERATOR);
          if (operatorStopDetected) controller.abort(new DOMException("Radar stop requested", "AbortError"));
        }
      })
      .finally(() => { stopCheckInFlight = false; });
  }, 1_000);
  const attemptedSourceIds = new Set<RadarSource>();
  const progressMarkerAtStart = checkpoint.progress?.lastRealProgressAt ?? null;
  const metrics = startPortionMetrics(checkpoint, started);
  const checkedListingKeys = new Set(Array.isArray(checkpoint.checkedListingKeys) ? checkpoint.checkedListingKeys.filter((key): key is string => typeof key === "string") : []);
  let lastCheckpointAt = 0;
  let httpAttemptedThisPortion = false;
  // Every checkpoint write goes through here so its cost is measured and the
  // checked-offer set travels with the cursor it belongs to.
  // Lanes save one after another; each write snapshots the newest shared
  // state when it actually runs, so an older snapshot can never land last.
  let saveChain: Promise<unknown> = Promise.resolve();
  const save = (status: RadarRunStatus, errorMessage: string | null = null, sourceId?: string): Promise<"saved" | "stopped"> => {
    const run = async () => {
      const saveStartedAt = Date.now();
      checkpoint.checkedListingKeys = [...checkedListingKeys].slice(-CHECKED_LISTING_KEYS_LIMIT);
      try {
        return await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, status, errorMessage);
      } finally {
        lastCheckpointAt = Date.now();
        if (sourceId) sourceMetrics(metrics, sourceId).checkpointMs += lastCheckpointAt - saveStartedAt;
      }
    };
    const next = saveChain.then(run, run);
    saveChain = next.catch(() => undefined);
    return next;
  };
  // One query answers both "terminated?" and "stop requested?"; the 1 s
  // background check above sets the same flags between batches.
  const ensureRunStillOwned = async () => {
    if (userTerminationDetected) throw new Error(RADAR_TERMINATED_BY_USER);
    if (operatorStopDetected) throw new Error(RADAR_STOPPED_BY_OPERATOR);
    const control = await radarRunControl(supabase, input);
    if (control.terminated) { userTerminationDetected = true; throw new Error(RADAR_TERMINATED_BY_USER); }
    if (control.stopRequested) { operatorStopDetected = true; throw new Error(RADAR_STOPPED_BY_OPERATOR); }
  };  // One shared cap on AI district-suggestion calls for this whole portion
  // (not per candidate) -- bounds cost/latency the same way the portion's
  // own time budget already bounds a single invocation's work.
  const districtAiBudget = createRadarDistrictAiBudget();
  // Independent portals (different hosts) run in a small pool of lanes; one
  // portal is never read by two lanes and its own requests stay sequential,
  // so no portal sees more traffic than before. All lanes share this run's
  // single lease and checkpoint; checkpoint writes are serialized.
  const activeHttpLanes = new Set<RadarSource>();
  // Portals that gave their lane back after real progress at the end of their
  // time slice; a free lane takes them up again within the same portion.
  const resumableThisPortion: RadarSource[] = [];
  const pageCaches = new Map<RadarSource, Map<string, { html: string; finalUrl: string }>>();
  const pickNextSource = (): RadarSource | null => {
    // A legacy checkpoint whose OLX stage is owned by the worker runs nothing
    // else: the worker's finalize replaces the whole checkpoint.
    if (checkpoint.sourceStatuses.olx === "running" && checkpoint.sourceQueue.includes("olx")) {
      return !attemptedSourceIds.has("olx") && activeHttpLanes.size === 0 ? "olx" : null;
    }
    for (const candidate of checkpoint.sourceQueue) {
      if (candidate === "olx" || attemptedSourceIds.has(candidate) || sourceFinished(checkpoint, candidate)) continue;
      return candidate;
    }
    while (resumableThisPortion.length) {
      const resumable = resumableThisPortion.shift()!;
      if (!sourceFinished(checkpoint, resumable) && !activeHttpLanes.has(resumable)) return resumable;
    }
    const httpLeft = checkpoint.sourceQueue.some((candidate) => candidate !== "olx" && !sourceFinished(checkpoint, candidate));
    if (!httpLeft && activeHttpLanes.size === 0 && checkpoint.sourceQueue.includes("olx") && !attemptedSourceIds.has("olx") && !sourceFinished(checkpoint, "olx")) return "olx";
    return null;
  };
  const lane = async (): Promise<void> => {
    while (true) {
      if (Date.now() >= portionYieldAt || userTerminationDetected || operatorStopDetected) return;
      // Bounded run: past the active HTTP limit every unfinished portal ends
      // as honestly reported partial coverage; OLX (its own worker) follows.
      // A portal another lane is reading right now is closed by that lane's
      // next check, never under its feet (it still owns status and cursor).
      if (closeHttpSourcesPastTimeLimit(checkpoint, metrics, Date.now() - started, timing.httpRunLimitMs, activeHttpLanes)) await save("running");
      const sourceId = pickNextSource();
      if (!sourceId) return;
      // Claimed synchronously, before any await, so no other lane takes it.
      attemptedSourceIds.add(sourceId);
      // The OLX worker finalizes by moving the cursor one step past OLX, so a
      // newly handed-over OLX stage must be the last entry of the queue.
      if (sourceId === "olx" && checkpoint.sourceStatuses.olx !== "running") {
        checkpoint.sourceQueue = [...checkpoint.sourceQueue.filter((candidate) => candidate !== "olx"), "olx"];
      }
      if (sourceId !== "olx") activeHttpLanes.add(sourceId);
      checkpoint.currentSourceIndex = checkpoint.sourceQueue.indexOf(sourceId);
      try {
        const control = await radarRunControl(supabase, input);
        if (control.terminated) { userTerminationDetected = true; controller.abort(new DOMException("Radar run terminated by its owner", "AbortError")); return; }
        if (control.stopRequested) {
          operatorStopDetected = true;
          if (checkpoint.sourceStatuses[sourceId] === "running") checkpoint.sourceStatuses[sourceId] = "pending";
          await save("partial", RADAR_STOPPED_BY_OPERATOR).catch(() => undefined);
          controller.abort(new DOMException("Radar stop requested", "AbortError"));
          return;
        }
        if (await attemptSource(sourceId) === "stop") return;
      } finally {
        activeHttpLanes.delete(sourceId);
      }
    }
  };
  const attemptSource = async (sourceId: RadarSource): Promise<"next" | "stop"> => {
      const attemptStartedAt = Date.now();
      // Per portal: with parallel lanes the run-wide counters also grow from
      // other portals, which must never make a stalled portal look alive.
      const attemptBefore = { fetched: sourceMetrics(metrics, sourceId).fetched, cursor: cursorProgressKey(checkpoint.perSourceCursor[sourceId]) };
      const attemptProgressed = () => sourceMetrics(metrics, sourceId).fetched > attemptBefore.fetched || cursorProgressKey(checkpoint.perSourceCursor[sourceId]) !== attemptBefore.cursor;
      // Each unfinished portal gets a fair share of what is left of this
      // portion (at least minSliceMs); a portal that started with less than
      // that was cut short by the portion, not by its own failure.
      const portionLeftMs = portionYieldAt - attemptStartedAt;
      const hadFairShare = portionLeftMs >= timing.minSliceMs;
      const turnsLeft = Math.ceil((unattemptedHttpSources(checkpoint, attemptedSourceIds) + 1) / Math.max(1, timing.parallelSources));
      const sliceDeadlineAt = attemptStartedAt + Math.max(timing.minSliceMs, portionLeftMs / Math.max(1, turnsLeft));
      if (sourceId !== "olx") httpAttemptedThisPortion = true;
      const attemptMetrics = sourceMetrics(metrics, sourceId);
      attemptMetrics.attempts += 1;
      const source = activeSources(syntheticCriteria(sourceId, checkpoint.searchCriteria)).find((candidate) => candidate.id === sourceId);
      if (!source) {
        // A run claimed before a source was turned off can still carry it in
        // its own saved sourceQueue (e.g. "szybko"). Resuming that old
        // checkpoint must skip the stage through this exact same no-fetch
        // path -- never retrying it, never blocking the rest of the queue --
        // with an honest, specific reason distinct from "never registered".
        checkpoint.sourceStatuses[sourceId] = "failed";
        checkpoint.sourceErrors[sourceId] = isDisabledSource(sourceId) ? "Źródło wyłączone." : "SOURCE_NOT_ACTIVE_OR_REGISTERED";
        await save("running");
        return "next";
      }

      checkpoint.sourceStatuses[sourceId] = "running";
      if (!isRadarDetailCursor(checkpoint.perSourceCursor[sourceId]) || checkpoint.sourceErrors[sourceId]?.startsWith("RADAR_PORTION_TIME_BUDGET_EXCEEDED:")) delete checkpoint.sourceErrors[sourceId];
      await save("running");
      try {
      try {
        if (sourceId === "olx") {
          checkpoint.currentSourceIndex = checkpoint.sourceQueue.indexOf("olx");
          const job = await enqueueRadarOlxJob({ ownerId: input.ownerId, runId: input.runId, leaseToken: input.leaseToken, city: "Łódź" }, supabase);
          metrics.olxEnqueuedAt ??= new Date().toISOString();
          if (job.status === "completed") {
            checkpoint.sourceStatuses.olx = "completed";
            checkpoint.perSourceCursor.olx = SOURCE_DONE_CURSOR;
            await save("running");
            return "next";
          }
          checkpoint.sourceStatuses.olx = "running";
          await save("running");
          return "stop";
        }
        let emittedBatches = false;
      const processBatch = async (batch: SourceBatch, nextCursor: SourceBatchCursor) => {
          const batchStartedAt = Date.now();
          await ensureRunStillOwned();
          // Past this portion's end only this lane gives its turn back; the
          // shared abort would also cut other lanes' in-flight requests. The
          // uncommitted batch is read again from the same cursor next time.
          if (Date.now() >= portionYieldAt) throw new SourceBatchYield("portion_budget");
          emittedBatches = true;
          const batchRejectionReasons = [...(batch.rejectionReasons ?? [])];
          let batchQualified = 0;
          let batchVerificationQueued = 0;
          let batchDistrictQueued = 0;
          const batchExternalIds = batch.listings.map((listing) => listing.externalListingId);
          let writesInBatch = 0;
          // The batch start was just checked; before every further write in
          // the same batch the run is re-checked, so nothing is saved after a
          // STOP or termination. Rejected candidates need no extra query.
          const beforeWrite = async () => {
            if (writesInBatch > 0) await ensureRunStillOwned();
            writesInBatch += 1;
          };
          const lookupsStartedAt = Date.now();
          const [verificationDecisions, rejectedVerificationIds, rejectedDistrictIds, activeAnalysisIds] = await Promise.all([
            confirmedRadarVerificationDecisions(supabase, input.ownerId, sourceId, batchExternalIds),
            rejectedRadarVerificationExternalIds(supabase, input.ownerId, sourceId, batchExternalIds),
            rejectedRadarDistrictQueueExternalIds(supabase, input.ownerId, sourceId, batchExternalIds),
            activeRadarListingExternalIds(supabase, input.ownerId, sourceId, batchExternalIds),
          ]);
          attemptMetrics.dbMs += Date.now() - lookupsStartedAt;
          let writeMs = 0;
          let qualifyMs = 0;
          for (const sourceListing of batch.listings) {
            const manualDecision = verificationDecisions.get(sourceListing.externalListingId);
            const listing = manualDecision ? applyRadarVerificationDecision(sourceListing, manualDecision) : sourceListing;
            controller.signal.throwIfAborted();
            if (userTerminationDetected) throw new Error(RADAR_TERMINATED_BY_USER);
            if (operatorStopDetected) throw new Error(RADAR_STOPPED_BY_OPERATOR);
            const qualifyStartedAt = Date.now();
            const qualificationCandidate = {
              source: listing.source, externalListingId: listing.externalListingId, originalUrl: listing.originalUrl, normalizedUrl: listing.normalizedUrl,
              title: listing.title, description: listing.description, price: listing.price, area: listing.area, pricePerSqm: listing.pricePerSqm,
              rooms: listing.rooms, city: listing.city, district: listing.district, buildingType: listing.buildingType,
              marketType: typeof listing.rawPayload.marketType === "string" ? listing.rawPayload.marketType : null,
              propertyType: typeof listing.rawPayload.propertyType === "string" ? listing.rawPayload.propertyType : null,
              rawPayload: listing.rawPayload, contentHash: listing.contentHash,
            };
            const outcome = qualifyRadarCandidate(qualificationCandidate, checkpoint.searchCriteria?.qualityRulesVersion ?? 1, manualDecision, checkpoint.searchCriteria?.minPricePerSqm, checkpoint.searchCriteria?.districts, checkpoint.searchCriteria?.areaMin, checkpoint.searchCriteria?.areaMax);
            qualifyMs += Date.now() - qualifyStartedAt;
            const writeStartedAt = Date.now();
            try {
            if (!outcome.qualified) {
              if (outcome.reason === "detail_conflict" && (listing.source === "oferty_net" || listing.source === "domiporta")) {
                const evidence = isRecord(listing.rawPayload.detailEvidence) ? listing.rawPayload.detailEvidence : {};
                const recorded = Array.isArray(listing.rawPayload.detailContradictions)
                  ? listing.rawPayload.detailContradictions.filter((field): field is string => typeof field === "string")
                  : [];
                const conflicts = [...new Set([...recorded, ...findRadarOwnListingConflicts({
                  area: listing.area,
                  rooms: listing.rooms,
                  floor: typeof evidence.floor === "number" ? evidence.floor : null,
                  locationText: typeof evidence.locationText === "string" ? evidence.locationText : typeof listing.rawPayload.detailLocationText === "string" ? listing.rawPayload.detailLocationText : null,
                  title: listing.title,
                  description: listing.description,
                })])];
                await beforeWrite();
                await markExistingRadarListingForReview(supabase, {
                  ownerId: input.ownerId, runId: input.runId, leaseToken: input.leaseToken, seenAt: new Date().toISOString(),
                }, { source: listing.source, externalListingId: listing.externalListingId, issueFields: conflicts }, controller.signal);
              }
              const verificationInput = {
                listing,
                reason: outcome.reason,
                detailUnconfirmedFields: isRecord(listing.rawPayload.detailEvidence) && Array.isArray(listing.rawPayload.detailEvidence.unconfirmedFields)
                  ? listing.rawPayload.detailEvidence.unconfirmedFields.filter((field): field is string => typeof field === "string") : [],
                detailContradictoryFields: Array.isArray(listing.rawPayload.detailContradictions)
                  ? listing.rawPayload.detailContradictions.filter((field): field is string => typeof field === "string") : [],
                seenAt: new Date().toISOString(),
              };
              const isReviewable = isReviewableRadarVerificationCandidate(verificationInput);
              // A listing already represented by an active row in the comparison analysis must
              // never be queued again for manual review -- that would just duplicate a decision
              // the operator already made (or never needed to make) for the same listing.
              if (isReviewable && activeAnalysisIds.has(listing.externalListingId)) {
                batchRejectionReasons.push("already_in_analysis");
                continue;
              }
              // A candidate missing ONLY its district (every other criterion
              // already confirmed) goes to the manual district-assignment
              // queue instead of a dead-end rejection count -- it is an
              // actionable item for the operator, not a failure. Anything
              // that would still fail on a different ground (building,
              // market, finish, rental, ...) keeps its normal rejection
              // reason and is never queued.
              if (outcome.reason === "district_not_confirmed") {
                const districtAssessment = assessRadarDistrictOnlyCandidate(qualificationCandidate, checkpoint.searchCriteria?.qualityRulesVersion ?? 1, checkpoint.searchCriteria?.minPricePerSqm, checkpoint.searchCriteria?.districts, checkpoint.searchCriteria?.areaMin, checkpoint.searchCriteria?.areaMax);
                if (districtAssessment.eligible) {
                  await beforeWrite();
                  const queueResult = await upsertPendingDistrictCandidate(supabase, input.ownerId, {
                    source: listing.source, externalListingId: listing.externalListingId, originalUrl: listing.originalUrl, normalizedUrl: listing.normalizedUrl,
                    title: listing.title, description: listing.description, price: listing.price!, area: listing.area!, rooms: listing.rooms,
                    city: listing.city!, contentHash: listing.contentHash, crossSourceIdentity: listing.crossSourceIdentity ?? null,
                    publishedAt: listing.publishedAt ?? null, sourceUpdatedAt: sourceDate(listing.rawPayload, ["updatedAt", "modifiedAt", "updated_at", "modified_at"]),
                    rawPayload: listing.rawPayload,
                  }, districtAssessment.confirmed, new Date().toISOString(), districtAiBudget);
                  if (!queueResult.ok) {
                    recordRadarSourceWarnings(checkpoint, sourceId, [radarDistrictQueueFailureWarning(queueResult.reason)]);
                  } else batchDistrictQueued += 1;
                  continue;
                }
              }
              if (isReviewable) {
                await beforeWrite();
                const queueResult = await upsertPendingRadarVerificationCandidate(supabase, input.ownerId, verificationInput, districtAiBudget);
                if (!queueResult.ok) recordRadarSourceWarnings(checkpoint, sourceId, [queueResult.reason === "schema_unavailable"
                  ? "RADAR_VERIFICATION_QUEUE_UNAVAILABLE: kolejka wymaga lokalnego draftu 20261012130000_add_price_radar_verification_queue.sql"
                  : "RADAR_VERIFICATION_QUEUE_SAVE_FAILED: kandydat nie został zapisany do weryfikacji"]);
                if (queueResult.ok) { batchVerificationQueued += 1; continue; }
              }
              batchRejectionReasons.push(outcome.reason);
              continue;
            }
            // An operator's prior rejection in either manual queue must not be bypassed just
            // because a later scan found the previously missing detail, since that would let
            // the same listing qualify directly here without ever reconsulting the decision.
            if (rejectedVerificationIds.has(listing.externalListingId) || rejectedDistrictIds.has(listing.externalListingId)) {
              batchRejectionReasons.push("previously_rejected_by_operator");
              continue;
            }
            const raw = listing.rawPayload;
            const crossSourceIdentity = listing.crossSourceIdentity ?? null;
            await beforeWrite();
            const persisted = await persistRadarListing(supabase, {
              ...outcome, source: listing.source, externalListingId: listing.externalListingId,
              originalUrl: listing.originalUrl, normalizedUrl: listing.normalizedUrl, title: listing.title,
              description: listing.description, price: listing.price!, area: listing.area!, rooms: listing.rooms,
              city: listing.city!, contentHash: listing.contentHash, publishedAt: listing.publishedAt ?? null,
              sourceUpdatedAt: sourceDate(raw, ["updatedAt", "modifiedAt", "updated_at", "modified_at"]),
              crossSourceIdentity, rawPayload: raw,
            }, { ownerId: input.ownerId, runId: input.runId, leaseToken: input.leaseToken, seenAt: new Date().toISOString() }, controller.signal);
            if (persisted.identityConflictFields?.length) {
              batchRejectionReasons.push("listing_identity_changed");
              continue;
            }
            batchQualified += 1;
            } finally {
              writeMs += Date.now() - writeStartedAt;
            }
          }
          attemptMetrics.dbMs += writeMs;
          attemptMetrics.qualifyMs += qualifyMs;
          // Only checkpoint counters when every row in the page batch has
          // been processed. If STOP lands mid-batch, its cursor remains at
          // the previous committed page and an idempotent replay must not
          // count already-persisted rows twice.
          scanned += batch.fetched;
          qualified += batchQualified;
          for (const reason of batchRejectionReasons) {
            if (isRadarQualificationRejectionReason(reason)) recordRadarQualificationRejection(checkpoint.qualificationRejections ??= {}, sourceId, reason);
          }
          const sourceRejectedCount = Object.values(batch.sourceRejectionCounts ?? sourceRejectionCountsFromWarnings(batch.warnings)).reduce((sum, count) => sum + (Number.isFinite(count) && count > 0 ? count : 0), 0);
          if (typeof checkpoint.rejectedCount === "number") checkpoint.rejectedCount += batchRejectionReasons.length + sourceRejectedCount;
          if (typeof checkpoint.verificationQueuedCount === "number") checkpoint.verificationQueuedCount += batchVerificationQueued;
          if (typeof checkpoint.districtQueuedCount === "number") checkpoint.districtQueuedCount += batchDistrictQueued;
          recordRadarSourceWarnings(checkpoint, sourceId, batch.warnings);
          addSourceRejectionCounts(checkpoint, sourceId, batch.sourceRejectionCounts ?? {});
          if (batch.diagnostics?.length) appendDetailDiagnostics(checkpoint, sourceId, batch.diagnostics);
          const previousCursorKey = cursorProgressKey(checkpoint.perSourceCursor[sourceId]);
          checkpoint.perSourceCursor[sourceId] = nextCursor === null ? SOURCE_DONE_CURSOR : nextCursor;
          recordBatchProgress(checkpoint, sourceId, batch.fetched, cursorProgressKey(checkpoint.perSourceCursor[sourceId]) !== previousCursorKey);
          for (const listing of batch.listings) checkedListingKeys.add(`${sourceId}:${listing.externalListingId}`);
          attemptMetrics.fetched += batch.fetched;
          attemptMetrics.qualified += batchQualified;
          attemptMetrics.batchMs += Date.now() - batchStartedAt;
          // Coalesced: counters, cursor and checked offers always travel in
          // the same checkpoint, so a crash replays at most a few seconds of
          // idempotent work and never double counts. Every attempt outcome
          // below still saves, and the fenced RPC renews the lease.
          if (nextCursor === null || Date.now() - lastCheckpointAt >= timing.checkpointIntervalMs) {
            if (await save("running", null, sourceId) === "stopped") {
              operatorStopDetected = true;
              throw new Error(RADAR_STOPPED_BY_OPERATOR);
            }
          }
        };
        // The underlying adapter must honor the passed AbortSignal. We also
        // refuse to persist any result after this portion's budget expires.
        const cursorValue = checkpoint.perSourceCursor[sourceId];
        const batches: SourceBatchContext = {
          ...(typeof cursorValue === "number" ? { cursor: cursorValue } : {}),
          ...(isRadarDetailCursor(cursorValue) ? { radarDetailCursor: cursorValue } : {}),
          purpose: "price_radar",
          ...(sourceId === "oferty_net" && !checkpoint.searchCriteria ? { ofertyNetLegacySearch: true } : {}),
          deadlineAt: portionYieldAt,
          sliceDeadlineAt,
          detailReserveMs: timing.detailReserveMs,
          onRequest: (kind, durationMs) => recordRequest(attemptMetrics, kind, durationMs),
          isDetailChecked: (key) => checkedListingKeys.has(key),
          pageCache: pageCaches.get(sourceId) ?? pageCaches.set(sourceId, new Map()).get(sourceId)!,
          contextValues: {
            get: (key) => {
              const entry = checkpoint.contextValues?.[key];
              return entry && Date.now() - Date.parse(entry.at) < CONTEXT_VALUE_TTL_MS ? entry.value : undefined;
            },
            set: (key, value) => { (checkpoint.contextValues ??= {})[key] = { value: value.slice(0, 200), at: new Date().toISOString() }; },
          },
          onBatch: processBatch,
        };
        const sourcePromise = source.fetch(syntheticCriteria(sourceId, checkpoint.searchCriteria), controller.signal, batches);
        const result = await Promise.race([sourcePromise, abortPromise(controller.signal)]);
        controller.signal.throwIfAborted();
        if (!emittedBatches) {
          await processBatch({ listings: result.listings, warnings: result.warnings, fetched: result.fetched, sourceRejectionCounts: result.sourceRejectionCounts ?? sourceRejectionCountsFromWarnings(result.warnings) }, null);
        }
        const completionWarnings = [...result.warnings, ...(checkpoint.sourceWarnings?.[sourceId] ?? [])];
        recordRadarSourceWarnings(checkpoint, sourceId, completionWarnings);
        checkpoint.sourceStatuses[sourceId] = radarSourceStatusFromWarnings(completionWarnings);
        if (checkpoint.progress?.sourceNoProgressAttempts) delete checkpoint.progress.sourceNoProgressAttempts[sourceId];
        checkpoint.perSourceCursor[sourceId] = SOURCE_DONE_CURSOR;
        await save("running");
      } catch (reason) {
        if (userTerminationDetected || isRadarTerminationError(reason) || await radarRunUserTerminated(supabase, input)) {
          userTerminationDetected = true;
          return "stop";
        }
        if (operatorStopDetected || isRadarStopError(reason) || await radarStopRequested(supabase, input)) {
          operatorStopDetected = true;
          checkpoint.sourceStatuses[sourceId] = "pending";
          // The stop RPC owns the persisted checkpoint when it finalizes an
          // expired/queued run. For a live worker, the fenced checkpoint RPC
          // accepts this terminal partial state only while stop_requested_at
          // is present. The source cursor remains the last committed cursor.
          await save("partial", RADAR_STOPPED_BY_OPERATOR).catch(() => undefined);
          return "stop";
        }
        if (reason instanceof SourceBatchYield || isRetryableTimeout(reason, controller.signal)) {
          const isYield = reason instanceof SourceBatchYield;
          const attemptLabel = isYield ? `yield:${reason.reason}` : "timeout";
          // A pending Retry-After is honoured (no request is sent until then)
          // and is never counted. Neither is an attempt the portion itself cut
          // short because it started late. Everything else that neither moved
          // the cursor nor increased the counters is a failed attempt.
          const retryAfterUntil = isYield && reason.reason === "detail_rate_limit" ? pendingRetryAfter(checkpoint.perSourceCursor[sourceId]) : null;
          const cutShortByPortion = isYield ? reason.reason === "portion_budget" : controller.signal.aborted;
          const progressed = attemptProgressed();
          const counts = !progressed && retryAfterUntil === null && (hadFairShare || !cutShortByPortion);
          const progress = checkpoint.progress ??= {};
          const attempts = progress.sourceNoProgressAttempts ??= {};
          if (progressed) delete attempts[sourceId];
          if (counts) {
            attempts[sourceId] = (attempts[sourceId] ?? 0) + 1;
            (progress.sourceLastAttemptError ??= {})[sourceId] = `${attemptLabel}: ${sourceError(reason)}`.slice(0, 300);
          }
          if ((attempts[sourceId] ?? 0) >= RADAR_SOURCE_NO_PROGRESS_LIMIT) {
            closeStalledSource(checkpoint, sourceId, attempts[sourceId]!, attemptLabel);
            await save("running");
            return "next";
          }
          checkpoint.sourceStatuses[sourceId] = "pending";
          if (!isYield) {
            // Nothing here enforces a daily wait: the next portion (server
            // continuation, scheduler or PWA) picks the same cursor back up.
            checkpoint.sourceErrors[sourceId] = "RADAR_PORTION_TIME_BUDGET_EXCEEDED: zostanie wznowione przy najbliższym uruchomieniu zbierania (ręcznym lub zaplanowanym), nie wymaga czekania do następnego dnia.";
          }
          // Behind the other unfinished portals for the next portion; a slice
          // that ended after real progress may be taken up again right away.
          deferSource(checkpoint, sourceId);
          if (isYield && reason.reason === "detail_batch_limit" && progressed && portionYieldAt - Date.now() >= timing.minSliceMs / 2) resumableThisPortion.push(sourceId);
          await save("running");
          return "next";
        }
        checkpoint.sourceStatuses[sourceId] = "failed";
        checkpoint.sourceErrors[sourceId] = sourceError(reason);
        if (checkpoint.progress?.sourceNoProgressAttempts) delete checkpoint.progress.sourceNoProgressAttempts[sourceId];
        if (isTerminalAccessError(reason)) checkpoint.sourceErrors[sourceId] = `TERMINAL_ACCESS_ERROR: ${checkpoint.sourceErrors[sourceId]}`;
        await save("running");
      }
      } finally {
        attemptMetrics.activeMs += Date.now() - attemptStartedAt;
      }
    return "next";
  };
  try {
    normalizeFinishedSources(checkpoint);
    await Promise.all(Array.from({ length: Math.max(1, timing.parallelSources) }, () => lane()));
    const unfinished = checkpoint.sourceStatuses.olx === "running" && checkpoint.sourceQueue.includes("olx")
      ? checkpoint.sourceQueue.indexOf("olx")
      : checkpoint.sourceQueue.findIndex((candidate) => !sourceFinished(checkpoint, candidate));
    checkpoint.currentSourceIndex = unfinished >= 0 ? unfinished : checkpoint.sourceQueue.length;
  } catch (reason) {
    if (isRadarTerminationError(reason) || await radarRunUserTerminated(supabase, input)) userTerminationDetected = true;
    else throw reason;
  } finally {
    clearTimeout(timeoutId);
    clearInterval(stopCheckId);
  }

  if (userTerminationDetected) {
    const latest = await supabase.from("price_radar_runs").select("*")
      .eq("id", input.runId).eq("owner_id", input.ownerId).maybeSingle();
    if (latest.data) return resultOf(toRadarRun(latest.data as Row));
    throw new Error("RADAR_RUN_NOT_FOUND");
  }

  if (operatorStopDetected) {
    for (const source of checkpoint.sourceQueue) if (source !== "olx" && checkpoint.sourceStatuses[source] === "running") checkpoint.sourceStatuses[source] = "pending";
    await save("partial", RADAR_STOPPED_BY_OPERATOR).catch(() => undefined);
    const latest = await supabase.from("price_radar_runs").select("scanned_count,qualified_count,checkpoint,source_statuses")
      .eq("id", input.runId).eq("owner_id", input.ownerId).maybeSingle();
    const savedCheckpoint = latest.data && isRecord(latest.data.checkpoint) ? latest.data.checkpoint as unknown as RadarCheckpoint : checkpoint;
    const savedStatuses = latest.data && isRecord(latest.data.source_statuses) ? latest.data.source_statuses as RadarRun["sourceStatuses"] : savedCheckpoint.sourceStatuses;
    return {
      status: "partial",
      scannedCount: typeof latest.data?.scanned_count === "number" ? latest.data.scanned_count : scanned,
      qualifiedCount: typeof latest.data?.qualified_count === "number" ? latest.data.qualified_count : qualified,
      sourceStatuses: savedStatuses,
      sourceErrors: savedCheckpoint.sourceErrors ?? {},
      sourceWarnings: savedCheckpoint.sourceWarnings ?? {},
      sourceRejectionCounts: savedCheckpoint.sourceRejectionCounts ?? {},
      qualificationRejections: savedCheckpoint.qualificationRejections ?? {},
    };
  }

  const waiting = recordPortionDiagnostics(checkpoint, (checkpoint.progress?.lastRealProgressAt ?? null) !== progressMarkerAtStart);
  finishPortionMetrics(checkpoint, metrics, started, httpAttemptedThisPortion);
  const done = checkpoint.sourceQueue.every((source) => checkpoint.sourceStatuses[source] === "completed" || checkpoint.sourceStatuses[source] === "failed" || checkpoint.sourceStatuses[source] === "partial");
  if (done) checkpoint.currentSourceIndex = checkpoint.sourceQueue.length;
  const failedSources = Object.values(checkpoint.sourceStatuses).filter((status) => status === "failed").length;
  const partialSources = Object.values(checkpoint.sourceStatuses).filter((status) => status === "partial").length;
  const finalStatus: RadarRunStatus = done
    ? failedSources === checkpoint.sourceQueue.length ? "failed"
      : failedSources > 0 || partialSources > 0 ? "partial"
        : "completed"
    : "running";
  const errorMessage = Object.entries(checkpoint.sourceErrors).map(([sourceId, message]) => `${sourceId}: ${message}`).join("\n").slice(0, 2000) || null;
  const finalSave = await save(finalStatus, errorMessage);
  if (finalSave === "stopped") {
    const latest = await supabase.from("price_radar_runs").select("scanned_count,qualified_count,checkpoint,source_statuses")
      .eq("id", input.runId).eq("owner_id", input.ownerId).maybeSingle();
    const savedCheckpoint = latest.data && isRecord(latest.data.checkpoint) ? latest.data.checkpoint as unknown as RadarCheckpoint : checkpoint;
    return {
      status: "partial",
      scannedCount: typeof latest.data?.scanned_count === "number" ? latest.data.scanned_count : scanned,
      qualifiedCount: typeof latest.data?.qualified_count === "number" ? latest.data.qualified_count : qualified,
      sourceStatuses: latest.data && isRecord(latest.data.source_statuses) ? latest.data.source_statuses as RadarRun["sourceStatuses"] : savedCheckpoint.sourceStatuses,
      sourceErrors: savedCheckpoint.sourceErrors ?? {},
      sourceWarnings: savedCheckpoint.sourceWarnings ?? {},
      sourceRejectionCounts: savedCheckpoint.sourceRejectionCounts ?? {},
      qualificationRejections: savedCheckpoint.qualificationRejections ?? {},
    };
  }
  return { status: finalStatus, scannedCount: scanned, qualifiedCount: qualified, sourceStatuses: checkpoint.sourceStatuses, sourceErrors: checkpoint.sourceErrors, sourceWarnings: checkpoint.sourceWarnings ?? {}, sourceRejectionCounts: checkpoint.sourceRejectionCounts ?? {}, qualificationRejections: checkpoint.qualificationRejections ?? {}, ...(finalStatus === "running" ? waiting : {}) };
}

async function saveCheckpoint(supabase: SupabaseClient, input: { runId: string; ownerId: string; leaseToken: string }, checkpoint: RadarCheckpoint, scanned: number, qualified: number, status: RadarRunStatus, errorMessage: string | null = null): Promise<"saved" | "stopped"> {
  checkpoint.lastProgressAt = new Date().toISOString();
  const params = {
    p_owner_id: input.ownerId, p_run_id: input.runId, p_lease_token: input.leaseToken,
    p_checkpoint: checkpoint, p_source_statuses: checkpoint.sourceStatuses,
    p_scanned_count: scanned, p_qualified_count: qualified, p_status: status,
    p_error_message: errorMessage, p_lease_seconds: LEASE_SECONDS,
  };
  const { data, error } = await supabase.rpc("checkpoint_price_radar_run", params);
  if (!error && data === true) return "saved";
  // A stop request races safely with the normal checkpoint RPC. The SQL
  // predicate rejects any new "running" checkpoint after the request; this
  // lease owner then commits one final partial checkpoint and releases itself.
  if (await radarStopRequested(supabase, input)) {
    const currentSource = checkpoint.sourceQueue[checkpoint.currentSourceIndex];
    if (currentSource && checkpoint.sourceStatuses[currentSource] === "running") checkpoint.sourceStatuses[currentSource] = "pending";
    const stopped = await supabase.rpc("checkpoint_price_radar_run", {
      ...params,
      p_checkpoint: checkpoint,
      p_source_statuses: checkpoint.sourceStatuses,
      p_status: "partial",
      p_error_message: RADAR_STOPPED_BY_OPERATOR,
    });
    if (!stopped.error && stopped.data === true) return "stopped";
  }
  if (await radarRunUserTerminated(supabase, input)) throw new Error(RADAR_TERMINATED_BY_USER);
  throw new Error("RADAR_LEASE_LOST");
}

export const RADAR_TERMINATED_BY_USER = "RADAR_TERMINATED_BY_USER";

async function radarRunUserTerminated(supabase: SupabaseClient, input: { runId: string; ownerId: string }): Promise<boolean> {
  const { data, error } = await supabase.from("price_radar_runs").select("user_terminated_at,error_message")
    .eq("id", input.runId).eq("owner_id", input.ownerId).maybeSingle();
  return !error && Boolean(data && (data.user_terminated_at || data.error_message === RADAR_TERMINATED_BY_USER));
}

async function radarStopRequested(supabase: SupabaseClient, input: { runId: string; ownerId: string }): Promise<boolean> {
  const { data, error } = await supabase.from("price_radar_runs").select("stop_requested_at,error_message,status")
    .eq("id", input.runId).eq("owner_id", input.ownerId).maybeSingle();
  return !error && Boolean(data && (data.stop_requested_at || data.error_message === RADAR_STOPPED_BY_OPERATOR || data.status === "partial" && data.error_message === RADAR_STOPPED_BY_OPERATOR));
}

function isRadarStopError(error: unknown): boolean {
  return error instanceof Error && (error.message === RADAR_STOPPED_BY_OPERATOR || error.message === "RADAR_RUN_STOP_REQUESTED");
}

function isRadarTerminationError(error: unknown): boolean {
  return error instanceof Error && error.message === RADAR_TERMINATED_BY_USER;
}

function resultOf(run: RadarRun): RadarPortionResult {
  return { status: run.status === "pending" ? "running" : run.status, scannedCount: run.scannedCount, qualifiedCount: run.qualifiedCount, sourceStatuses: run.sourceStatuses, sourceErrors: run.sourceErrors, sourceWarnings: run.sourceWarnings ?? run.checkpoint.sourceWarnings ?? {}, sourceRejectionCounts: run.sourceRejectionCounts ?? run.checkpoint.sourceRejectionCounts ?? {}, qualificationRejections: run.qualificationRejections ?? {} };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new DOMException("The operation was aborted", "AbortError"));
    else signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), { once: true });
  });
}

function isRadarDetailCursor(value: unknown): value is RadarDetailCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Partial<RadarDetailCursor>;
  if (cursor.kind !== "radar_detail_v1" || !Number.isInteger(cursor.page) || Number(cursor.page) <= 0 || !Number.isInteger(cursor.candidateIndex) || Number(cursor.candidateIndex) < 0) return false;
  if (cursor.retryAttempt !== undefined && cursor.retryAttempt !== 1) return false;
  if (cursor.retryAfterUntil !== undefined && (cursor.retryAttempt !== 1 || typeof cursor.retryAfterUntil !== "string" || !Number.isFinite(Date.parse(cursor.retryAfterUntil)))) return false;
  return true;
}

function appendDetailDiagnostics(checkpoint: RadarCheckpoint, sourceId: string, diagnostics: RadarDetailDiagnostic[]): void {
  checkpoint.detailDiagnostics ??= {};
  const examples = checkpoint.detailDiagnostics[sourceId] ?? [];
  const seen = new Set(examples.map((item) => `${item.kind}|${item.listingUrl ?? ""}|${item.httpStatus ?? ""}|${item.errorCode ?? ""}`));
  for (const diagnostic of diagnostics) {
    if (examples.length >= DETAIL_DIAGNOSTIC_SAMPLE_LIMIT) break;
    const safe: RadarDetailDiagnostic = {
      kind: diagnostic.kind,
      listingUrl: safeDiagnosticUrl(diagnostic.listingUrl),
      finalUrl: safeDiagnosticUrl(diagnostic.finalUrl),
      httpStatus: Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus! >= 100 && diagnostic.httpStatus! <= 599 ? diagnostic.httpStatus : null,
      identity: ["same_url", "same_listing_id", "mismatch", "unconfirmed", "not_checked"].includes(diagnostic.identity) ? diagnostic.identity : "unconfirmed",
      unconfirmedFields: [...new Set(diagnostic.unconfirmedFields.filter((field) => DETAIL_DIAGNOSTIC_FIELDS.has(field)))].slice(0, DETAIL_DIAGNOSTIC_FIELDS.size),
      contradictoryFields: [...new Set(diagnostic.contradictoryFields.filter((field) => DETAIL_DIAGNOSTIC_FIELDS.has(field)))].slice(0, DETAIL_DIAGNOSTIC_FIELDS.size),
      ...(diagnostic.errorCode && ["INVALID_DETAIL_URL", "NETWORK_ERROR", "TIMEOUT", "HTTP_ERROR", "RATE_LIMITED", "ACCESS_CHALLENGE", "NOT_FOUND", "GONE"].includes(diagnostic.errorCode) ? { errorCode: diagnostic.errorCode } : {}),
    };
    const key = `${safe.kind}|${safe.listingUrl ?? ""}|${safe.httpStatus ?? ""}|${safe.errorCode ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    examples.push(safe);
  }
  checkpoint.detailDiagnostics[sourceId] = examples.slice(0, DETAIL_DIAGNOSTIC_SAMPLE_LIMIT);
}

function safeDiagnosticUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname
      .replace(/[\w.+-]+@[\w.-]+\.[A-Z]{2,}/giu, "[redacted]")
      .replace(/\+?\d[\d ().-]{7,}\d/gu, (candidate, offset: number, path: string) => {
        // Oferty.net's public IDs follow a two-letter route suffix (for
        // example `-fb,`, `-ba,`, or `-fa,`) in SEO routes, or use canonical
        // `/of,<id>`. They look like phone numbers to the contact scrubber.
        const publicOfferId = (/^\/mieszkanie[^/]*-[a-z]{2},$/u.test(path.slice(0, offset))
          || /^\/of,$/u.test(path.slice(0, offset))) && /^\d{6,}$/u.test(candidate)
          && /(?:\/|$)/u.test(path.slice(offset + candidate.length));
        const publicDomiportaId = /^\/nieruchomosci\/sprzedam-mieszkanie-[^/]+\/$/u.test(path.slice(0, offset))
          && /^\d{9}$/u.test(candidate) && /^(?:\/|$)/u.test(path.slice(offset + candidate.length));
        return ((url.hostname === "oferty.net" || url.hostname === "www.oferty.net") && publicOfferId)
          || ((url.hostname === "domiporta.pl" || url.hostname === "www.domiporta.pl") && publicDomiportaId)
          ? candidate : "[redacted]";
      });
    return `${url.origin}${url.pathname}`.slice(0, 1_024);
  } catch {
    return null;
  }
}

async function radarRunControl(supabase: SupabaseClient, input: { runId: string; ownerId: string }): Promise<{ terminated: boolean; stopRequested: boolean }> {
  const { data, error } = await supabase.from("price_radar_runs").select("user_terminated_at,stop_requested_at,error_message,status")
    .eq("id", input.runId).eq("owner_id", input.ownerId).maybeSingle();
  if (error || !data) return { terminated: false, stopRequested: false };
  const terminated = Boolean(data.user_terminated_at || data.error_message === RADAR_TERMINATED_BY_USER);
  return { terminated, stopRequested: !terminated && Boolean(data.stop_requested_at || data.error_message === RADAR_STOPPED_BY_OPERATOR) };
}

const TERMINAL_SOURCE_STATUSES = new Set(["completed", "failed", "partial"]);
function sourceFinished(checkpoint: RadarCheckpoint, source: string): boolean {
  return TERMINAL_SOURCE_STATUSES.has(checkpoint.sourceStatuses[source] ?? "") || checkpoint.perSourceCursor[source] === SOURCE_DONE_CURSOR;
}

/** A finished cursor and a terminal status always agree before lanes start. */
function normalizeFinishedSources(checkpoint: RadarCheckpoint): void {
  for (const source of checkpoint.sourceQueue) {
    if (checkpoint.perSourceCursor[source] === SOURCE_DONE_CURSOR && !TERMINAL_SOURCE_STATUSES.has(checkpoint.sourceStatuses[source] ?? "")) {
      const savedError = checkpoint.sourceErrors[source];
      checkpoint.sourceStatuses[source] = savedError ? radarSourceStatusFromWarnings([savedError]) : "completed";
    } else if (TERMINAL_SOURCE_STATUSES.has(checkpoint.sourceStatuses[source] ?? "")) {
      checkpoint.perSourceCursor[source] = SOURCE_DONE_CURSOR;
    }
  }
}

/** Moves a yielded portal behind the other unfinished ones; OLX stays last. */
function deferSource(checkpoint: RadarCheckpoint, sourceId: RadarSource): void {
  const rest = checkpoint.sourceQueue.filter((candidate) => candidate !== sourceId);
  const olxIndex = rest.indexOf("olx");
  const olxLast = olxIndex >= 0 && olxIndex === rest.length - 1 && !sourceFinished(checkpoint, "olx");
  checkpoint.sourceQueue = olxLast ? [...rest.slice(0, olxIndex), sourceId, "olx"] : [...rest, sourceId];
}

function unattemptedHttpSources(checkpoint: RadarCheckpoint, attempted: ReadonlySet<RadarSource>): number {
  return checkpoint.sourceQueue.filter((source) => source !== "olx" && !attempted.has(source) && !sourceFinished(checkpoint, source)).length;
}

function startPortionMetrics(checkpoint: RadarCheckpoint, startedAt: number): RadarRunMetrics {
  const progress = checkpoint.progress ??= {};
  const metrics = progress.metrics ??= { portions: 0, httpActiveMs: 0, handOffs: 0, handOffGapMs: 0, sources: {} };
  metrics.sources ??= {};
  // Idle time between two portions (release, hand-off, cold start, claim).
  const previousEnd = progress.lastPortionAt ? Date.parse(progress.lastPortionAt) : Number.NaN;
  if (Number.isFinite(previousEnd) && startedAt >= previousEnd) {
    metrics.handOffs += 1;
    metrics.handOffGapMs += startedAt - previousEnd;
  }
  metrics.httpStartedAt ??= new Date(startedAt).toISOString();
  return metrics;
}

function sourceMetrics(metrics: RadarRunMetrics, sourceId: string): RadarSourceMetrics {
  return metrics.sources[sourceId] ??= { attempts: 0, activeMs: 0, batchMs: 0, listRequests: 0, listMs: 0, detailRequests: 0, detailMs: 0, contextRequests: 0, contextMs: 0, dbMs: 0, qualifyMs: 0, checkpointMs: 0, fetched: 0, qualified: 0 };
}

function recordRequest(metrics: RadarSourceMetrics, kind: "list" | "detail" | "context", durationMs: number): void {
  const ms = Math.max(0, durationMs);
  if (kind === "detail") { metrics.detailRequests += 1; metrics.detailMs += ms; }
  else if (kind === "context") { metrics.contextRequests += 1; metrics.contextMs += ms; }
  else { metrics.listRequests += 1; metrics.listMs += ms; }
}

function finishPortionMetrics(checkpoint: RadarCheckpoint, metrics: RadarRunMetrics, startedAt: number, httpAttempted: boolean): void {
  metrics.portions += 1;
  if (httpAttempted) metrics.httpActiveMs += Date.now() - startedAt;
  const httpLeft = checkpoint.sourceQueue.some((source) => source !== "olx" && !sourceFinished(checkpoint, source));
  if (!httpLeft) metrics.httpFinishedAt ??= new Date().toISOString();
}

/** Ends every unfinished HTTP portal once the run's active HTTP time is used up. */
function closeHttpSourcesPastTimeLimit(checkpoint: RadarCheckpoint, metrics: RadarRunMetrics, elapsedThisPortionMs: number, limitMs: number, inUse: ReadonlySet<RadarSource> = new Set()): boolean {
  if (metrics.httpActiveMs + elapsedThisPortionMs < limitMs) return false;
  const open = checkpoint.sourceQueue.filter((source) => source !== "olx" && !inUse.has(source) && !sourceFinished(checkpoint, source));
  if (!open.length) return false;
  const minutes = Math.round(limitMs / 60_000);
  for (const source of open) {
    const hadProgress = Boolean(checkpoint.progress?.sourceHadProgress?.[source]) || !isInitialCursor(checkpoint.perSourceCursor[source]);
    checkpoint.sourceStatuses[source] = hadProgress ? "partial" : "failed";
    checkpoint.sourceErrors[source] = `${RADAR_HTTP_TIME_LIMIT_ERROR}: przekroczono limit ${minutes} min aktywnej pracy portali HTTP w tym przebiegu; zapisane wyniki zachowano.`;
    checkpoint.perSourceCursor[source] = SOURCE_DONE_CURSOR;
  }
  if (!inUse.size) metrics.httpFinishedAt ??= new Date().toISOString();
  return true;
}

/** Retry metadata is not progress: a 429 retry keeps the same page and candidate. */
function cursorProgressKey(value: unknown): string {
  if (isRecord(value)) {
    const position = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "retryAfterUntil" && key !== "retryAttempt"));
    return JSON.stringify(position);
  }
  return JSON.stringify(value ?? null);
}

function pendingRetryAfter(cursor: unknown, now = Date.now()): string | null {
  if (!isRecord(cursor) || typeof cursor.retryAfterUntil !== "string") return null;
  const until = Date.parse(cursor.retryAfterUntil);
  return Number.isFinite(until) && until > now ? new Date(until).toISOString() : null;
}

function isInitialCursor(cursor: unknown): boolean {
  if (cursor === undefined || cursor === null || cursor === 1) return true;
  return isRecord(cursor) && cursor.page === 1 && cursor.candidateIndex === 0;
}

function recordBatchProgress(checkpoint: RadarCheckpoint, sourceId: string, fetched: number, cursorChanged: boolean): void {
  if (fetched <= 0 && !cursorChanged) return;
  const now = new Date().toISOString();
  const progress = checkpoint.progress ??= {};
  if (fetched > 0) progress.lastCounterIncreaseAt = now;
  if (cursorChanged) progress.lastCursorChangeAt = now;
  progress.lastRealProgressAt = now;
  progress.lastProgressSource = sourceId;
  (progress.sourceHadProgress ??= {})[sourceId] = true;
}

/** Ends one source for this run only; its committed rows and counters stay. */
function closeStalledSource(checkpoint: RadarCheckpoint, sourceId: string, attempts: number, lastAttempt: string): void {
  const hadProgress = Boolean(checkpoint.progress?.sourceHadProgress?.[sourceId]) || !isInitialCursor(checkpoint.perSourceCursor[sourceId]);
  checkpoint.sourceStatuses[sourceId] = hadProgress ? "partial" : "failed";
  checkpoint.sourceErrors[sourceId] = `${RADAR_SOURCE_NO_PROGRESS_ERROR}: ${attempts} kolejne próby bez postępu (ostatnio ${lastAttempt}); zapisane wyniki zachowano, pozostałe portale są kontynuowane.`;
  checkpoint.perSourceCursor[sourceId] = SOURCE_DONE_CURSOR;
  if (checkpoint.progress?.sourceNoProgressAttempts) delete checkpoint.progress.sourceNoProgressAttempts[sourceId];
}

/** Portion-level diagnostics; a checkpoint write alone never counts as progress. */
function recordPortionDiagnostics(checkpoint: RadarCheckpoint, portionProgressed: boolean): { waitingReason: RadarWaitingReason | null; waitingUntil: string | null } {
  const progress = checkpoint.progress ??= {};
  progress.noProgressPortions = portionProgressed ? 0 : (progress.noProgressPortions ?? 0) + 1;
  progress.lastPortionAt = new Date().toISOString();
  const terminal = (source: string) => ["completed", "failed", "partial"].includes(checkpoint.sourceStatuses[source] ?? "") || checkpoint.perSourceCursor[source] === SOURCE_DONE_CURSOR;
  const unfinished = checkpoint.sourceQueue.filter((source) => !terminal(source));
  const http = unfinished.filter((source) => source !== "olx");
  let waitingReason: RadarWaitingReason | null = null;
  let waitingUntil: string | null = null;
  if (!unfinished.length) waitingReason = null;
  else if (!http.length) waitingReason = checkpoint.sourceStatuses.olx === "running" ? "olx_worker" : "next_portion";
  else {
    const retries = http.map((source) => pendingRetryAfter(checkpoint.perSourceCursor[source]));
    if (retries.every((value): value is string => value !== null)) {
      waitingReason = "retry_after";
      waitingUntil = retries.reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest);
    } else waitingReason = "next_portion";
  }
  progress.waitingReason = waitingReason;
  progress.waitingUntil = waitingUntil;
  return { waitingReason, waitingUntil };
}

function nextUnfinishedSourceIndex(checkpoint: RadarCheckpoint, startIndex: number, attempted: ReadonlySet<RadarSource> = new Set()): number | null {
  const queue = checkpoint.sourceQueue;
  if (!queue.length) return null;
  const start = ((startIndex % queue.length) + queue.length) % queue.length;
  for (let offset = 0; offset < queue.length; offset += 1) {
    const index = (start + offset) % queue.length;
    const source = queue[index];
    if (!source || attempted.has(source)) continue;
    const status = checkpoint.sourceStatuses[source];
    if (status === "completed" || status === "failed" || status === "partial" || checkpoint.perSourceCursor[source] === SOURCE_DONE_CURSOR) continue;
    return index;
  }
  return null;
}
