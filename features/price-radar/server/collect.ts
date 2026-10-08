import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { SOURCES } from "@/features/flip-finder/server/search-source-registry";
import { SCHEMA_READY_SOURCE_IDS } from "@/features/flip-finder/source-availability";
import { qualifyRadarCandidate } from "@/features/price-radar/qualification";
import { persistRadarListing } from "@/features/price-radar/server/persist-radar-listing";
import type { RadarCheckpoint, RadarRun, RadarRunStatus, RadarSource } from "@/features/price-radar/types";
import type { SearchFilter } from "@/features/flip-finder";

/**
 * Radar's own, separate collection run -- a different table
 * (price_radar_runs, never source_scans), a different lock (the DB-level
 * partial unique index in the draft migration, never Finder's continuation
 * lease), and a coarser per-SOURCE checkpoint granularity (not Finder's
 * per-page one): a daily batch job has no live-UI reason to resume mid-page,
 * only to survive the same platform time limit across portions. Reuses the
 * SAME adapter fetch functions Finder uses (SOURCES), unmodified, and the
 * SAME active/blocked gate (SCHEMA_READY_SOURCE_IDS) -- never a source
 * Finder itself has disabled or that is 403-blocked.
 */

// facebook is excluded (Watcher-only, no server adapter); official_auction
// and bezposrednio are excluded by SCHEMA_READY_SOURCE_IDS itself (not yet
// schema-ready/active for Finder either -- Radar must not go further than
// Finder already does).
export const RADAR_SOURCES: RadarSource[] = [...SCHEMA_READY_SOURCE_IDS] as RadarSource[];

const PORTION_BUDGET_MS = 45_000; // comfortably under Vercel Hobby's 60s ceiling
const YIELD_MARGIN_MS = 8_000;

function syntheticCriteria(sourceId: RadarSource): SearchFilter {
  // Deliberately unrestricted: Radar inherits none of a Finder filter's buy
  // thresholds. City is the only query-shaping constraint passed to the
  // adapter; qualifyRadarCandidate (not the portal query) decides district,
  // building type, market, and renovation state from the confirmed result.
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
  return { sourceQueue: sources, currentSourceIndex: 0, perSourceCursor: {}, buffer: [], bufferOffset: 0 };
}

function toRadarRun(row: Record<string, unknown>): RadarRun {
  const checkpointRaw = row.checkpoint;
  const checkpoint = checkpointRaw && typeof checkpointRaw === "object" && !Array.isArray(checkpointRaw) && Array.isArray((checkpointRaw as Record<string, unknown>).sourceQueue)
    ? checkpointRaw as unknown as RadarCheckpoint
    : defaultCheckpoint(RADAR_SOURCES);
  return {
    id: String(row.id),
    status: (row.status as RadarRunStatus) ?? "pending",
    startedAt: String(row.started_at),
    finishedAt: typeof row.finished_at === "string" ? row.finished_at : null,
    checkpoint,
    scannedCount: typeof row.scanned_count === "number" ? row.scanned_count : 0,
    qualifiedCount: typeof row.qualified_count === "number" ? row.qualified_count : 0,
    errorMessage: typeof row.error_message === "string" ? row.error_message : null,
  };
}

function isUniqueViolation(error: { code?: unknown } | null): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

export type RadarClaimResult = { kind: "claimed"; run: RadarRun } | { kind: "already_active"; run: RadarRun } | { kind: "blocked" };

/** Finds the one allowed pending/running run, or creates a new one. The database's own partial unique index (price_radar_runs_one_active_idx) is the real lock -- a losing concurrent insert is reported as "blocked", never allowed to silently create a second run. */
export async function claimOrCreateRadarRun(supabase: SupabaseClient = createAdminClient()): Promise<RadarClaimResult> {
  const existing = await supabase.from("price_radar_runs").select("*").in("status", ["pending", "running"]).maybeSingle();
  if (existing.error) throw new Error("RADAR_RUN_CLAIM_FAILED");
  if (existing.data) return { kind: "already_active", run: toRadarRun(existing.data) };

  const inserted = await supabase
    .from("price_radar_runs")
    .insert({ status: "running", checkpoint: defaultCheckpoint(RADAR_SOURCES) })
    .select("*")
    .single();
  if (inserted.error) {
    if (isUniqueViolation(inserted.error)) return { kind: "blocked" };
    throw new Error("RADAR_RUN_CREATE_FAILED");
  }
  return { kind: "claimed", run: toRadarRun(inserted.data) };
}

export type RadarPortionResult = { status: "running" | "completed" | "failed"; scannedCount: number; qualifiedCount: number };

/**
 * Processes whole sources from the checkpoint's queue until the time budget
 * is spent or the queue is empty, persisting progress after every source so
 * a later call (another cron tick, another manual trigger) resumes exactly
 * where this one yielded -- never re-scanning an already-completed source,
 * never losing a qualified listing already written.
 */
export async function runRadarCollectionPortion(runId: string, supabase: SupabaseClient = createAdminClient()): Promise<RadarPortionResult> {
  const started = Date.now();
  const { data: runRow, error } = await supabase.from("price_radar_runs").select("*").eq("id", runId).maybeSingle();
  if (error || !runRow) throw new Error("RADAR_RUN_NOT_FOUND");
  const run = toRadarRun(runRow);
  if (run.status === "completed" || run.status === "failed") {
    return { status: run.status, scannedCount: run.scannedCount, qualifiedCount: run.qualifiedCount };
  }

  const checkpoint = run.checkpoint;
  let scanned = run.scannedCount;
  let qualified = run.qualifiedCount;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PORTION_BUDGET_MS);

  try {
    while (checkpoint.currentSourceIndex < checkpoint.sourceQueue.length) {
      if (Date.now() - started > PORTION_BUDGET_MS - YIELD_MARGIN_MS) break;
      const sourceId = checkpoint.sourceQueue[checkpoint.currentSourceIndex];
      const source = SOURCES.find((candidate) => candidate.id === sourceId);
      if (!source) {
        checkpoint.currentSourceIndex += 1;
        continue;
      }
      const result = await source.fetch(syntheticCriteria(sourceId), controller.signal).catch((reason) => {
        // One source's own failure (network, portal-side block) must not
        // abort the whole run -- recorded and skipped, same principle as
        // Finder treating one source's terminal failure independently.
        console.warn("RADAR_SOURCE_FETCH_FAILED", { source: sourceId, error: reason instanceof Error ? reason.message : String(reason) });
        return { listings: [], warnings: [], fetched: 0 };
      });
      scanned += result.fetched;
      for (const listing of result.listings) {
        const outcome = qualifyRadarCandidate({
          source: listing.source,
          externalListingId: listing.externalListingId,
          originalUrl: listing.originalUrl,
          normalizedUrl: listing.normalizedUrl,
          title: listing.title,
          description: listing.description,
          price: listing.price,
          area: listing.area,
          pricePerSqm: listing.pricePerSqm,
          rooms: listing.rooms,
          city: listing.city,
          district: listing.district,
          buildingType: listing.buildingType,
          contentHash: listing.contentHash,
        });
        if (outcome.qualified) {
          // qualifyRadarCandidate's own qualified:true guarantees price/area/
          // city were confirmed non-null (its first checks reject otherwise)
          // -- these assertions carry no new risk beyond what already gated
          // this branch.
          await persistRadarListing(supabase, {
            ...outcome,
            source: listing.source,
            externalListingId: listing.externalListingId,
            originalUrl: listing.originalUrl,
            normalizedUrl: listing.normalizedUrl,
            title: listing.title,
            description: listing.description,
            price: listing.price!,
            area: listing.area!,
            rooms: listing.rooms,
            city: listing.city!,
            contentHash: listing.contentHash,
            rawPayload: listing.rawPayload,
          }, new Date().toISOString(), controller.signal);
          qualified += 1;
        }
      }
      checkpoint.currentSourceIndex += 1;
      await supabase.from("price_radar_runs").update({ checkpoint, scanned_count: scanned, qualified_count: qualified }).eq("id", runId);
    }
  } finally {
    clearTimeout(timeoutId);
  }

  const done = checkpoint.currentSourceIndex >= checkpoint.sourceQueue.length;
  await supabase.from("price_radar_runs").update({
    status: done ? "completed" : "running",
    checkpoint,
    scanned_count: scanned,
    qualified_count: qualified,
    finished_at: done ? new Date().toISOString() : null,
  }).eq("id", runId);
  return { status: done ? "completed" : "running", scannedCount: scanned, qualifiedCount: qualified };
}
