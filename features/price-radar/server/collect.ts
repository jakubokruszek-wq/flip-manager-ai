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
import type { RadarCheckpoint, RadarRun, RadarRunStatus, RadarSearchCriteria, RadarSource } from "@/features/price-radar/types";
import type { SearchFilter } from "@/features/flip-finder";
import { classifyRadarSourceWarning, radarSourceStatusFromWarnings, sourceRejectionCountsFromWarnings } from "@/features/price-radar/source-diagnostics";

type Row = Record<string, unknown>;
const PORTION_BUDGET_MS = 42_000;
// The portion hard-aborts at 42s; 75s leaves 33s for checkpointing and avoids
// making the browser wait a full two minutes before its next CAS continuation.
const LEASE_SECONDS = 75;
const YIELD_MARGIN_MS = 8_000;
const SOURCE_DONE_CURSOR = "__RADAR_SOURCE_DONE__";
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
    return { kind: "blocked", reason: "olx_queue_owns_source" };
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

export type RadarPortionResult = { status: "running" | "completed" | "failed" | "partial"; scannedCount: number; qualifiedCount: number; sourceStatuses: RadarRun["sourceStatuses"]; sourceErrors: Record<string, string>; sourceWarnings?: RadarRun["sourceWarnings"]; sourceRejectionCounts?: RadarRun["sourceRejectionCounts"]; qualificationRejections: NonNullable<RadarRun["qualificationRejections"]> };

/**
 * Runs one time-boxed source portion. Every listing write and every checkpoint
 * is lease-fenced in SQL. A timeout keeps the current source pending and moves
 * it behind other unfinished sources, so a repeatedly slow portal cannot starve
 * the rest of this run. A permanent source error is terminal for this run.
 */
export async function runRadarCollectionPortion(input: { runId: string; ownerId: string; leaseToken: string }, supabase: SupabaseClient = createAdminClient()): Promise<RadarPortionResult> {
  const started = Date.now();
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
  const timeoutId = setTimeout(() => controller.abort(), PORTION_BUDGET_MS);
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
  // One shared cap on AI district-suggestion calls for this whole portion
  // (not per candidate) -- bounds cost/latency the same way the portion's
  // own time budget already bounds a single invocation's work.
  const districtAiBudget = createRadarDistrictAiBudget();
  try {
    while (checkpoint.sourceQueue.length > 0) {
      if (Date.now() - started >= PORTION_BUDGET_MS - YIELD_MARGIN_MS) break;
      if (userTerminationDetected) break;
      if (operatorStopDetected) break;
      const currentSourceId = checkpoint.sourceQueue[checkpoint.currentSourceIndex];
      if (!currentSourceId || attemptedSourceIds.has(currentSourceId)) {
        const nextIndex = nextUnfinishedSourceIndex(checkpoint, currentSourceId ? checkpoint.currentSourceIndex + 1 : 0, attemptedSourceIds);
        if (nextIndex === null) {
          checkpoint.currentSourceIndex = checkpoint.sourceQueue.length;
          break;
        }
        checkpoint.currentSourceIndex = nextIndex;
      }
      const sourceId = checkpoint.sourceQueue[checkpoint.currentSourceIndex]!;
      if (await radarRunUserTerminated(supabase, input)) {
        userTerminationDetected = true;
        break;
      }
      if (await radarStopRequested(supabase, input)) {
        operatorStopDetected = true;
        if (checkpoint.sourceStatuses[sourceId] === "running") checkpoint.sourceStatuses[sourceId] = "pending";
        await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "partial", RADAR_STOPPED_BY_OPERATOR).catch(() => undefined);
        break;
      }
      if (checkpoint.perSourceCursor[sourceId] === SOURCE_DONE_CURSOR) {
        if (!["completed", "failed", "partial"].includes(checkpoint.sourceStatuses[sourceId] ?? "")) {
          const savedError = checkpoint.sourceErrors[sourceId];
          checkpoint.sourceStatuses[sourceId] = savedError
            ? radarSourceStatusFromWarnings([savedError])
            : "completed";
        }
        checkpoint.currentSourceIndex += 1;
        await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
        continue;
      }
      if (checkpoint.sourceStatuses[sourceId] === "completed" || checkpoint.sourceStatuses[sourceId] === "failed" || checkpoint.sourceStatuses[sourceId] === "partial") {
        checkpoint.perSourceCursor[sourceId] = SOURCE_DONE_CURSOR;
        checkpoint.currentSourceIndex += 1;
        await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
        continue;
      }
      // OLX is owned by its separate durable worker queue. Defer a pending
      // OLX reservation until every other unfinished portal has had a turn;
      // otherwise a queued-but-unclaimed OLX job would stop this run before
      // later portals could be collected. Legacy checkpoints are rotated in
      // place, preserving their IDs, cursors and all completed source rows.
      if (sourceId === "olx" && checkpoint.sourceStatuses.olx !== "running"
        && checkpoint.sourceQueue.some((candidate) => candidate !== "olx"
          && !["completed", "failed", "partial"].includes(checkpoint.sourceStatuses[candidate] ?? ""))) {
        const currentIndex = checkpoint.currentSourceIndex;
        const [deferredSource] = checkpoint.sourceQueue.splice(currentIndex, 1);
        if (deferredSource) checkpoint.sourceQueue.push(deferredSource);
        const nextIndex = nextUnfinishedSourceIndex(checkpoint, currentIndex, attemptedSourceIds);
        if (nextIndex === null) {
          checkpoint.currentSourceIndex = checkpoint.sourceQueue.length;
          await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
          break;
        }
        checkpoint.currentSourceIndex = nextIndex;
        await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
        continue;
      }
      attemptedSourceIds.add(sourceId);
      const source = activeSources(syntheticCriteria(sourceId, checkpoint.searchCriteria)).find((candidate) => candidate.id === sourceId);
      if (!source) {
        // A run claimed before a source was turned off can still carry it in
        // its own saved sourceQueue (e.g. "szybko"). Resuming that old
        // checkpoint must skip the stage through this exact same no-fetch
        // path -- never retrying it, never blocking the rest of the queue --
        // with an honest, specific reason distinct from "never registered".
        checkpoint.sourceStatuses[sourceId] = "failed";
        checkpoint.sourceErrors[sourceId] = isDisabledSource(sourceId) ? "Źródło wyłączone." : "SOURCE_NOT_ACTIVE_OR_REGISTERED";
        checkpoint.currentSourceIndex += 1;
        await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
        continue;
      }

      checkpoint.sourceStatuses[sourceId] = "running";
      if (!isRadarDetailCursor(checkpoint.perSourceCursor[sourceId]) || checkpoint.sourceErrors[sourceId]?.startsWith("RADAR_PORTION_TIME_BUDGET_EXCEEDED:")) delete checkpoint.sourceErrors[sourceId];
      await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
      try {
        if (await radarStopRequested(supabase, input)) {
          operatorStopDetected = true;
          checkpoint.sourceStatuses[sourceId] = "pending";
          await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "partial", RADAR_STOPPED_BY_OPERATOR);
          break;
        }
        if (sourceId === "olx") {
          await enqueueRadarOlxJob({ ownerId: input.ownerId, runId: input.runId, leaseToken: input.leaseToken, city: "Łódź" }, supabase);
          checkpoint.sourceStatuses.olx = "running";
          await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
          break;
        }
        let emittedBatches = false;
      const processBatch = async (batch: SourceBatch, nextCursor: SourceBatchCursor) => {
          if (userTerminationDetected || await radarRunUserTerminated(supabase, input)) {
            userTerminationDetected = true;
            throw new Error(RADAR_TERMINATED_BY_USER);
          }
          if (operatorStopDetected || await radarStopRequested(supabase, input)) {
            operatorStopDetected = true;
            throw new Error(RADAR_STOPPED_BY_OPERATOR);
          }
          if (Date.now() - started >= PORTION_BUDGET_MS - YIELD_MARGIN_MS) {
            controller.abort();
            throw new Error("RADAR_PORTION_BUDGET_YIELD");
          }
          emittedBatches = true;
          const batchRejectionReasons = [...(batch.rejectionReasons ?? [])];
          let batchQualified = 0;
          let batchVerificationQueued = 0;
          let batchDistrictQueued = 0;
          const batchExternalIds = batch.listings.map((listing) => listing.externalListingId);
          const [verificationDecisions, rejectedVerificationIds, rejectedDistrictIds, activeAnalysisIds] = await Promise.all([
            confirmedRadarVerificationDecisions(supabase, input.ownerId, sourceId, batchExternalIds),
            rejectedRadarVerificationExternalIds(supabase, input.ownerId, sourceId, batchExternalIds),
            rejectedRadarDistrictQueueExternalIds(supabase, input.ownerId, sourceId, batchExternalIds),
            activeRadarListingExternalIds(supabase, input.ownerId, sourceId, batchExternalIds),
          ]);
          for (const sourceListing of batch.listings) {
            const manualDecision = verificationDecisions.get(sourceListing.externalListingId);
            const listing = manualDecision ? applyRadarVerificationDecision(sourceListing, manualDecision) : sourceListing;
            controller.signal.throwIfAborted();
            if (await radarRunUserTerminated(supabase, input)) {
              userTerminationDetected = true;
              throw new Error(RADAR_TERMINATED_BY_USER);
            }
            const qualificationCandidate = {
              source: listing.source, externalListingId: listing.externalListingId, originalUrl: listing.originalUrl, normalizedUrl: listing.normalizedUrl,
              title: listing.title, description: listing.description, price: listing.price, area: listing.area, pricePerSqm: listing.pricePerSqm,
              rooms: listing.rooms, city: listing.city, district: listing.district, buildingType: listing.buildingType,
              marketType: typeof listing.rawPayload.marketType === "string" ? listing.rawPayload.marketType : null,
              propertyType: typeof listing.rawPayload.propertyType === "string" ? listing.rawPayload.propertyType : null,
              rawPayload: listing.rawPayload, contentHash: listing.contentHash,
            };
            const outcome = qualifyRadarCandidate(qualificationCandidate, checkpoint.searchCriteria?.qualityRulesVersion ?? 1, manualDecision, checkpoint.searchCriteria?.minPricePerSqm, checkpoint.searchCriteria?.districts, checkpoint.searchCriteria?.areaMin, checkpoint.searchCriteria?.areaMax);
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
          }
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
          checkpoint.perSourceCursor[sourceId] = nextCursor === null ? SOURCE_DONE_CURSOR : nextCursor;
          if (await radarStopRequested(supabase, input)) {
            operatorStopDetected = true;
            checkpoint.sourceStatuses[sourceId] = "pending";
            await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "partial", RADAR_STOPPED_BY_OPERATOR);
            throw new Error(RADAR_STOPPED_BY_OPERATOR);
          }
          await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
        };
        // The underlying adapter must honor the passed AbortSignal. We also
        // refuse to persist any result after this portion's budget expires.
        const cursorValue = checkpoint.perSourceCursor[sourceId];
        const batches: SourceBatchContext = {
          ...(typeof cursorValue === "number" ? { cursor: cursorValue } : {}),
          ...(isRadarDetailCursor(cursorValue) ? { radarDetailCursor: cursorValue } : {}),
          purpose: "price_radar",
          ...(sourceId === "oferty_net" && !checkpoint.searchCriteria ? { ofertyNetLegacySearch: true } : {}),
          deadlineAt: started + PORTION_BUDGET_MS - YIELD_MARGIN_MS,
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
        checkpoint.perSourceCursor[sourceId] = SOURCE_DONE_CURSOR;
        checkpoint.currentSourceIndex += 1;
        await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
      } catch (reason) {
        if (userTerminationDetected || isRadarTerminationError(reason) || await radarRunUserTerminated(supabase, input)) {
          userTerminationDetected = true;
          break;
        }
        if (operatorStopDetected || isRadarStopError(reason) || await radarStopRequested(supabase, input)) {
          operatorStopDetected = true;
          checkpoint.sourceStatuses[sourceId] = "pending";
          // The stop RPC owns the persisted checkpoint when it finalizes an
          // expired/queued run. For a live worker, the fenced checkpoint RPC
          // accepts this terminal partial state only while stop_requested_at
          // is present. The source cursor remains the last committed cursor.
          await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "partial", RADAR_STOPPED_BY_OPERATOR).catch(() => undefined);
          break;
        }
        if (reason instanceof SourceBatchYield) {
          checkpoint.sourceStatuses[sourceId] = "pending";
          const currentIndex = checkpoint.currentSourceIndex;
          if (currentIndex < checkpoint.sourceQueue.length - 1) {
            const [deferredSource] = checkpoint.sourceQueue.splice(currentIndex, 1);
            if (deferredSource) checkpoint.sourceQueue.push(deferredSource);
          }
          const nextIndex = nextUnfinishedSourceIndex(checkpoint, checkpoint.currentSourceIndex, attemptedSourceIds);
          if (nextIndex === null) {
            checkpoint.currentSourceIndex = checkpoint.sourceQueue.length;
            await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
            break;
          }
          checkpoint.currentSourceIndex = nextIndex;
          await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
          continue;
        }
        if (isRetryableTimeout(reason, controller.signal)) {
          checkpoint.sourceStatuses[sourceId] = "pending";
          // Confirmed by the owning run's own history (93a7f1d5...): this
          // source resumed and reached a real terminal result within the
          // same operator session, not after a calendar day. Nothing here
          // enforces a daily wait -- it only means this portion's own time
          // budget ran out mid-fetch; the next invocation of this function
          // (manual click or, once scheduled, the next cron tick) picks the
          // same source back up via its retained cursor. The previous label
          // claimed a specific "daily window" that does not exist in code.
          checkpoint.sourceErrors[sourceId] = "RADAR_PORTION_TIME_BUDGET_EXCEEDED: zostanie wznowione przy najbliższym uruchomieniu zbierania (ręcznym lub zaplanowanym), nie wymaga czekania do następnego dnia.";
          const currentIndex = checkpoint.currentSourceIndex;
          if (currentIndex < checkpoint.sourceQueue.length - 1) {
            const [deferredSource] = checkpoint.sourceQueue.splice(currentIndex, 1);
            if (deferredSource) checkpoint.sourceQueue.push(deferredSource);
          }
          const nextIndex = nextUnfinishedSourceIndex(checkpoint, checkpoint.currentSourceIndex, attemptedSourceIds);
          if (nextIndex === null) {
            checkpoint.currentSourceIndex = checkpoint.sourceQueue.length;
            await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
            break;
          }
          checkpoint.currentSourceIndex = nextIndex;
          await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
          continue;
        }
        checkpoint.sourceStatuses[sourceId] = "failed";
        checkpoint.sourceErrors[sourceId] = sourceError(reason);
        checkpoint.currentSourceIndex += 1;
        if (isTerminalAccessError(reason)) checkpoint.sourceErrors[sourceId] = `TERMINAL_ACCESS_ERROR: ${checkpoint.sourceErrors[sourceId]}`;
        await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
      }
    }
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
    const currentSource = checkpoint.sourceQueue[checkpoint.currentSourceIndex];
    if (currentSource && checkpoint.sourceStatuses[currentSource] === "running") checkpoint.sourceStatuses[currentSource] = "pending";
    await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "partial", RADAR_STOPPED_BY_OPERATOR).catch(() => undefined);
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
  const finalSave = await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, finalStatus, errorMessage);
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
  return { status: finalStatus, scannedCount: scanned, qualifiedCount: qualified, sourceStatuses: checkpoint.sourceStatuses, sourceErrors: checkpoint.sourceErrors, sourceWarnings: checkpoint.sourceWarnings ?? {}, sourceRejectionCounts: checkpoint.sourceRejectionCounts ?? {}, qualificationRejections: checkpoint.qualificationRejections ?? {} };
}

async function saveCheckpoint(supabase: SupabaseClient, input: { runId: string; ownerId: string; leaseToken: string }, checkpoint: RadarCheckpoint, scanned: number, qualified: number, status: RadarRunStatus, errorMessage: string | null = null): Promise<"saved" | "stopped"> {
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
