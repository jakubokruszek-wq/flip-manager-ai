import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import { getAlerts } from "@/features/alerts/server";
import { importFacebookWatcher } from "@/features/facebook-watcher/server";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { assertFacebookGroupUrl, parseFacebookGroupSnapshot } from "./completion";
import { processFacebookPostBatch } from "./post-flow";
import { facebookJobIdempotencyKey, type FacebookCompletion, type FacebookCompletionResult, type FacebookFailureCode, type FacebookWorkerJob } from "./types";

type Row = Record<string, unknown>;
const LEASE_SECONDS = 180;

export async function enqueueFacebookJob(filter: SearchFilter, runId: string): Promise<{ jobId: string; sourceScanId: string; status: "queued" }> {
  const supabase = createFacebookWatcherAdminClient();
  const groups = await supabase.from("watched_facebook_groups").select("id,name,url").eq("enabled", true).order("priority").order("created_at").limit(1);
  if (groups.error) throw new Error(`FACEBOOK_GROUP_QUERY_FAILED: ${groups.error.message}`);

  const snapshot = (groups.data ?? []).map((group) => ({ id: String(group.id), name: String(group.name), url: assertFacebookGroupUrl(String(group.url)).toString() }));
  if (snapshot.length !== 1) {
    const failed = await supabase.from("source_scans").insert({
      search_filter_id: filter.id, source: "facebook", status: "failed", scan_run_id: runId,
      filter_snapshot: filter, finished_at: new Date().toISOString(), error_message: "FACEBOOK_NO_ENABLED_GROUP",
    });
    if (failed.error) throw new Error(`FACEBOOK_NO_ENABLED_GROUP; SOURCE_SCAN_CREATE_FAILED: ${failed.error.message}`);
    throw new Error("FACEBOOK_NO_ENABLED_GROUP");
  }

  const scan = await supabase.from("source_scans").insert({ search_filter_id: filter.id, source: "facebook", status: "pending", scan_run_id: runId, filter_snapshot: filter }).select("id").single();
  if (scan.error || !scan.data?.id) throw new Error(`FACEBOOK_SOURCE_SCAN_CREATE_FAILED: ${scan.error?.message ?? "missing id"}`);
  const sourceScanId = String(scan.data.id);
  const job = await supabase.from("facebook_scan_jobs").insert({
    scan_run_id: runId, source_scan_id: sourceScanId, search_filter_id: filter.id,
    group_snapshot: snapshot, idempotency_key: facebookJobIdempotencyKey(filter.id, runId),
  }).select("id").single();
  if (job.error || !job.data?.id) {
    await supabase.from("source_scans").update({ status: "failed", finished_at: new Date().toISOString(), error_message: "FACEBOOK_JOB_ENQUEUE_FAILED" }).eq("id", sourceScanId);
    throw new Error(`FACEBOOK_JOB_ENQUEUE_FAILED: ${job.error?.message ?? "missing id"}`);
  }
  return { jobId: String(job.data.id), sourceScanId, status: "queued" };
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
    groups: parseFacebookGroupSnapshot(row.group_snapshot), leaseToken: requiredString(row.lease_token), leasedUntil: requiredString(row.leased_until), attempts: nonnegativeInteger(row.attempts),
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

export async function completeFacebookJob(input: FacebookCompletion): Promise<FacebookCompletionResult> {
  const supabase = createFacebookWatcherAdminClient();
  const existing = await supabase.from("facebook_scan_jobs").select("status,source_scan_id,search_filter_id,group_snapshot,result_summary").eq("id", input.jobId).maybeSingle();
  if (existing.error || !existing.data) throw new Error("FACEBOOK_JOB_NOT_FOUND");
  if (existing.data.status === "completed" && isCompletionResult(existing.data.result_summary)) return existing.data.result_summary;
  const lease = await supabase.from("facebook_scan_jobs").select("id").eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("worker_id", input.workerId).eq("status", "running").maybeSingle();
  if (lease.error || !lease.data) throw new Error("FACEBOOK_JOB_LEASE_LOST");
  const groups = parseFacebookGroupSnapshot(existing.data.group_snapshot);
  if (input.posts.some((post) => post.groupId !== groups[0].id)) throw new Error("FACEBOOK_GROUP_MISMATCH");
  const now = new Date().toISOString();
  const sourceScanId = String(existing.data.source_scan_id);
  const searchFilterId = String(existing.data.search_filter_id);
  const sourceScan = await supabase.from("source_scans").select("filter_snapshot").eq("id", sourceScanId).maybeSingle();
  if (sourceScan.error || !sourceScan.data) throw new Error(`FACEBOOK_SOURCE_SCAN_READ_FAILED: ${sourceScan.error?.message ?? "missing source scan"}`);
  const filter = parseStoredFilter(sourceScan.data.filter_snapshot, searchFilterId);
  const summary = await processFacebookPostBatch(input.posts, async (post) => {
    const imported = await importFacebookWatcher({
      url: post.permalink ?? undefined,
      postText: post.text || undefined,
      groupName: groups[0].name,
      publishedAt: post.publishedAt ?? undefined,
      images: post.imageUrls,
    }, {
      filter,
      sourceScanId,
      groupId: groups[0].id,
      groupName: groups[0].name,
      groupUrl: groups[0].url,
      postId: post.postId,
      checkedAt: now,
    });
    return { status: imported.status, listingId: imported.listingId, listingCreated: imported.listingCreated, listingUpdated: imported.listingUpdated, matched: imported.matched, matchCreated: imported.matchCreated, imagesMirrored: imported.imagesMirrored, priceDrops: imported.priceDrops, warnings: imported.warnings };
  });
  if (summary.listingIds.length > 0) await getAlerts();
  const normalized = summary.postsProcessed - summary.listingsSkipped - summary.extractionFailed;
  const result: FacebookCompletionResult = { source: "facebook", status: "completed", fetched: summary.postsReceived, normalized, durationMs: input.durationMs, postsReceived: summary.postsReceived, postsProcessed: summary.postsProcessed, listingsCreated: summary.listingsCreated, listingsUpdated: summary.listingsUpdated, listingsSkipped: summary.listingsSkipped, matched: summary.matched, newMatches: summary.newMatches, extractionFailed: summary.extractionFailed, imagesMirrored: summary.imagesMirrored, priceDrops: summary.priceDrops, errors: summary.errors };
  const scan = await supabase.from("source_scans").update({
    status: "completed", finished_at: now, scanned_count: summary.postsProcessed, listings_found: normalized,
    matched_count: summary.matched, listings_created: summary.listingsCreated, new_count: summary.newMatches, listings_updated: summary.listingsUpdated, price_drop_count: summary.priceDrops,
    warnings: [...input.warnings, ...summary.warnings].slice(0, 100), error_message: null,
  }).eq("id", sourceScanId).in("status", ["pending", "running"]);
  if (scan.error) throw new Error(`FACEBOOK_SOURCE_SCAN_FINALIZE_FAILED: ${scan.error.message}`);
  const job = await supabase.from("facebook_scan_jobs").update({ status: "completed", finished_at: now, leased_until: null, heartbeat_at: now, result_summary: result, error_code: null, error_message: null })
    .eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("status", "running");
  if (job.error) throw new Error(`FACEBOOK_JOB_FINALIZE_FAILED: ${job.error.message}`);
  await supabase.from("watched_facebook_groups").update({ access_status: "CONNECTED", last_checked_at: now, last_error: null }).eq("id", groups[0].id);
  return result;
}

export async function failFacebookJob(input: { jobId: string; leaseToken: string; workerId: string; errorCode: FacebookFailureCode | string; errorMessage: string }): Promise<void> {
  const supabase = createFacebookWatcherAdminClient(); const now = new Date().toISOString();
  const job = await supabase.from("facebook_scan_jobs").update({ status: "failed", finished_at: now, leased_until: null, heartbeat_at: now, error_code: input.errorCode.slice(0, 100), error_message: input.errorMessage.slice(0, 1_000) })
    .eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("worker_id", input.workerId).eq("status", "running").select("source_scan_id,group_snapshot").maybeSingle();
  if (job.error || !job.data) throw new Error("FACEBOOK_JOB_LEASE_LOST");
  await supabase.from("source_scans").update({ status: "failed", finished_at: now, error_message: `${input.errorCode}: ${input.errorMessage}`.slice(0, 1_000) }).eq("id", job.data.source_scan_id).in("status", ["pending", "running"]);
  const groups = parseFacebookGroupSnapshot(job.data.group_snapshot);
  const accessStatus = input.errorCode === "FACEBOOK_LOGIN_REQUIRED" || input.errorCode === "FACEBOOK_SESSION_EXPIRED" || input.errorCode === "FACEBOOK_CHALLENGE" ? "AUTH_REQUIRED" : "UNAVAILABLE";
  await supabase.from("watched_facebook_groups").update({ access_status: accessStatus, last_checked_at: now, last_error: input.errorMessage.slice(0, 1_000) }).eq("id", groups[0].id);
}

export function parseFacebookFailurePayload(value: unknown) {
  const row = requireRow(value);
  return { jobId: requiredString(row.jobId), leaseToken: requiredString(row.leaseToken), workerId: requiredString(row.workerId), errorCode: requiredString(row.errorCode), errorMessage: requiredString(row.errorMessage) };
}

function isCompletionResult(value: unknown): value is FacebookCompletionResult { const row = asRow(value); return Boolean(row && row.source === "facebook" && row.status === "completed" && typeof row.fetched === "number" && typeof row.normalized === "number" && typeof row.durationMs === "number" && typeof row.postsReceived === "number" && typeof row.postsProcessed === "number" && typeof row.listingsCreated === "number" && typeof row.listingsUpdated === "number" && typeof row.listingsSkipped === "number" && typeof row.matched === "number" && typeof row.newMatches === "number" && typeof row.extractionFailed === "number" && typeof row.imagesMirrored === "number" && typeof row.priceDrops === "number" && typeof row.errors === "number"); }
function parseStoredFilter(value: unknown, expectedId: string): SearchFilter { const row = asRow(value); if (!row || row.id !== expectedId || !Array.isArray(row.sources) || !row.sources.includes("facebook")) throw new Error("FACEBOOK_FILTER_SNAPSHOT_INVALID"); return value as SearchFilter; }
function asRow(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function requireRow(value: unknown): Row { const row = asRow(value); if (!row) throw new Error("INVALID_PAYLOAD"); return row; }
function requiredString(value: unknown): string { if (typeof value !== "string" || !value.trim()) throw new Error("INVALID_PAYLOAD"); return value.trim(); }
function nonnegativeInteger(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("INVALID_PAYLOAD"); return value; }
