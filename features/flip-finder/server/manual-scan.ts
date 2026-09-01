import "server-only";

import { evaluateListingAgainstFilter } from "@/features/flip-finder/filter-evaluation";
import { addMatchDiagnostic, createMatchDiagnostic, emptyMatchDiagnosticSummary, mergeMatchDiagnosticSummaries, type MatchDiagnosticSummary } from "@/features/flip-finder/match-diagnostics";
import { addScanItemCounts, type ScanItemCounts } from "@/features/flip-finder/scan-counters";
import { activeSources, type SourceFetchResult, type SourceListing, type SearchSource } from "@/features/flip-finder/server/search-source-registry";
import { enqueueOlxJob } from "@/features/flip-finder/server/olx-jobs";
import { enqueueFacebookCollectorScan } from "@/features/collector/facebook-dispatch";
import { persistListing } from "@/features/flip-finder/server/persist-listing";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient as DatabaseClient } from "@supabase/supabase-js";
export { scanStatus } from "./scan-start-errors";

export type SourceScanResult = { source: string; status: "pending" | "completed" | "failed"; fetched: number; normalized: number; matched: number; listingsCreated: number; newMatches: number; updated: number; priceDrops: number; rejected: number; durationMs: number; errorCode: string | null; errorMessage: string | null; matchDiagnostics: MatchDiagnosticSummary };
export type ScanSummary = { runId: string; status: "running" | "completed" | "partial"; sourcesRun: number; sourcesCompleted: number; sourcesFailed: number; fetched: number; normalized: number; listingsCreated: number; newMatches: number; updated: number; priceDrops: number; rejected: number; actualErrors: number; sourceResults: SourceScanResult[]; matchDiagnostics: MatchDiagnosticSummary; scannedCount: number; matchedCount: number; newCount: number; updatedCount: number; priceDropCount: number; warnings: string[] };
type SupabaseClient = DatabaseClient;
type LoadedFilter = Awaited<ReturnType<typeof getSearchFilter>> & {};
type Progress = { fetched: number; matched: number; counters: ScanItemCounts; updated: number; priceDrops: number };
type ScanClock = { startedAt: string; startedMs: number };

const STALE_SCAN_TIMEOUT_MS = 15 * 60 * 1000;
const STALE_SCAN_MESSAGE = "Scan timed out";
const SOURCE_TIMEOUT_MS = 75_000;
const DATABASE_TIMEOUT_MS = 12_000;

export function sourceScanMetrics(result: SourceFetchResult, matchedCount: number) {
  return { scannedCount: result.fetched, listingsFound: result.fetched, matchedCount };
}

export async function runManualOtodomScan(filterId: string): Promise<ScanSummary> {
  const runId = crypto.randomUUID();
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
  const supabase = await createClient();
  await failStaleRunningScans(supabase, filterId, sourceIds);
  const { data: running, error: runningError } = await supabase.from("source_scans").select("id").eq("search_filter_id", filterId).in("source", sourceIds).in("status", ["pending", "running"]).limit(1).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
  if (runningError) throw statusError(500, "Nie udało się sprawdzić statusu skanu.");
  if (running?.length) throw statusError(429, "Skan tego filtra już trwa.");

  scanLog("SCAN START", { scanId: runId, source: "all", checked: 0, new: 0, matched: 0, durationMs: 0 });
  try {
    for (const source of sources.filter((item) => item.id !== "olx")) {
      sourceResults.push(await scanSource(source, filterId, filter, supabase, runId, ownedScans));
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
      try {
        await enqueueFacebookCollectorScan(filter, runId);
        sourceResults.push(pendingResult("facebook", "Facebook: oczekuje na production Collector"));
      } catch (error) {
        sourceResults.push(failedResult("facebook", 0, "FACEBOOK_COLLECTOR_DISPATCH_FAILED", error instanceof Error ? error.message : "Facebook Collector dispatch failed."));
      }
    }
    const completed = sourceResults.filter((result) => result.status === "completed");
    const pending = sourceResults.filter((result) => result.status === "pending");
    const failed = sourceResults.filter((result) => result.status === "failed").length;
    if (!completed.length && !pending.length) {
      const facebookFailure = sourceResults.find((result) => result.source === "facebook" && result.status === "failed");
      if (facebookFailure && /COLLECTOR_(?:OFFLINE|READINESS_QUERY_FAILED)/.test(facebookFailure.errorMessage ?? "")) {
        const failureMessage = facebookFailure.errorMessage ?? "";
        throw statusError(503, failureMessage.startsWith("COLLECTOR_OFFLINE") ? "COLLECTOR_OFFLINE" : "COLLECTOR_READINESS_UNAVAILABLE");
      }
      throw statusError(500, sourceResults.map((result) => result.errorMessage).filter(Boolean).join(" ") || "Wszystkie źródła skanu zakończyły się błędem.");
    }
    const sum = (key: keyof Pick<SourceScanResult, "fetched" | "normalized" | "matched" | "listingsCreated" | "newMatches" | "updated" | "priceDrops" | "rejected">) => sourceResults.reduce((total, result) => total + result[key], 0);
    const warnings = sourceResults.filter((result) => result.errorMessage).map((result) => `${result.source}: ${result.errorMessage}`);
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

async function scanSource(source: SearchSource, filterId: string, filter: LoadedFilter, supabase: SupabaseClient, runId: string, ownedScans: Map<string, ScanClock>): Promise<SourceScanResult> {
  const started = Date.now();
  const { data: scan, error } = await supabase.from("source_scans").insert({ search_filter_id: filterId, source: source.id, status: "running", scan_run_id: runId, filter_snapshot: filter }).select("id,started_at").abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS)).single();
  if (error || !scan || typeof scan.id !== "string" || typeof scan.started_at !== "string") return failedResult(source.id, Date.now() - started, "SCAN_CREATE_FAILED", "Nie udało się rozpocząć skanu źródła.");
  const scanClock = { startedAt: scan.started_at, startedMs: started };
  ownedScans.set(scan.id, scanClock);
  scanLog("SOURCE START", { scanId: runId, source: source.id, checked: 0, new: 0, matched: 0, durationMs: 0 });

  let counters: ScanItemCounts = { listingsCreatedCount: 0, newMatchesCount: 0 };
  let updated = 0; let priceDrops = 0; let fetched = 0; let normalized = 0; let matched = 0; let warnings: string[] = [];
  let status: SourceScanResult["status"] = "completed"; let errorCode: string | null = null; let errorMessage: string | null = null;
  const otodomSummary = createOtodomFilterSummary();
  const matchDiagnostics = emptyMatchDiagnosticSummary();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const result = await source.fetch(filter, controller.signal);
    fetched = result.fetched; normalized = result.listings.length; warnings = result.warnings;
    await updateSourceProgress(supabase, scan.id, filter, { fetched, matched, counters, updated, priceDrops }, controller.signal);
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
      await updateSourceProgress(supabase, scan.id, filter, { fetched, matched, counters, updated, priceDrops }, controller.signal);
    }
    if (source.id === "otodom") console.info("OTODOM FILTER SUMMARY:", otodomSummary);
  } catch (reason) {
    status = "failed";
    errorCode = controller.signal.aborted ? "SOURCE_TIMEOUT" : "SOURCE_FAILED";
    errorMessage = controller.signal.aborted ? `${source.label}: source timeout after ${SOURCE_TIMEOUT_MS / 1000}s` : reason instanceof Error ? reason.message : "Błąd źródła.";
  } finally {
    clearTimeout(timeoutId);
    await finalizeSourceScan(supabase, scan.id, scanClock, status, { fetched, matched, counters, updated, priceDrops, warnings, errorMessage });
  }
  const result = { source: source.id, status, fetched, normalized, matched, listingsCreated: counters.listingsCreatedCount, newMatches: counters.newMatchesCount, updated, priceDrops, rejected: Math.max(0, fetched - normalized), durationMs: Date.now() - started, errorCode, errorMessage, matchDiagnostics };
  scanLog(status === "completed" ? "SOURCE DONE" : "SOURCE ERROR", { scanId: runId, source: source.id, checked: fetched, new: counters.newMatchesCount, matched, durationMs: result.durationMs });
  return result;
}

async function failStaleRunningScans(supabase: SupabaseClient, filterId: string, sourceIds: string[]): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_SCAN_TIMEOUT_MS).toISOString();
  const { error } = await supabase.from("source_scans").update({ status: "failed", finished_at: new Date().toISOString(), error_message: STALE_SCAN_MESSAGE }).eq("search_filter_id", filterId).in("source", sourceIds).eq("status", "running").lt("started_at", staleBefore).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
  if (error) throw statusError(500, "Nie udało się zwolnić wygasłej blokady skanu.");
}

async function updateSourceProgress(supabase: SupabaseClient, scanId: string, filter: LoadedFilter, progress: Progress, signal: AbortSignal): Promise<void> {
  const heartbeat = { lastProgressAt: new Date().toISOString(), checked: progress.fetched, matched: progress.matched, new: progress.counters.newMatchesCount };
  const { error } = await supabase.from("source_scans").update({ scanned_count: progress.fetched, listings_found: progress.fetched, matched_count: progress.matched, listings_created: progress.counters.listingsCreatedCount, new_count: progress.counters.newMatchesCount, listings_updated: progress.updated, price_drop_count: progress.priceDrops, filter_snapshot: { ...filter, _scanProgress: heartbeat } }).eq("id", scanId).abortSignal(signal);
  if (error) throw new Error(`Nie udało się zapisać postępu skanu: ${error.message}`);
}

async function finalizeSourceScan(supabase: SupabaseClient, scanId: string, scanClock: ScanClock, status: SourceScanResult["status"], input: Progress & { warnings: string[]; errorMessage: string | null }): Promise<void> {
  const payload = { status, finished_at: scanTimestamp(scanClock), error_message: input.errorMessage, scanned_count: input.fetched, listings_found: input.fetched, matched_count: input.matched, listings_created: input.counters.listingsCreatedCount, new_count: input.counters.newMatchesCount, listings_updated: input.updated, price_drop_count: input.priceDrops, warnings: input.warnings };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { error } = await supabase.from("source_scans").update(payload).eq("id", scanId).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
    if (!error) return;
    console.error("FLIP FINDER SOURCE FINALIZE ERROR:", { scanId, status, attempt, error });
  }
  throw new Error(`Nie udało się sfinalizować skanu źródła ${scanId}.`);
}

async function failOwnedRunningScans(supabase: SupabaseClient, scans: Map<string, ScanClock>): Promise<void> {
  for (const [scanId, scanClock] of scans) {
    const { error } = await supabase.from("source_scans").update({ status: "failed", finished_at: scanTimestamp(scanClock), error_message: "Scan interrupted before finalization" }).eq("id", scanId).eq("status", "running").abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
    if (error) console.error("FLIP FINDER GLOBAL FINALIZE ERROR:", { scanId, error });
  }
}

function scanTimestamp({ startedAt, startedMs }: ScanClock): string {
  return new Date(Date.parse(startedAt) + Math.max(1, Date.now() - startedMs)).toISOString();
}

function failedResult(source: string, durationMs: number, errorCode: string, errorMessage: string): SourceScanResult { return { source, status: "failed", fetched: 0, normalized: 0, matched: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, durationMs, errorCode, errorMessage, matchDiagnostics: emptyMatchDiagnosticSummary() }; }
function pendingResult(source: string, errorMessage = `${source === "olx" ? "OLX" : "Facebook"}: oczekuje na lokalny worker`): SourceScanResult { return { source, status: "pending", fetched: 0, normalized: 0, matched: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, durationMs: 0, errorCode: null, errorMessage, matchDiagnostics: emptyMatchDiagnosticSummary() }; }
function total(results: SourceScanResult[], key: "fetched" | "newMatches" | "matched"): number { return results.reduce((sum, result) => sum + result[key], 0); }
function scanLog(event: "SCAN START" | "SOURCE START" | "SOURCE DONE" | "SOURCE ERROR" | "SCAN FINALIZE", data: { scanId: string; source: string; checked: number; new: number; matched: number; durationMs: number }): void { if (process.env.NODE_ENV === "development") console.info(event, data); }

type OtodomFilterSummary = { evaluated: number; matched: number; rejectedByPricePerSqm: number; rejectedByPrice: number; rejectedByArea: number; rejectedByFloor: number; rejectedByBuildingType: number; rejectedByDistrict: number; rejectedByOtherCriteria: number; acceptedWithUnknownMetadata: number; examples: Array<{ title: string | null; price: number | null; area: number | null; calculatedPricePerSqm: number | null; rejectionReasons: string[] }> };
function createOtodomFilterSummary(): OtodomFilterSummary { return { evaluated: 0, matched: 0, rejectedByPricePerSqm: 0, rejectedByPrice: 0, rejectedByArea: 0, rejectedByFloor: 0, rejectedByBuildingType: 0, rejectedByDistrict: 0, rejectedByOtherCriteria: 0, acceptedWithUnknownMetadata: 0, examples: [] }; }
function addOtodomFilterDecision(summary: OtodomFilterSummary, listing: SourceListing, decision: ReturnType<typeof evaluateListingAgainstFilter>): void { summary.evaluated += 1; if (decision.matches) { summary.matched += 1; if (decision.unknownFields.length) summary.acceptedWithUnknownMetadata += 1; return; } const reasons = decision.reasons; if (reasons.includes("max_price_per_sqm")) summary.rejectedByPricePerSqm += 1; else if (reasons.some((reason) => reason.startsWith("price_"))) summary.rejectedByPrice += 1; else if (reasons.some((reason) => reason.startsWith("area_"))) summary.rejectedByArea += 1; else if (reasons.some((reason) => reason.startsWith("floor_") || reason === "ground_floor")) summary.rejectedByFloor += 1; else if (reasons.includes("building_type")) summary.rejectedByBuildingType += 1; else if (reasons.includes("district")) summary.rejectedByDistrict += 1; else summary.rejectedByOtherCriteria += 1; if (summary.examples.length < 5) summary.examples.push({ title: listing.title, price: listing.price, area: listing.area, calculatedPricePerSqm: listing.price !== null && listing.area !== null && listing.area > 0 ? listing.price / listing.area : null, rejectionReasons: reasons }); }

type StatusError = Error & { status: number };
function statusError(status: number, message: string): StatusError { return Object.assign(new Error(message), { status }); }
