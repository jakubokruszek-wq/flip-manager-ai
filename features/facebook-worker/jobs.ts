import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import { getAlerts } from "@/features/alerts/server";
import { importFacebookWatcher } from "@/features/facebook-watcher/server";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { assertFacebookGroupUrl, assertFacebookPostsBelongToGroup, parseFacebookGroupSnapshot } from "./completion";
import { planFacebookGroupJobs, type WatchedFacebookGroup } from "./multi-group";
import { processFacebookPostBatch } from "./post-flow";
import { facebookVisionToListingInput, persistEligibleFacebookPost } from "./vision-adapter";
import { aggregateFacebookPerformance, FACEBOOK_TOO_OLD_AGE_CACHE_TTL_MS, mergeFacebookGroupAssociationMetadata, readFacebookCachedMatch, resolveFacebookAgeCacheHits, resolveFacebookPostCacheHits } from "./performance";
import { aggregateFacebookVisionRun, summarizeFacebookVisionUsage } from "./openai-pricing";
import { type FacebookAgeCacheHit, type FacebookCompletion, type FacebookCompletionResult, type FacebookFailureCode, type FacebookPostCacheHit, type FacebookWorkerJob } from "./types";

type Row = Record<string, unknown>;
const LEASE_SECONDS = 180;

export type FacebookEnqueueResult = {
  jobs: Array<{ jobId: string; sourceScanId: string; groupId: string; status: "queued" }>;
  failedGroups: Array<{ groupId: string; error: string }>;
  reasonCode: "FACEBOOK_NO_ENABLED_GROUP" | null;
};

export async function enqueueFacebookJobs(filter: SearchFilter, runId: string): Promise<FacebookEnqueueResult> {
  const supabase = createFacebookWatcherAdminClient();
  const groups = await supabase.from("watched_facebook_groups").select("id,name,url,priority,created_at").eq("enabled", true);
  if (groups.error) throw new Error(`FACEBOOK_GROUP_QUERY_FAILED: ${groups.error.message}`);
  const watchedGroups: WatchedFacebookGroup[] = (groups.data ?? []).map((group) => ({
    id: String(group.id), name: String(group.name), url: assertFacebookGroupUrl(String(group.url)).toString(),
    priority: group.priority === "high" || group.priority === "low" ? group.priority : "normal",
    createdAt: String(group.created_at),
  }));
  const plans = planFacebookGroupJobs(filter.id, runId, watchedGroups);
  if (plans.length === 0) {
    const terminal = await supabase.from("source_scans").insert({
      search_filter_id: filter.id, source: "facebook", status: "completed", scan_run_id: runId,
      filter_snapshot: filter, finished_at: new Date().toISOString(), warnings: ["FACEBOOK_NO_ENABLED_GROUP"], error_message: null,
    });
    if (terminal.error) throw new Error(`FACEBOOK_NO_ENABLED_GROUP; SOURCE_SCAN_CREATE_FAILED: ${terminal.error.message}`);
    return { jobs: [], failedGroups: [], reasonCode: "FACEBOOK_NO_ENABLED_GROUP" };
  }
  const result: FacebookEnqueueResult = { jobs: [], failedGroups: [], reasonCode: null };
  for (const plan of plans) {
    const scan = await supabase.from("source_scans").insert({ search_filter_id: filter.id, source: "facebook", status: "pending", scan_run_id: runId, filter_snapshot: filter }).select("id").single();
    if (scan.error || !scan.data?.id) {
      result.failedGroups.push({ groupId: plan.group.id, error: `FACEBOOK_SOURCE_SCAN_CREATE_FAILED: ${scan.error?.message ?? "missing id"}` });
      continue;
    }
    const sourceScanId = String(scan.data.id);
    const job = await supabase.from("facebook_scan_jobs").insert({
      scan_run_id: runId, source_scan_id: sourceScanId, search_filter_id: filter.id,
      group_snapshot: plan.groupSnapshot, idempotency_key: plan.idempotencyKey,
    }).select("id").single();
    if (job.error || !job.data?.id) {
      const message = `FACEBOOK_JOB_ENQUEUE_FAILED: ${job.error?.message ?? "missing id"}`;
      await supabase.from("source_scans").update({ status: "failed", finished_at: new Date().toISOString(), error_message: message }).eq("id", sourceScanId);
      result.failedGroups.push({ groupId: plan.group.id, error: message });
      continue;
    }
    result.jobs.push({ jobId: String(job.data.id), sourceScanId, groupId: plan.group.id, status: "queued" });
  }
  return result;
}

export async function claimFacebookJob(workerId: string): Promise<FacebookWorkerJob | null> {
  if (workerId.trim().length < 3 || workerId.length > 100) throw new Error("INVALID_WORKER_ID");
  const supabase = createFacebookWatcherAdminClient();
  const result = await supabase.rpc("claim_facebook_scan_job", { p_worker_id: workerId.trim(), p_lease_seconds: LEASE_SECONDS });
  if (result.error) throw new Error(`FACEBOOK_JOB_CLAIM_FAILED: ${result.error.message}`);
  const row = Array.isArray(result.data) ? asRow(result.data[0]) : asRow(result.data);
  if (!row) return null;
  return {
    id: requiredString(row.id), runId: requiredString(row.scan_run_id), sourceScanId: requiredString(row.source_scan_id), filterId: requiredString(row.search_filter_id),
    group: parseFacebookGroupSnapshot(row.group_snapshot), leaseToken: requiredString(row.lease_token), leasedUntil: requiredString(row.leased_until), attempts: nonnegativeInteger(row.attempts),
  };
}

export async function heartbeatFacebookJob(input: { jobId: string; leaseToken: string; workerId: string }): Promise<string> {
  const supabase = createFacebookWatcherAdminClient();
  const now = new Date(); const leasedUntil = new Date(now.getTime() + LEASE_SECONDS * 1_000).toISOString();
  const result = await supabase.from("facebook_scan_jobs").update({ heartbeat_at: now.toISOString(), leased_until: leasedUntil })
    .eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("worker_id", input.workerId).eq("status", "running").select("id").maybeSingle();
  if (result.error || !result.data) throw new Error("FACEBOOK_JOB_LEASE_LOST");
  return leasedUntil;
}

export async function getFacebookWorkerCache(input: { jobId: string; leaseToken: string; workerId: string; postIds: string[] }): Promise<{ hits: Record<string, FacebookPostCacheHit & { publishedAt: string }>; ageHits: Record<string, FacebookAgeCacheHit> }> {
  const supabase = createFacebookWatcherAdminClient();
  const current = await supabase.from("facebook_scan_jobs").select("id,scan_run_id,search_filter_id,started_at").eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("worker_id", input.workerId).eq("status", "running").maybeSingle();
  if (current.error || !current.data) throw new Error("FACEBOOK_JOB_LEASE_LOST");
  const jobStartedAt = Date.parse(String(current.data.started_at));
  const cacheReferenceTime = Number.isFinite(jobStartedAt) ? jobStartedAt : Date.now();
  const cutoff = new Date(cacheReferenceTime - FACEBOOK_TOO_OLD_AGE_CACHE_TTL_MS).toISOString();
  const cached = await supabase.from("facebook_scan_jobs").select("id,scan_run_id,result_summary,finished_at")
    .eq("search_filter_id", current.data.search_filter_id).eq("status", "completed").gte("finished_at", cutoff).neq("id", input.jobId).order("finished_at", { ascending: false }).limit(200);
  if (cached.error) throw new Error(`FACEBOOK_CACHE_QUERY_FAILED: ${cached.error.message}`);
  const sources = (cached.data ?? []).map((row) => ({ jobId: String(row.id), runId: String(row.scan_run_id), resultSummary: row.result_summary }));
  const hits = resolveFacebookPostCacheHits({ currentRunId: String(current.data.scan_run_id), sources, postIds: input.postIds, nowMs: cacheReferenceTime });
  const ageHits = resolveFacebookAgeCacheHits({ currentRunId: String(current.data.scan_run_id), sources, postIds: input.postIds, nowMs: cacheReferenceTime });
  const listingIds = [...new Set(Object.values(hits).flatMap((hit) => hit.outcome === "SELL_PERSISTED" && hit.listingId ? [hit.listingId] : []))];
  if (listingIds.length === 0) return { hits, ageHits };
  const listings = await supabase.from("listings").select("id,source,external_listing_id,status").in("id", listingIds).eq("source", "facebook").eq("status", "active");
  if (listings.error) throw new Error(`FACEBOOK_CACHE_LISTING_QUERY_FAILED: ${listings.error.message}`);
  const valid = new Map((listings.data ?? []).map((row) => [String(row.id), String(row.external_listing_id)]));
  return { hits: Object.fromEntries(Object.entries(hits).filter(([postId, hit]) => hit.outcome === "DETERMINISTIC_SKIP" || Boolean(hit.listingId && valid.get(hit.listingId) === postId))), ageHits };
}

export async function getFacebookPostCache(input: { jobId: string; leaseToken: string; workerId: string; postIds: string[] }): Promise<Record<string, FacebookPostCacheHit & { publishedAt: string }>> {
  return (await getFacebookWorkerCache(input)).hits;
}

export async function completeFacebookJob(input: FacebookCompletion): Promise<FacebookCompletionResult> {
  const supabase = createFacebookWatcherAdminClient();
  const existing = await supabase.from("facebook_scan_jobs").select("status,scan_run_id,source_scan_id,search_filter_id,group_snapshot,result_summary").eq("id", input.jobId).maybeSingle();
  if (existing.error || !existing.data) throw new Error("FACEBOOK_JOB_NOT_FOUND");
  if (existing.data.status === "completed" && isCompletionResult(existing.data.result_summary)) return existing.data.result_summary;
  const lease = await supabase.from("facebook_scan_jobs").select("id").eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("worker_id", input.workerId).eq("status", "running").maybeSingle();
  if (lease.error || !lease.data) throw new Error("FACEBOOK_JOB_LEASE_LOST");
  const group = parseFacebookGroupSnapshot(existing.data.group_snapshot);
  assertFacebookPostsBelongToGroup(input.posts, group);
  const now = new Date().toISOString();
  const sourceScanId = String(existing.data.source_scan_id);
  const searchFilterId = String(existing.data.search_filter_id);
  const sourceScan = await supabase.from("source_scans").select("filter_snapshot").eq("id", sourceScanId).maybeSingle();
  if (sourceScan.error || !sourceScan.data) throw new Error(`FACEBOOK_SOURCE_SCAN_READ_FAILED: ${sourceScan.error?.message ?? "missing source scan"}`);
  const filter = parseStoredFilter(sourceScan.data.filter_snapshot, searchFilterId);
  const summary = await processFacebookPostBatch(input.posts, async (post) => {
    if (post.cacheHit && post.postId && post.permalink) {
      const validated = await getFacebookPostCache({ jobId: input.jobId, leaseToken: input.leaseToken, workerId: input.workerId, postIds: [post.postId] });
      const cache = validated[post.postId];
      if (!cache || cache.sourceJobId !== post.cacheHit.sourceJobId || cache.listingId !== post.cacheHit.listingId || cache.outcome !== post.cacheHit.outcome) throw new Error("FACEBOOK_CACHE_HIT_INVALID");
      if (cache.outcome === "DETERMINISTIC_SKIP") return reusedDeterministicSkip(cache);
      if (!cache.listingId) throw new Error("FACEBOOK_CACHE_HIT_INVALID");
      return associateCachedFacebookListing(supabase, { listingId: cache.listingId, sourceUrl: post.permalink, postId: post.postId, groupId: group.id, groupName: group.name, filterId: filter.id, publishedAt: post.publishedAt, analyzedAt: cache.analyzedAt });
    }
    return persistEligibleFacebookPost(post, async (eligiblePost) => {
      const imported = await importFacebookWatcher(facebookVisionToListingInput(eligiblePost, group.name), {
        filter,
        sourceScanId,
        groupId: group.id,
        groupName: group.name,
        groupUrl: group.url,
        postId: eligiblePost.postId,
        checkedAt: now,
      });
      return { status: imported.status, listingId: imported.listingId, listingCreated: imported.listingCreated, listingUpdated: imported.listingUpdated, matched: imported.matched, matchCreated: imported.matchCreated, imagesMirrored: imported.imagesMirrored, priceDrops: imported.priceDrops, warnings: imported.warnings, notProperty: imported.notProperty, persistenceDiagnostics: imported.persistenceDiagnostics };
    });
  }, { jobId: input.jobId, sourceScanId });
  if (summary.listingIds.length > 0) await getAlerts();
  const normalized = summary.postsProcessed - summary.listingsSkipped - summary.extractionFailed;
  const visionCost = summarizeFacebookVisionUsage(input.posts.map((post) => post.vision), input.performance.visionCalls);
  const openaiVisionCalls = input.posts.flatMap((post) => post.vision?.usage ? [{ postId: post.postId, usage: post.vision.usage }] : []);
  const result: FacebookCompletionResult = { source: "facebook", status: "completed", fetched: summary.postsReceived, normalized, durationMs: input.durationMs, postsReceived: summary.postsReceived, postsProcessed: summary.postsProcessed, listingsCreated: summary.listingsCreated, listingsUpdated: summary.listingsUpdated, listingsSkipped: summary.listingsSkipped, matched: summary.matched, newMatches: summary.newMatches, extractionFailed: summary.extractionFailed, imagesMirrored: summary.imagesMirrored, priceDrops: summary.priceDrops, errors: summary.errors, skippedDiagnostics: summary.skippedDiagnostics, persistenceDiagnostics: summary.persistenceDiagnostics, postCache: summary.reusablePosts.map((post) => ({ ...post, analyzedAt: now })), ageCache: input.ageCache, performance: input.performance, ...visionCost, openaiVisionCalls };
  console.info("FACEBOOK_VISION_COST_SUMMARY", { scope: "JOB", jobId: input.jobId, ...visionCost });
  const scan = await supabase.from("source_scans").update({
    status: "completed", finished_at: now, scanned_count: summary.postsProcessed, listings_found: normalized,
    matched_count: summary.matched, listings_created: summary.listingsCreated, new_count: summary.newMatches, listings_updated: summary.listingsUpdated, price_drop_count: summary.priceDrops,
    warnings: [...input.warnings, ...summary.warnings].slice(0, 100), error_message: null,
  }).eq("id", sourceScanId).in("status", ["pending", "running"]);
  if (scan.error) throw new Error(`FACEBOOK_SOURCE_SCAN_FINALIZE_FAILED: ${scan.error.message}`);
  const job = await supabase.from("facebook_scan_jobs").update({ status: "completed", finished_at: now, leased_until: null, heartbeat_at: now, result_summary: result, error_code: null, error_message: null })
    .eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("status", "running");
  if (job.error) throw new Error(`FACEBOOK_JOB_FINALIZE_FAILED: ${job.error.message}`);
  const completed = await supabase.from("facebook_scan_jobs").select("result_summary").eq("scan_run_id", existing.data.scan_run_id).eq("status", "completed");
  if (!completed.error) {
    const completedResults = (completed.data ?? []).map((row) => row.result_summary);
    const durationMs = completedResults.reduce((total, value) => total + (typeof (value as Row | null)?.durationMs === "number" ? Number((value as Row).durationMs) : 0), 0);
    const runVisionCost = aggregateFacebookVisionRun(completedResults);
    console.info("FACEBOOK_PERF_RUN_SUMMARY", { ...aggregateFacebookPerformance(completedResults, durationMs), ...runVisionCost });
    console.info("FACEBOOK_VISION_COST_SUMMARY", { scope: "RUN", runId: existing.data.scan_run_id, ...runVisionCost });
  }
  await supabase.from("watched_facebook_groups").update({ access_status: "CONNECTED", last_checked_at: now, last_error: null }).eq("id", group.id);
  return result;
}

function reusedDeterministicSkip(cache: FacebookPostCacheHit) {
  return {
    status: "skipped" as const, listingId: null, listingCreated: false, listingUpdated: false,
    matched: false, matchCreated: false, imagesMirrored: 0, priceDrops: 0, warnings: [],
    notProperty: {
      realEstateLanguage: true, structuredFieldCount: 0, detectedFields: [], classification: "non_sale_intent" as const,
      reasonCode: cache.reasonCode ?? "FACEBOOK_INTENT_UNKNOWN", listingIntent: cache.listingIntent, intentSource: cache.intentSource,
    },
  };
}

async function associateCachedFacebookListing(
  supabase: ReturnType<typeof createFacebookWatcherAdminClient>,
  input: { listingId: string; sourceUrl: string; postId: string; groupId: string; groupName: string; filterId: string; publishedAt: string | null; analyzedAt: string },
) {
  const now = new Date().toISOString();
  const prior = await supabase.from("listing_source_metadata").select("metadata").eq("source", "facebook").eq("source_post_url", input.sourceUrl).maybeSingle();
  if (prior.error) throw new Error(`FACEBOOK_CACHE_METADATA_READ_FAILED: ${prior.error.message}`);
  const metadata = asRow(prior.data?.metadata) ?? {};
  // Image arrays from older cache entries have no per-image provenance and are
  // not safe to reuse. Keep the listing/cache association, but quarantine the
  // stale current gallery until a verified extraction repopulates it.
  if (metadata.imageExtractionVersion !== 2) {
    const cleared = await supabase.from("listings").update({ images: [] }).eq("id", input.listingId).eq("source", "facebook");
    if (cleared.error) throw new Error(`FACEBOOK_CACHE_IMAGE_INVALIDATION_FAILED: ${cleared.error.message}`);
  }
  const associatedMetadata = mergeFacebookGroupAssociationMetadata(metadata, { id: input.groupId, name: input.groupName });
  const saved = await supabase.from("listing_source_metadata").upsert({
    listing_id: input.listingId, source: "facebook", source_post_url: input.sourceUrl, group_name: input.groupName,
    author_name: null, published_at: input.publishedAt, collected_at: now,
    metadata: { ...associatedMetadata, source: "facebook_worker_cache", postId: input.postId, checkedAt: now, cacheAnalyzedAt: input.analyzedAt, imageExtractionVersion: metadata.imageExtractionVersion === 2 ? 2 : null },
  }, { onConflict: "source,source_post_url" });
  if (saved.error) throw new Error(`FACEBOOK_CACHE_METADATA_PERSIST_FAILED: ${saved.error.message}`);
  const matched = await readFacebookCachedMatch((columns) => supabase.from("listing_filter_matches").select(columns).eq("listing_id", input.listingId).eq("search_filter_id", input.filterId).eq("is_current_match", true).maybeSingle());
  return { status: "reused" as const, listingId: input.listingId, listingCreated: false, listingUpdated: false, matched, matchCreated: false, imagesMirrored: 0, priceDrops: 0, warnings: [], persistenceDiagnostics: {
    postId: input.postId, creationTime: input.publishedAt, timestampSource: input.publishedAt ? "POST_PAGE" as const : "UNKNOWN" as const,
    publishedAtCandidate: input.publishedAt, publishedAtPersistAttempted: false, publishedAtPersisted: false,
    exactBoundCandidates: 0, relevanceAccepted: 0, relevanceRejected: 0, mirrorAttempted: 0, mirroredCount: 0,
    persistedNewImageCount: 0, finalListingImageCount: 0, persistedImageCount: 0,
    imageReasonCode: "CACHE_REUSE", reasonCodes: ["FACEBOOK_CACHE_REUSE"], imageProvenance: [],
  } };
}

export async function failFacebookJob(input: { jobId: string; leaseToken: string; workerId: string; errorCode: FacebookFailureCode | string; errorMessage: string }): Promise<void> {
  const supabase = createFacebookWatcherAdminClient(); const now = new Date().toISOString();
  const job = await supabase.from("facebook_scan_jobs").update({ status: "failed", finished_at: now, leased_until: null, heartbeat_at: now, error_code: input.errorCode.slice(0, 100), error_message: input.errorMessage.slice(0, 1_000) })
    .eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("worker_id", input.workerId).eq("status", "running").select("source_scan_id,group_snapshot").maybeSingle();
  if (job.error || !job.data) throw new Error("FACEBOOK_JOB_LEASE_LOST");
  await supabase.from("source_scans").update({ status: "failed", finished_at: now, error_message: `${input.errorCode}: ${input.errorMessage}`.slice(0, 1_000) }).eq("id", job.data.source_scan_id).in("status", ["pending", "running"]);
  const group = parseFacebookGroupSnapshot(job.data.group_snapshot);
  const accessStatus = input.errorCode === "FACEBOOK_LOGIN_REQUIRED" || input.errorCode === "FACEBOOK_SESSION_EXPIRED" || input.errorCode === "FACEBOOK_CHALLENGE" ? "AUTH_REQUIRED" : "UNAVAILABLE";
  await supabase.from("watched_facebook_groups").update({ access_status: accessStatus, last_checked_at: now, last_error: input.errorMessage.slice(0, 1_000) }).eq("id", group.id);
}

export function parseFacebookFailurePayload(value: unknown) {
  const row = requireRow(value);
  return { jobId: requiredString(row.jobId), leaseToken: requiredString(row.leaseToken), workerId: requiredString(row.workerId), errorCode: requiredString(row.errorCode), errorMessage: requiredString(row.errorMessage) };
}

function isCompletionResult(value: unknown): value is FacebookCompletionResult { const row = asRow(value); return Boolean(row && row.source === "facebook" && row.status === "completed" && typeof row.fetched === "number" && typeof row.normalized === "number" && typeof row.durationMs === "number" && typeof row.postsReceived === "number" && typeof row.postsProcessed === "number" && typeof row.listingsCreated === "number" && typeof row.listingsUpdated === "number" && typeof row.listingsSkipped === "number" && typeof row.matched === "number" && typeof row.newMatches === "number" && typeof row.extractionFailed === "number" && typeof row.imagesMirrored === "number" && typeof row.priceDrops === "number" && typeof row.errors === "number" && Array.isArray(row.skippedDiagnostics)); }
function parseStoredFilter(value: unknown, expectedId: string): SearchFilter { const row = asRow(value); if (!row || row.id !== expectedId || !Array.isArray(row.sources) || !row.sources.includes("facebook")) throw new Error("FACEBOOK_FILTER_SNAPSHOT_INVALID"); return value as SearchFilter; }
function asRow(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function requireRow(value: unknown): Row { const row = asRow(value); if (!row) throw new Error("INVALID_PAYLOAD"); return row; }
function requiredString(value: unknown): string { if (typeof value !== "string" || !value.trim()) throw new Error("INVALID_PAYLOAD"); return value.trim(); }
function nonnegativeInteger(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("INVALID_PAYLOAD"); return value; }
