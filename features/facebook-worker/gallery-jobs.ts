import "server-only";

import { createFacebookWatcherAdminClient } from "./../facebook-watcher/supabase-admin";
import { mirrorFacebookImages } from "../facebook-watcher/server/mirror-facebook-images";
import { validateFacebookRevalidationCandidates } from "./image-revalidation";
import type { FacebookMediaCandidate } from "./types";
import { galleryMediaIds as collectGalleryMediaIds, selectMissingGalleryCandidates } from "./gallery-policy";

export type FacebookGalleryStatus = "NOT_REQUESTED" | "PENDING" | "RUNNING" | "PARTIAL" | "COMPLETE" | "FAILED";

export type FacebookGalleryJobResult = {
  jobId: string;
  listingId: string;
  postId: string;
  status: Exclude<FacebookGalleryStatus, "NOT_REQUESTED" | "PENDING" | "RUNNING">;
  sourceMediaCount: number;
  exactMediaCount: number;
  alreadyStored: number;
  downloadRequired: number;
  downloaded: number;
  storageSuccess: number;
  persistedTotal: number;
  errorCode?: string | null;
};

export type FacebookGalleryStatusResult = {
  listingId: string;
  status: FacebookGalleryStatus;
  jobId: string | null;
  total: number;
  persistedCount: number;
  error: string | null;
};

type Row = Record<string, unknown>;

export async function enqueueFacebookGalleryJob(listingId: string): Promise<{ jobId: string | null; status: FacebookGalleryStatus; listingId: string; message?: string }> {
  const supabase = createFacebookWatcherAdminClient();
  const listingResult = await supabase.from("listings").select("id,source,external_listing_id,original_url,gallery_status,gallery_job_id,lifecycle_status,manual_decision").eq("id", listingId).maybeSingle();
  const listing = row(listingResult.data);
  if (listingResult.error || !listing || listing.source !== "facebook") throw new Error("FACEBOOK_GALLERY_LISTING_NOT_FOUND");
  if (listing.lifecycle_status === "REJECTED" || listing.lifecycle_status === "ARCHIVED" || listing.lifecycle_status === "STALE" || listing.manual_decision === "REJECTED") throw new Error("FACEBOOK_GALLERY_LISTING_NOT_ELIGIBLE");
  const postId = string(listing.external_listing_id);
  const sourceUrl = safeFacebookPostUrl(listing.original_url);
  if (!postId || !sourceUrl) throw new Error("FACEBOOK_GALLERY_EXACT_POST_REQUIRED");
  const currentStatus = galleryStatus(listing.gallery_status);
  if (currentStatus === "COMPLETE") return { jobId: string(listing.gallery_job_id), status: "COMPLETE", listingId };

  const existing = await supabase.from("facebook_scan_jobs").select("id,status").eq("job_type", "GALLERY_HYDRATION").eq("gallery_listing_id", listingId).in("status", ["queued", "running"]).maybeSingle();
  if (existing.error) throw new Error(`FACEBOOK_GALLERY_JOB_QUERY_FAILED: ${existing.error.message}`);
  if (existing.data?.id) {
    const jobId = String(existing.data.id);
    await supabase.from("listings").update({ gallery_status: existing.data.status === "running" ? "RUNNING" : "PENDING", gallery_job_id: jobId, gallery_requested_at: new Date().toISOString(), gallery_error: null }).eq("id", listingId);
    return { jobId, status: existing.data.status === "running" ? "RUNNING" : "PENDING", listingId };
  }

  const match = await supabase.from("listing_filter_matches").select("search_filter_id").eq("listing_id", listingId).order("last_matched_at", { ascending: false }).limit(1).maybeSingle();
  if (match.error || !match.data?.search_filter_id) throw new Error("FACEBOOK_GALLERY_FILTER_CONTEXT_MISSING");
  const idempotencyKey = `gallery:${listingId}`;
  const inserted = await supabase.from("facebook_scan_jobs").insert({
    scan_run_id: crypto.randomUUID(), source_scan_id: null, search_filter_id: match.data.search_filter_id,
    group_snapshot: [], idempotency_key: idempotencyKey, consumer_type: "BROWSER_EXTENSION",
    job_type: "GALLERY_HYDRATION", priority: 100, gallery_listing_id: listingId,
    gallery_post_id: postId, gallery_source_url: sourceUrl,
  }).select("id").single();
  if (inserted.error || !inserted.data?.id) {
    if (inserted.error?.code === "23505") {
      const retry = await supabase.from("facebook_scan_jobs").select("id,status").eq("job_type", "GALLERY_HYDRATION").eq("gallery_listing_id", listingId).in("status", ["queued", "running"]).maybeSingle();
      if (retry.data?.id) return { jobId: String(retry.data.id), status: retry.data.status === "running" ? "RUNNING" : "PENDING", listingId };
    }
    throw new Error(`FACEBOOK_GALLERY_JOB_CREATE_FAILED: ${inserted.error?.message ?? "missing id"}`);
  }
  const jobId = String(inserted.data.id);
  const update = await supabase.from("listings").update({ gallery_status: "PENDING", gallery_job_id: jobId, gallery_requested_at: new Date().toISOString(), gallery_completed_at: null, gallery_error: null }).eq("id", listingId);
  if (update.error) throw new Error(`FACEBOOK_GALLERY_LISTING_UPDATE_FAILED: ${update.error.message}`);
  return { jobId, status: "PENDING", listingId };
}

export async function getFacebookGalleryStatus(listingId: string): Promise<FacebookGalleryStatusResult> {
  const supabase = createFacebookWatcherAdminClient();
  const result = await supabase.from("listings").select("id,source,gallery_status,gallery_job_id,gallery_total,gallery_persisted_count,gallery_error").eq("id", listingId).maybeSingle();
  const listing = row(result.data);
  if (result.error || !listing || listing.source !== "facebook") throw new Error("FACEBOOK_GALLERY_LISTING_NOT_FOUND");
  return {
    listingId,
    status: galleryStatus(listing.gallery_status),
    jobId: string(listing.gallery_job_id),
    total: boundedCount(listing.gallery_total, 0),
    persistedCount: boundedCount(listing.gallery_persisted_count, 0),
    error: string(listing.gallery_error),
  };
}

export async function completeFacebookGalleryJob(input: {
  jobId: string;
  leaseToken: string;
  workerId: string;
  status: "completed" | "failed";
  errorCode?: string | null;
  gallery?: { status?: string; expectedPostId?: string; sourceMediaCount?: number; candidates?: unknown[] };
}): Promise<FacebookGalleryJobResult> {
  const supabase = createFacebookWatcherAdminClient();
  const jobResult = await supabase.from("facebook_scan_jobs").select("id,status,job_type,lease_token,worker_id,gallery_listing_id,gallery_post_id").eq("id", input.jobId).maybeSingle();
  const job = row(jobResult.data);
  if (jobResult.error || !job || job.job_type !== "GALLERY_HYDRATION" || job.status !== "running" || job.lease_token !== input.leaseToken || job.worker_id !== input.workerId) throw new Error("FACEBOOK_GALLERY_JOB_LEASE_LOST");
  const listingId = string(job.gallery_listing_id);
  const expectedPostId = string(job.gallery_post_id);
  if (!listingId || !expectedPostId) throw new Error("FACEBOOK_GALLERY_JOB_TARGET_INVALID");
  if (input.status === "failed") {
    await markGalleryFailed(supabase, input.jobId, listingId, input.errorCode ?? "FACEBOOK_GALLERY_FAILED");
    return { jobId: input.jobId, listingId, postId: expectedPostId, status: "FAILED", sourceMediaCount: 0, exactMediaCount: 0, alreadyStored: 0, downloadRequired: 0, downloaded: 0, storageSuccess: 0, persistedTotal: 0, errorCode: input.errorCode ?? "FACEBOOK_GALLERY_FAILED" };
  }
  if (input.gallery?.expectedPostId && input.gallery.expectedPostId !== expectedPostId) throw new Error("FACEBOOK_GALLERY_POST_ID_MISMATCH");
  const candidates = parseFacebookGalleryCandidates(input.gallery?.candidates, expectedPostId);
  const sourceMediaCount = boundedCount(input.gallery?.sourceMediaCount, candidates.length);
  const listingResult = await supabase.from("listings").select("images,original_url").eq("id", listingId).maybeSingle();
  const listing = row(listingResult.data);
  if (listingResult.error || !listing) throw new Error("FACEBOOK_GALLERY_LISTING_NOT_FOUND");
  const existingImages = stringArray(listing.images);
  const validation = validateFacebookRevalidationCandidates(candidates, expectedPostId);
  const exactMediaCount = validation.verified.length;
  const metadataResult = await supabase.from("listing_source_metadata").select("metadata").eq("listing_id", listingId).eq("source", "facebook").maybeSingle();
  if (metadataResult.error) throw new Error(`FACEBOOK_GALLERY_METADATA_READ_FAILED: ${metadataResult.error.message}`);
  const existingMetadata = row(metadataResult.data?.metadata) ?? {};
  const existingMediaIds = new Set(stringArray(existingMetadata.galleryMediaIds));
  const verifiedCandidates = validation.verified as FacebookMediaCandidate[];
  const existingSet = new Set(existingImages);
  const alreadyStored = verifiedCandidates.filter((candidate) => existingSet.has(candidate.url) || (candidate.mediaId ? existingMediaIds.has(candidate.mediaId) : false)).length;
  const downloadRequired = Math.max(0, exactMediaCount - alreadyStored);
  if (input.gallery?.status === "FAILED") {
    await markGalleryFailed(supabase, input.jobId, listingId, "FACEBOOK_GALLERY_CONTENT_FAILED");
    return { jobId: input.jobId, listingId, postId: expectedPostId, status: "FAILED", sourceMediaCount, exactMediaCount, alreadyStored, downloadRequired, downloaded: 0, storageSuccess: 0, persistedTotal: existingImages.length, errorCode: "FACEBOOK_GALLERY_CONTENT_FAILED" };
  }
  const missingCandidates = selectMissingGalleryCandidates(verifiedCandidates, existingMediaIds, existingSet);
  const mirrored = await mirrorFacebookImages({ listingId, imageUrls: missingCandidates.map((candidate) => candidate.url), existingImages, preserveExistingImages: true });
  const downloaded = Math.max(0, mirrored.stats.uploadedCount);
  const storageSuccess = downloaded;
  const persistedTotal = mirrored.images.length;
  const provenanceIncomplete = sourceMediaCount > exactMediaCount;
  const status: "PARTIAL" | "COMPLETE" = mirrored.stats.failedCount > 0 || provenanceIncomplete ? "PARTIAL" : "COMPLETE";
  const errorCode = mirrored.stats.failedCount > 0 ? "FACEBOOK_GALLERY_STORAGE_PARTIAL" : provenanceIncomplete ? "FACEBOOK_GALLERY_PROVENANCE_PARTIAL" : null;
  const now = new Date().toISOString();
  await supabase.from("listings").update({ images: mirrored.images, gallery_status: status, gallery_completed_at: now, gallery_total: Math.max(sourceMediaCount, exactMediaCount, persistedTotal), gallery_persisted_count: persistedTotal, gallery_error: errorCode }).eq("id", listingId);
  const sourcePostUrl = safeFacebookPostUrl(listing.original_url);
  if (sourcePostUrl) {
    const nextMediaIds = [...new Set([...existingMediaIds, ...collectGalleryMediaIds(verifiedCandidates)])];
    const metadata = await supabase.from("listing_source_metadata").upsert({ listing_id: listingId, source: "facebook", source_post_url: sourcePostUrl, collected_at: now, metadata: { ...existingMetadata, galleryMediaIds: nextMediaIds, galleryStatus: status, galleryUpdatedAt: now } }, { onConflict: "source,source_post_url" });
    if (metadata.error) throw new Error(`FACEBOOK_GALLERY_METADATA_PERSIST_FAILED: ${metadata.error.message}`);
  }
  const result: FacebookGalleryJobResult = { jobId: input.jobId, listingId, postId: expectedPostId, status, sourceMediaCount, exactMediaCount, alreadyStored, downloadRequired, downloaded, storageSuccess, persistedTotal, errorCode };
  const finished = await supabase.from("facebook_scan_jobs").update({ status: "completed", finished_at: now, leased_until: null, heartbeat_at: now, result_summary: { kind: "GALLERY_HYDRATION", ...result }, error_code: errorCode, error_message: errorCode }).eq("id", input.jobId).eq("status", "running").eq("lease_token", input.leaseToken).eq("worker_id", input.workerId);
  if (finished.error) throw new Error(`FACEBOOK_GALLERY_JOB_FINALIZE_FAILED: ${finished.error.message}`);
  return result;
}

async function markGalleryFailed(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, jobId: string, listingId: string, errorCode: string): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("listings").update({ gallery_status: "FAILED", gallery_completed_at: now, gallery_error: errorCode }).eq("id", listingId);
  const finished = await supabase.from("facebook_scan_jobs").update({ status: "failed", finished_at: now, leased_until: null, heartbeat_at: now, error_code: errorCode, error_message: errorCode }).eq("id", jobId).eq("status", "running");
  if (finished.error) throw new Error(`FACEBOOK_GALLERY_JOB_FINALIZE_FAILED: ${finished.error.message}`);
}

export function parseFacebookGalleryCandidates(value: unknown, expectedPostId: string): FacebookMediaCandidate[] {
  if (!Array.isArray(value) || value.length > 50) return [];
  return value.flatMap((entry): FacebookMediaCandidate[] => {
    const item = row(entry);
    if (!item || typeof item.url !== "string" || item.expectedPostId !== expectedPostId || item.storyRootPostId !== expectedPostId || item.boundPostId !== expectedPostId || item.bindingProvenance !== "EXACT_ROOT_STORY" || item.rootStoryUnique !== true || !Array.isArray(item.foreignPostIdsDetected) || item.foreignPostIdsDetected.length > 0) return [];
    return [{ url: item.url.slice(0, 2_000), mediaId: string(item.mediaId), expectedPostId, storyRootPostId: expectedPostId, boundPostId: expectedPostId, bindingConfidence: 1, bindingProvenance: "EXACT_ROOT_STORY", rootStoryUnique: true, foreignPostIdsDetected: [], classification: "PROPERTY_IMAGE", classificationConfidence: 0.95, structuredPostMediaProvenance: false }];
  });
}

function safeFacebookPostUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && /(^|\.)facebook\.com$/i.test(url.hostname) && /\/groups\/[^/]+\/permalink\/\d+/i.test(url.pathname) ? url.toString() : null; } catch { return null; }
}
function galleryStatus(value: unknown): FacebookGalleryStatus { return value === "PENDING" || value === "RUNNING" || value === "PARTIAL" || value === "COMPLETE" || value === "FAILED" ? value : "NOT_REQUESTED"; }
function boundedCount(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(50, Math.floor(value)) : fallback; }
function row(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : []; }
