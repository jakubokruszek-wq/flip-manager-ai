import "server-only";

import { createHash } from "node:crypto";

import { processFacebookPostBatch } from "@/features/facebook-worker/post-flow";
import { importFacebookWatcher } from "@/features/facebook-watcher/server";
import type { SearchFilter } from "@/features/flip-finder";
import { getActiveSearchFiltersForSource } from "@/features/flip-finder/server/search-filters";
import { createAdminClient } from "@/lib/supabase/admin";

import type { FacebookCollectorBatch } from "./facebook-batch";
import { COLLECTOR_IMAGE_IMPORT_OPTIONS, collectorPostsForProcessing, findHistoricalCollectorIdentityConflicts } from "./facebook-batch-policy";
import { isFacebookProductionSource } from "./facebook-production";

export { FACEBOOK_PRODUCTION_SOURCE_ID, FACEBOOK_PRODUCTION_SOURCE_URL } from "./facebook-production";

export type CollectorBatchResult = {
  status: "completed" | "degraded" | "failed" | "duplicate";
  batchId: string;
  captured: number;
  processed: number;
  listingsCreated: number;
  listingsUpdated: number;
  skipped: number;
  errors: number;
  sourceScanIds: string[];
  health: FacebookCollectorBatch["health"];
};

export async function processFacebookCollectorBatch(deviceId: string, batch: FacebookCollectorBatch): Promise<CollectorBatchResult> {
  if (!isFacebookProductionSource({ sourceId: batch.sourceId, type: batch.sourceType, url: batch.sourceUrl })) throw new Error("COLLECTOR_SOURCE_NOT_IN_PRODUCTION_ALLOWLIST");
  const supabase = createAdminClient();
  const existing = await supabase.from("collector_scan_batches").select("status,result").eq("device_id", deviceId).eq("batch_id", batch.batchId).maybeSingle();
  if (existing.error) throw new Error(`COLLECTOR_BATCH_LOOKUP_FAILED: ${existing.error.message}`);
  if (existing.data && typeof existing.data === "object" && existing.data.status !== "failed") {
    const previous = record(existing.data.result);
    return previous ? { ...previous, status: "duplicate" } as CollectorBatchResult : emptyResult(batch, "duplicate");
  }

  const inserted = await supabase.from("collector_scan_batches").insert({
    device_id: deviceId,
    scan_id: batch.scanId,
    batch_id: batch.batchId,
    source_id: batch.sourceId,
    source_type: batch.sourceType,
    source_url: batch.sourceUrl,
    status: "processing",
    health_status: batch.health.status,
    visible_card_count: batch.health.visibleCardCount,
    captured_post_count: batch.health.capturedPostCount,
    capture_ratio: batch.health.captureRatio,
    payload: batchForStorage(batch),
  }).select("id").single();
  if (inserted.error) {
    if (inserted.error.code === "23505") {
      const duplicate = await supabase.from("collector_scan_batches").select("result").eq("device_id", deviceId).eq("batch_id", batch.batchId).maybeSingle();
      const previous = record(duplicate.data?.result);
      return previous ? { ...previous, status: "duplicate" } as CollectorBatchResult : emptyResult(batch, "duplicate");
    }
    throw new Error(`COLLECTOR_BATCH_CREATE_FAILED: ${inserted.error.message}`);
  }

  const batchRowId = String(inserted.data.id);
  if (batch.health.status === "FAILED") return finishBatch(supabase, deviceId, batchRowId, batch, emptyResult(batch, "failed"), "COLLECTOR_DISCOVERY_FAILED");

  try {
    const existingScan = await supabase.from("source_scans")
      .select("id,search_filter_id,filter_snapshot,status,warnings")
      .eq("scan_run_id", batch.scanId)
      .eq("source", "facebook")
      .in("status", ["pending", "running"])
      .order("started_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (existingScan.error) throw new Error(`COLLECTOR_SOURCE_SCAN_LOOKUP_FAILED: ${existingScan.error.message}`);
    const existingScanRow = record(existingScan.data);
    const targets: Array<{ filter: SearchFilter; sourceScanId: string | null; existingWarnings: string[] }> = existingScanRow
      ? [{ filter: filterFromSnapshot(existingScanRow.filter_snapshot, String(existingScanRow.search_filter_id)), sourceScanId: String(existingScanRow.id), existingWarnings: stringArray(existingScanRow.warnings) }]
      : (await getActiveSearchFiltersForSource("facebook")).map((filter) => ({ filter, sourceScanId: null, existingWarnings: [] }));
    if (targets.length === 0) return finishBatch(supabase, deviceId, batchRowId, batch, emptyResult(batch, "failed"), "COLLECTOR_NO_ACTIVE_FACEBOOK_FILTER");
    const history = await supabase.from("collector_scan_batches").select("payload").eq("source_id", batch.sourceId).neq("id", batchRowId).order("received_at", { ascending: false }).limit(50);
    if (history.error) throw new Error(`COLLECTOR_IDENTITY_HISTORY_QUERY_FAILED: ${history.error.message}`);
    const historicalIdentityConflicts = findHistoricalCollectorIdentityConflicts(batch, (history.data ?? []).map((row) => row.payload));
    const sourceScanIds: string[] = [];
    let processed = 0; let listingsCreated = 0; let listingsUpdated = 0; let skipped = 0; let errors = 0;
    const posts = collectorPostsForProcessing(batch, Date.now(), historicalIdentityConflicts);
    const unverifiedIdentityCount = batch.posts.filter((post) => post.identityConfidence !== "EXACT" || historicalIdentityConflicts.has(post.postId)).length;
    const authors = new Map(batch.posts.map((post) => [post.postId, post.author]));
    for (const target of targets) {
      const filter = target.filter;
      let sourceScanId = target.sourceScanId;
      if (!sourceScanId) {
        const sourceScan = await supabase.from("source_scans").insert({ search_filter_id: filter.id, source: "facebook", status: "running", scan_run_id: batch.scanId, filter_snapshot: filter, diagnostics: [{ collectorBatchId: batch.batchId, discoveryHealth: batch.health.status }] }).select("id").single();
        if (sourceScan.error || !sourceScan.data?.id) throw new Error(`COLLECTOR_SOURCE_SCAN_CREATE_FAILED: ${sourceScan.error?.message ?? "missing id"}`);
        sourceScanId = String(sourceScan.data.id);
      } else {
        const sourceScan = await supabase.from("source_scans").update({ status: "running", error_message: null, diagnostics: [{ collectorBatchId: batch.batchId, discoveryHealth: batch.health.status }] }).eq("id", sourceScanId).in("status", ["pending", "running"]);
        if (sourceScan.error) throw new Error(`COLLECTOR_SOURCE_SCAN_START_FAILED: ${sourceScan.error.message}`);
      }
      sourceScanIds.push(sourceScanId);
      const summary = await processFacebookPostBatch(posts, (post) => importFacebookWatcher({ url: post.permalink ?? undefined, postText: post.authoritativePostText ?? post.text, authorName: post.postId ? authors.get(post.postId) ?? undefined : undefined, groupName: batch.sourceId, publishedAt: post.publishedAt ?? undefined, images: [], mediaCandidates: [], discoverySource: post.discoverySource, searchQuery: post.searchQuery, searchQueries: post.searchQueries, foundInMainFeed: post.foundInMainFeed, firstSeenPhase: post.firstSeenPhase }, { filter, sourceScanId, groupId: batch.sourceId, groupName: batch.sourceId, groupUrl: batch.sourceUrl, postId: post.postId, checkedAt: batch.collectedAt, ...COLLECTOR_IMAGE_IMPORT_OPTIONS }), { jobId: `collector:${batch.batchId}`, sourceScanId });
      processed = Math.max(processed, summary.postsProcessed);
      listingsCreated += summary.listingsCreated;
      listingsUpdated += summary.listingsUpdated;
      skipped += summary.listingsSkipped;
      errors += summary.errors;
      const sourceStatus = batch.health.status === "DEGRADED" || summary.errors > 0 || unverifiedIdentityCount > 0 ? "partial" : "completed";
      const identityWarnings = unverifiedIdentityCount > 0 ? [`FACEBOOK_IDENTITY_UNVERIFIED:${unverifiedIdentityCount}`, ...[...historicalIdentityConflicts].slice(0, 20).map((postId) => `FACEBOOK_IDENTITY_HISTORY_CONFLICT:${postId}`)] : [];
      const sourceUpdate = await supabase.from("source_scans").update({ status: sourceStatus, finished_at: new Date().toISOString(), scanned_count: batch.posts.length, matched_count: summary.matched, listings_found: summary.listingsCreated + summary.listingsUpdated, listings_created: summary.listingsCreated, new_count: summary.listingsCreated, listings_updated: summary.listingsUpdated, price_drop_count: summary.priceDrops, warnings: [...target.existingWarnings, ...batch.health.reasons, ...identityWarnings, ...summary.warnings].slice(0, 100), error_message: null }).eq("id", sourceScanId);
      if (sourceUpdate.error) throw new Error(`COLLECTOR_SOURCE_SCAN_FINISH_FAILED: ${sourceUpdate.error.message}`);
    }
    const status = batch.health.status === "DEGRADED" || errors > 0 || unverifiedIdentityCount > 0 ? "degraded" : "completed";
    return finishBatch(supabase, deviceId, batchRowId, batch, { status, batchId: batch.batchId, captured: batch.posts.length, processed, listingsCreated, listingsUpdated, skipped, errors, sourceScanIds, health: batch.health });
  } catch (error) {
    return finishBatch(supabase, deviceId, batchRowId, batch, emptyResult(batch, "failed"), safeMessage(error));
  }
}

async function finishBatch(supabase: ReturnType<typeof createAdminClient>, deviceId: string, rowId: string, batch: FacebookCollectorBatch, result: CollectorBatchResult, errorMessage?: string): Promise<CollectorBatchResult> {
  const now = new Date().toISOString();
  const update = await supabase.from("collector_scan_batches").update({ status: result.status === "duplicate" ? "completed" : result.status, result, error_message: errorMessage ?? null, finished_at: now }).eq("id", rowId);
  if (update.error) throw new Error(`COLLECTOR_BATCH_FINISH_FAILED: ${update.error.message}`);
  const device = await supabase.from("collector_devices").update({ last_source_scan_at: now, last_captured_count: batch.posts.length, health_status: batch.health.status }).eq("id", deviceId);
  if (device.error) throw new Error(`COLLECTOR_DEVICE_HEALTH_UPDATE_FAILED: ${device.error.message}`);
  return result;
}

function batchForStorage(batch: FacebookCollectorBatch): Record<string, unknown> {
  return { scanId: batch.scanId, batchId: batch.batchId, sourceId: batch.sourceId, sourceType: batch.sourceType, sourceUrl: batch.sourceUrl, collectedAt: batch.collectedAt, health: batch.health, searchTelemetry: batch.searchTelemetry, mainFeedTelemetry: batch.mainFeedTelemetry ?? [], posts: batch.posts.map((post) => ({ ...post, textHash: post.text ? createHash("sha256").update(post.text).digest("hex") : null, text: post.text?.slice(0, 20_000) ?? null, media: post.media.map((media) => ({ ...media, url: media.url.slice(0, 2_000) })) })) };
}

function emptyResult(batch: FacebookCollectorBatch, status: CollectorBatchResult["status"]): CollectorBatchResult { return { status, batchId: batch.batchId, captured: batch.posts.length, processed: 0, listingsCreated: 0, listingsUpdated: 0, skipped: 0, errors: status === "failed" ? 1 : 0, sourceScanIds: [], health: batch.health }; }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function filterFromSnapshot(value: unknown, expectedId: string): SearchFilter {
  const snapshot = record(value);
  if (!snapshot || snapshot.id !== expectedId || !Array.isArray(snapshot.sources) || !snapshot.sources.includes("facebook")) throw new Error("COLLECTOR_FILTER_SNAPSHOT_INVALID");
  return value as SearchFilter;
}
function safeMessage(value: unknown): string { return value instanceof Error ? value.message.slice(0, 500) : "COLLECTOR_BATCH_FAILED"; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
