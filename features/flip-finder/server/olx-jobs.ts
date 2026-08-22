import "server-only";

import { aggregateFacebookJobStatus } from "@/features/facebook-worker/multi-group";
import { evaluateListingAgainstFilter } from "@/features/flip-finder/filter-evaluation";
import { addMatchDiagnostic, createMatchDiagnostic, emptyMatchDiagnosticSummary } from "@/features/flip-finder/match-diagnostics";
import { assertAllowedOlxUrl } from "@/features/flip-finder/olx-parser";
import { addScanItemCounts, type ScanItemCounts } from "@/features/flip-finder/scan-counters";
import type { SourceScanResult } from "@/features/flip-finder/server/manual-scan";
import { createOlxWorkerAdminClient } from "@/features/flip-finder/server/olx-worker-admin";
import { persistListing } from "@/features/flip-finder/server/persist-listing";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import { slugifyCity, type SourceListing } from "@/features/flip-finder/server/search-source-registry";
import type { SearchFilter } from "@/features/flip-finder";

type Row = Record<string, unknown>;

export type EnqueuedOlxJob = { jobId: string; sourceScanId: string; runId: string; status: "queued" };
export type ClaimedOlxJob = {
  id: string;
  runId: string;
  sourceScanId: string;
  filterId: string;
  requestUrl: string;
  leaseToken: string;
  leasedUntil: string;
  attempts: number;
};

export async function enqueueOlxJob(filter: SearchFilter, runId: string): Promise<EnqueuedOlxJob> {
  const supabase = createOlxWorkerAdminClient();
  const requestUrl = `https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/${slugifyCity(filter.city)}/`;
  assertAllowedOlxUrl(requestUrl);
  const scan = await supabase.from("source_scans").insert({
    search_filter_id: filter.id,
    source: "olx",
    status: "pending",
    scan_run_id: runId,
    filter_snapshot: filter,
  }).select("id").single();
  if (scan.error || !scan.data?.id) throw new Error(`Nie udało się utworzyć oczekującego skanu OLX: ${scan.error?.message ?? "brak ID"}`);
  const sourceScanId = String(scan.data.id);
  const idempotencyKey = `${filter.id}:olx:${runId}`;
  const job = await supabase.from("olx_scan_jobs").insert({
    scan_run_id: runId,
    source_scan_id: sourceScanId,
    search_filter_id: filter.id,
    request_url: requestUrl,
    filter_snapshot: filter,
    idempotency_key: idempotencyKey,
  }).select("id").single();
  if (job.error || !job.data?.id) {
    await supabase.from("source_scans").update({ status: "failed", finished_at: new Date().toISOString(), error_message: "Nie udało się dodać zadania OLX do kolejki." }).eq("id", sourceScanId);
    throw new Error(`Nie udało się dodać zadania OLX do kolejki: ${job.error?.message ?? "brak ID"}`);
  }
  return { jobId: String(job.data.id), sourceScanId, runId, status: "queued" };
}

export async function claimOlxJob(workerId: string): Promise<ClaimedOlxJob | null> {
  if (workerId.trim().length < 3 || workerId.length > 100) throw new Error("INVALID_WORKER_ID");
  const supabase = createOlxWorkerAdminClient();
  const result = await supabase.rpc("claim_olx_scan_job", { p_worker_id: workerId, p_lease_seconds: 120 });
  if (result.error) throw new Error(`OLX_JOB_CLAIM_FAILED: ${result.error.message}`);
  const row = Array.isArray(result.data) ? asRow(result.data[0]) : asRow(result.data);
  if (!row) return null;
  return {
    id: requiredString(row.id, "job id"),
    runId: requiredString(row.scan_run_id, "run id"),
    sourceScanId: requiredString(row.source_scan_id, "source scan id"),
    filterId: requiredString(row.search_filter_id, "filter id"),
    requestUrl: assertAllowedOlxUrl(requiredString(row.request_url, "request url")).toString(),
    leaseToken: requiredString(row.lease_token, "lease token"),
    leasedUntil: requiredString(row.leased_until, "leased until"),
    attempts: nonnegativeInteger(row.attempts),
  };
}

export async function heartbeatOlxJob(input: { jobId: string; leaseToken: string; workerId: string }): Promise<string> {
  const supabase = createOlxWorkerAdminClient();
  const leasedUntil = new Date(Date.now() + 120_000).toISOString();
  const result = await supabase.from("olx_scan_jobs").update({ heartbeat_at: new Date().toISOString(), leased_until: leasedUntil })
    .eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("worker_id", input.workerId).eq("status", "running").select("id").maybeSingle();
  if (result.error || !result.data) throw new Error("OLX_JOB_LEASE_LOST");
  return leasedUntil;
}

export async function failOlxJob(input: { jobId: string; leaseToken: string; workerId: string; errorCode: string; errorMessage: string }): Promise<void> {
  const supabase = createOlxWorkerAdminClient();
  const now = new Date().toISOString();
  const job = await supabase.from("olx_scan_jobs").update({ status: "failed", finished_at: now, leased_until: null, heartbeat_at: now, error_code: input.errorCode.slice(0, 100), error_message: input.errorMessage.slice(0, 1000) })
    .eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("worker_id", input.workerId).eq("status", "running").select("source_scan_id").maybeSingle();
  if (job.error || !job.data) throw new Error("OLX_JOB_LEASE_LOST");
  await supabase.from("source_scans").update({ status: "failed", finished_at: now, error_message: input.errorMessage.slice(0, 1000) }).eq("id", job.data.source_scan_id).in("status", ["pending", "running"]);
}

export async function completeOlxJob(input: { jobId: string; leaseToken: string; workerId: string; fetched: number; listings: SourceListing[]; warnings: string[]; durationMs: number }): Promise<SourceScanResult> {
  const supabase = createOlxWorkerAdminClient();
  const jobResult = await supabase.from("olx_scan_jobs").select("id,status,source_scan_id,search_filter_id,result_summary").eq("id", input.jobId).maybeSingle();
  if (jobResult.error || !jobResult.data) throw new Error("OLX_JOB_NOT_FOUND");
  if (jobResult.data.status === "completed" && isSourceScanResult(jobResult.data.result_summary)) return jobResult.data.result_summary;
  const lease = await supabase.from("olx_scan_jobs").select("id").eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("worker_id", input.workerId).eq("status", "running").maybeSingle();
  if (lease.error || !lease.data) throw new Error("OLX_JOB_LEASE_LOST");
  const filter = await getSearchFilter(String(jobResult.data.search_filter_id));
  if (!filter) throw new Error("OLX_FILTER_NOT_FOUND");
  const sourceScanId = String(jobResult.data.source_scan_id);
  const matchedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  let counters: ScanItemCounts = { listingsCreatedCount: 0, newMatchesCount: 0 };
  let matched = 0;
  let updated = 0;
  let priceDrops = 0;
  const diagnostics = emptyMatchDiagnosticSummary();
  try {
    for (const listing of input.listings) {
      controller.signal.throwIfAborted();
      const decision = evaluateListingAgainstFilter(listing, filter);
      const saved = await persistListing(supabase, filter.id, listing, decision.matches, decision.unknownFields, sourceScanId, matchedAt, controller.signal);
      addMatchDiagnostic(diagnostics, createMatchDiagnostic(saved.listingId, listing, filter, decision));
      if (decision.matches) matched += 1;
      counters = addScanItemCounts(counters, { listingCreated: saved.listingCreated, matchCreated: saved.matchCreated });
      updated += saved.updated;
      priceDrops += saved.priceDrop;
    }
  } finally {
    clearTimeout(timeout);
  }
  const result: SourceScanResult = {
    source: "olx", status: "completed", fetched: input.fetched, normalized: input.listings.length, matched,
    listingsCreated: counters.listingsCreatedCount, newMatches: counters.newMatchesCount, updated, priceDrops,
    rejected: Math.max(0, input.fetched - input.listings.length), durationMs: input.durationMs,
    errorCode: null, errorMessage: null, matchDiagnostics: diagnostics,
  };
  const now = new Date().toISOString();
  const scanUpdate = await supabase.from("source_scans").update({
    status: "completed", finished_at: now, scanned_count: input.fetched, listings_found: input.fetched,
    matched_count: matched, listings_created: counters.listingsCreatedCount, new_count: counters.newMatchesCount,
    listings_updated: updated, price_drop_count: priceDrops, warnings: input.warnings, error_message: null,
  }).eq("id", sourceScanId);
  if (scanUpdate.error) throw new Error(`OLX_SOURCE_SCAN_FINALIZE_FAILED: ${scanUpdate.error.message}`);
  const completed = await supabase.from("olx_scan_jobs").update({ status: "completed", finished_at: now, leased_until: null, heartbeat_at: now, result_summary: result, error_code: null, error_message: null })
    .eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("status", "running");
  if (completed.error) throw new Error(`OLX_JOB_FINALIZE_FAILED: ${completed.error.message}`);
  await supabase.from("search_filters").update({ last_scanned_at: now }).eq("id", filter.id);
  return result;
}

export async function getOlxScanRunStatus(runId: string) {
  const supabase = createOlxWorkerAdminClient();
  const [scans, jobs, facebookJobs] = await Promise.all([
    supabase.from("source_scans").select("source,status,scanned_count,matched_count,listings_created,new_count,listings_updated,price_drop_count,error_message").eq("scan_run_id", runId),
    supabase.from("olx_scan_jobs").select("status,error_code,error_message,heartbeat_at").eq("scan_run_id", runId).maybeSingle(),
    supabase.from("facebook_scan_jobs").select("status,error_code,error_message,heartbeat_at").eq("scan_run_id", runId),
  ]);
  if (scans.error || jobs.error || facebookJobs.error) throw new Error("SCAN_STATUS_FAILED");
  const rows = (scans.data ?? []) as Row[];
  const pending = rows.some((row) => row.status === "pending" || row.status === "running");
  const failed = rows.filter((row) => row.status === "failed").length;
  const sum = (key: string) => rows.reduce((total, row) => total + (typeof row[key] === "number" ? Number(row[key]) : 0), 0);
  const facebookRows = (facebookJobs.data ?? []) as Row[];
  const facebookStatuses = facebookRows.map((row) => row.status).filter((status): status is "queued" | "running" | "completed" | "failed" => status === "queued" || status === "running" || status === "completed" || status === "failed");
  const facebookJobStatus = aggregateFacebookJobStatus(facebookStatuses);
  const facebookError = facebookRows.find((row) => typeof row.error_message === "string")?.error_message;
  return {
    runId,
    status: pending ? "running" : failed ? "partial" : "completed",
    olxJobStatus: jobs.data?.status ?? null,
    facebookJobStatus,
    message: jobs.data?.status === "queued" ? "OLX: oczekuje na lokalny worker" : facebookJobStatus === "queued" ? "Facebook: oczekuje na lokalny worker" : jobs.data?.error_message ?? facebookError ?? null,
    scannedCount: sum("scanned_count"), matchedCount: sum("matched_count"), newCount: sum("new_count"),
    updatedCount: sum("listings_updated"), priceDropCount: sum("price_drop_count"),
  };
}

export function parseOlxCompletionPayload(value: unknown): { jobId: string; leaseToken: string; workerId: string; fetched: number; listings: SourceListing[]; warnings: string[]; durationMs: number } {
  const row = requireRow(value);
  const listingsValue = row.listings;
  if (!Array.isArray(listingsValue) || listingsValue.length > 200) throw new Error("INVALID_LISTINGS");
  return {
    jobId: requiredString(row.jobId, "jobId"), leaseToken: requiredString(row.leaseToken, "leaseToken"), workerId: requiredString(row.workerId, "workerId"),
    fetched: nonnegativeInteger(row.fetched), listings: listingsValue.map(parseSourceListing), warnings: stringArray(row.warnings).slice(0, 20), durationMs: nonnegativeInteger(row.durationMs),
  };
}

function parseSourceListing(value: unknown): SourceListing {
  const row = requireRow(value);
  if (row.source !== "olx") throw new Error("INVALID_LISTING_SOURCE");
  const originalUrl = assertAllowedOlxUrl(requiredString(row.originalUrl, "originalUrl")).toString();
  const normalizedUrl = assertAllowedOlxUrl(requiredString(row.normalizedUrl, "normalizedUrl")).toString();
  return {
    source: "olx", externalListingId: requiredString(row.externalListingId, "externalListingId"), originalUrl, normalizedUrl,
    title: nullableString(row.title), price: nullableNumber(row.price), area: nullableNumber(row.area), rooms: nullableNumber(row.rooms), floor: nullableString(row.floor),
    pricePerSqm: nullableNumber(row.pricePerSqm), city: nullableString(row.city), district: nullableString(row.district), locationText: nullableString(row.locationText),
    images: stringArray(row.images).slice(0, 20), thumbnailUrl: nullableString(row.thumbnailUrl), buildingType: nullableString(row.buildingType), description: nullableString(row.description),
    rawPayload: requireRow(row.rawPayload), contentHash: requiredString(row.contentHash, "contentHash"),
  };
}

function isSourceScanResult(value: unknown): value is SourceScanResult { return value !== null && typeof value === "object" && "source" in value && value.source === "olx" && "status" in value && value.status === "completed"; }
function asRow(value: unknown): Row | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function requireRow(value: unknown): Row { const row = asRow(value); if (!row) throw new Error("INVALID_PAYLOAD"); return row; }
function requiredString(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`INVALID_${field.toUpperCase()}`); return value.trim(); }
function nullableString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function nullableNumber(value: unknown): number | null { return value === null ? null : typeof value === "number" && Number.isFinite(value) ? value : null; }
function nonnegativeInteger(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("INVALID_NUMBER"); return value; }
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("INVALID_STRING_ARRAY"); return value.map((item) => String(item)).filter(Boolean); }
