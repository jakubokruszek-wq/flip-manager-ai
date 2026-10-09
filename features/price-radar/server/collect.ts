import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { activeSources } from "@/features/flip-finder/server/search-source-registry";
import { SCHEMA_READY_SOURCE_IDS } from "@/features/flip-finder/source-availability";
import { qualifyRadarCandidate } from "@/features/price-radar/qualification";
import { persistRadarListing } from "@/features/price-radar/server/persist-radar-listing";
import { enqueueRadarOlxJob } from "@/features/price-radar/server/radar-olx-queue";
import type { SourceBatch } from "@/features/flip-finder/source-batches";
import type { RadarCheckpoint, RadarRun, RadarRunStatus, RadarSource } from "@/features/price-radar/types";
import type { SearchFilter } from "@/features/flip-finder";

type Row = Record<string, unknown>;
const PORTION_BUDGET_MS = 42_000;
const LEASE_SECONDS = 120;
const YIELD_MARGIN_MS = 8_000;
const SOURCE_DONE_CURSOR = "__RADAR_SOURCE_DONE__";

/** Radar may only use sources that are both in the shared schema gate and have a registered adapter. */
export const RADAR_SOURCES: RadarSource[] = SCHEMA_READY_SOURCE_IDS.filter((id): id is RadarSource => {
  if (["facebook", "bezposrednio", "official_auction"].includes(id)) return false;
  const filter = syntheticCriteria(id as RadarSource);
  return activeSources(filter).some((source) => source.id === id);
});

function syntheticCriteria(sourceId: RadarSource): SearchFilter {
  return {
    id: "price-radar-collection", name: "Radar cen po remoncie", sources: [sourceId], city: "Łódź", districts: [],
    priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
    excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
    privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
    minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 1440, isActive: true,
    lastScannedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

function defaultCheckpoint(sources: RadarSource[]): RadarCheckpoint {
  return {
    sourceQueue: sources,
    currentSourceIndex: 0,
    perSourceCursor: {},
    sourceStatuses: Object.fromEntries(sources.map((source) => [source, "pending"])),
    sourceErrors: {},
    buffer: [],
    bufferOffset: 0,
  };
}

function toRadarRun(row: Row): RadarRun {
  const raw = row.checkpoint;
  const checkpoint = isRecord(raw) && Array.isArray(raw.sourceQueue)
    ? raw as unknown as RadarCheckpoint
    : defaultCheckpoint(RADAR_SOURCES);
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    leaseToken: typeof row.lease_token === "string" ? row.lease_token : null,
    leaseUntil: typeof row.lease_until === "string" ? row.lease_until : null,
    status: isRunStatus(row.status) ? row.status : "pending",
    startedAt: String(row.started_at),
    finishedAt: typeof row.finished_at === "string" ? row.finished_at : null,
    checkpoint,
    scannedCount: typeof row.scanned_count === "number" ? row.scanned_count : 0,
    qualifiedCount: typeof row.qualified_count === "number" ? row.qualified_count : 0,
    errorMessage: typeof row.error_message === "string" ? row.error_message : null,
    sourceStatuses: isRecord(row.source_statuses) ? row.source_statuses as RadarRun["sourceStatuses"] : checkpoint.sourceStatuses,
    sourceErrors: checkpoint.sourceErrors ?? {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isRunStatus(value: unknown): value is RadarRunStatus { return value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "partial"; }
function rpcRow(value: unknown): Row | null { return Array.isArray(value) ? isRecord(value[0]) ? value[0] : null : isRecord(value) ? value : null; }
function sourceError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]/g, " ").slice(0, 500); }
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

/** The DB RPC serializes claims by owner and returns a fenced lease token. */
export async function claimOrCreateRadarRun(ownerId: string, selectedSources: readonly RadarSource[] = RADAR_SOURCES, supabase: SupabaseClient = createAdminClient()): Promise<RadarClaimResult> {
  const allowed = new Set(RADAR_SOURCES);
  const sourceQueue = selectedSources.length ? selectedSources.filter((source) => allowed.has(source)) : [...RADAR_SOURCES];
  const initialCheckpoint = defaultCheckpoint(sourceQueue);
  const { data, error } = await supabase.rpc("claim_price_radar_run", {
    p_owner_id: ownerId,
    p_initial_checkpoint: initialCheckpoint,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("RADAR_RUN_CLAIM_FAILED");
  const row = rpcRow(data);
  return row ? { kind: "claimed", run: toRadarRun({ ...row, id: row.run_id, owner_id: ownerId, lease_token: row.lease_token }) } : { kind: "blocked" };
}

export type RadarPortionResult = { status: "running" | "completed" | "failed" | "partial"; scannedCount: number; qualifiedCount: number; sourceStatuses: RadarRun["sourceStatuses"]; sourceErrors: Record<string, string> };

/**
 * Runs one time-boxed source portion. Every listing write and every checkpoint
 * is lease-fenced in SQL. A timeout leaves the current source pending for the
 * next daily invocation; a permanent source error is terminal for this run,
 * recorded, and does not discard results from other sources.
 */
export async function runRadarCollectionPortion(input: { runId: string; ownerId: string; leaseToken: string }, supabase: SupabaseClient = createAdminClient()): Promise<RadarPortionResult> {
  const started = Date.now();
  const { data: runRow, error } = await supabase.from("price_radar_runs").select("*").eq("id", input.runId).eq("owner_id", input.ownerId).maybeSingle();
  if (error || !runRow) throw new Error("RADAR_RUN_NOT_FOUND");
  const run = toRadarRun(runRow);
  if (run.status === "completed" || run.status === "failed" || run.status === "partial") return resultOf(run);
  if (run.leaseToken !== input.leaseToken) throw new Error("RADAR_LEASE_LOST");

  const checkpoint = run.checkpoint;
  let scanned = run.scannedCount;
  let qualified = run.qualifiedCount;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PORTION_BUDGET_MS);
  try {
    while (checkpoint.currentSourceIndex < checkpoint.sourceQueue.length) {
      if (Date.now() - started >= PORTION_BUDGET_MS - YIELD_MARGIN_MS) break;
      const sourceId = checkpoint.sourceQueue[checkpoint.currentSourceIndex];
      if (checkpoint.perSourceCursor[sourceId] === SOURCE_DONE_CURSOR) {
        checkpoint.sourceStatuses[sourceId] = checkpoint.sourceErrors[sourceId] ? "failed" : "completed";
        checkpoint.currentSourceIndex += 1;
        await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
        continue;
      }
      const source = activeSources(syntheticCriteria(sourceId)).find((candidate) => candidate.id === sourceId);
      if (!source) {
        checkpoint.sourceStatuses[sourceId] = "failed";
        checkpoint.sourceErrors[sourceId] = "SOURCE_NOT_ACTIVE_OR_REGISTERED";
        checkpoint.currentSourceIndex += 1;
        await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
        continue;
      }

      checkpoint.sourceStatuses[sourceId] = "running";
      delete checkpoint.sourceErrors[sourceId];
      await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
      try {
        if (sourceId === "olx") {
          await enqueueRadarOlxJob({ ownerId: input.ownerId, runId: input.runId, leaseToken: input.leaseToken, city: "Łódź" }, supabase);
          checkpoint.sourceStatuses.olx = "running";
          await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
          break;
        }
        let emittedBatches = false;
        const processBatch = async (batch: SourceBatch, nextCursor: number | null) => {
          if (Date.now() - started >= PORTION_BUDGET_MS - YIELD_MARGIN_MS) {
            controller.abort();
            throw new Error("RADAR_PORTION_BUDGET_YIELD");
          }
          emittedBatches = true;
          scanned += batch.fetched;
          for (const listing of batch.listings) {
            controller.signal.throwIfAborted();
            const outcome = qualifyRadarCandidate({
              source: listing.source, externalListingId: listing.externalListingId, originalUrl: listing.originalUrl, normalizedUrl: listing.normalizedUrl,
              title: listing.title, description: listing.description, price: listing.price, area: listing.area, pricePerSqm: listing.pricePerSqm,
              rooms: listing.rooms, city: listing.city, district: listing.district, buildingType: listing.buildingType,
              marketType: typeof listing.rawPayload.marketType === "string" ? listing.rawPayload.marketType : null,
              propertyType: typeof listing.rawPayload.propertyType === "string" ? listing.rawPayload.propertyType : null,
              rawPayload: listing.rawPayload, contentHash: listing.contentHash,
            });
            if (!outcome.qualified) continue;
            const raw = listing.rawPayload;
            const crossSourceIdentity = listing.crossSourceIdentity ?? null;
            await persistRadarListing(supabase, {
              ...outcome, source: listing.source, externalListingId: listing.externalListingId,
              originalUrl: listing.originalUrl, normalizedUrl: listing.normalizedUrl, title: listing.title,
              description: listing.description, price: listing.price!, area: listing.area!, rooms: listing.rooms,
              city: listing.city!, contentHash: listing.contentHash, publishedAt: listing.publishedAt ?? null,
              sourceUpdatedAt: sourceDate(raw, ["updatedAt", "modifiedAt", "updated_at", "modified_at"]),
              crossSourceIdentity, rawPayload: raw,
            }, { ownerId: input.ownerId, runId: input.runId, leaseToken: input.leaseToken, seenAt: new Date().toISOString() }, controller.signal);
            qualified += 1;
          }
          for (const warning of batch.warnings) checkpoint.sourceErrors[sourceId] = sourceError(warning);
          checkpoint.perSourceCursor[sourceId] = nextCursor === null ? SOURCE_DONE_CURSOR : nextCursor;
          await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
        };
        // The underlying adapter must honor the passed AbortSignal. We also
        // refuse to persist any result after this portion's budget expires.
        const cursorValue = checkpoint.perSourceCursor[sourceId];
        const batches = { ...(typeof cursorValue === "number" ? { cursor: cursorValue } : {}), onBatch: processBatch };
        const sourcePromise = source.fetch(syntheticCriteria(sourceId), controller.signal, batches);
        const result = await Promise.race([sourcePromise, abortPromise(controller.signal)]);
        controller.signal.throwIfAborted();
        if (!emittedBatches) {
          await processBatch({ listings: result.listings, warnings: result.warnings, fetched: result.fetched }, null);
        }
        if (result.warnings.length > 0) checkpoint.sourceErrors[sourceId] = result.warnings.map(sourceError).join("; ").slice(0, 1000);
        checkpoint.sourceStatuses[sourceId] = checkpoint.sourceErrors[sourceId] ? "failed" : "completed";
        checkpoint.perSourceCursor[sourceId] = SOURCE_DONE_CURSOR;
        checkpoint.currentSourceIndex += 1;
        await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
      } catch (reason) {
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
          break;
        }
        checkpoint.sourceStatuses[sourceId] = "failed";
        checkpoint.sourceErrors[sourceId] = sourceError(reason);
        checkpoint.currentSourceIndex += 1;
        if (isTerminalAccessError(reason)) checkpoint.sourceErrors[sourceId] = `TERMINAL_ACCESS_ERROR: ${checkpoint.sourceErrors[sourceId]}`;
        await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, "running");
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  const done = checkpoint.currentSourceIndex >= checkpoint.sourceQueue.length;
  const failedSources = Object.values(checkpoint.sourceStatuses).filter((status) => status === "failed").length;
  const finalStatus: RadarRunStatus = done ? failedSources === 0 ? "completed" : failedSources === checkpoint.sourceQueue.length ? "failed" : "partial" : "running";
  const errorMessage = Object.entries(checkpoint.sourceErrors).map(([sourceId, message]) => `${sourceId}: ${message}`).join("\n").slice(0, 2000) || null;
  await saveCheckpoint(supabase, input, checkpoint, scanned, qualified, finalStatus, errorMessage);
  return { status: finalStatus, scannedCount: scanned, qualifiedCount: qualified, sourceStatuses: checkpoint.sourceStatuses, sourceErrors: checkpoint.sourceErrors };
}

async function saveCheckpoint(supabase: SupabaseClient, input: { runId: string; ownerId: string; leaseToken: string }, checkpoint: RadarCheckpoint, scanned: number, qualified: number, status: RadarRunStatus, errorMessage: string | null = null): Promise<void> {
  const { data, error } = await supabase.rpc("checkpoint_price_radar_run", {
    p_owner_id: input.ownerId, p_run_id: input.runId, p_lease_token: input.leaseToken,
    p_checkpoint: checkpoint, p_source_statuses: checkpoint.sourceStatuses,
    p_scanned_count: scanned, p_qualified_count: qualified, p_status: status,
    p_error_message: errorMessage, p_lease_seconds: LEASE_SECONDS,
  });
  if (error || data !== true) throw new Error("RADAR_LEASE_LOST");
}

function resultOf(run: RadarRun): RadarPortionResult {
  return { status: run.status === "pending" ? "running" : run.status, scannedCount: run.scannedCount, qualifiedCount: run.qualifiedCount, sourceStatuses: run.sourceStatuses, sourceErrors: run.sourceErrors };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new DOMException("The operation was aborted", "AbortError"));
    else signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), { once: true });
  });
}
