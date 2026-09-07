import "server-only";

import { createFacebookWatcherAdminClient } from "./../facebook-watcher/supabase-admin";
import { mirrorFacebookImages } from "../facebook-watcher/server/mirror-facebook-images";
import { validateFacebookRevalidationCandidates } from "./image-revalidation";
import type { FacebookMediaCandidate } from "./types";
import { galleryMediaIds as collectGalleryMediaIds, selectMissingGalleryCandidates } from "./gallery-policy";
import { safeFacebookPostUrl } from "./facebook-post-url";

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
  diagnostics?: GalleryFailureDiagnostics | null;
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
type GalleryFailureDiagnostics = {
  elapsedMs?: number;
  currentPath?: string | null;
  expectedPostId?: string | null;
  expectedGroup?: string | null;
  resolvedGroup?: string | null;
  rootBindingSource?: string | null;
  rootCount?: number;
  networkResponses?: number;
  networkRecordCount?: number;
  networkRecordPostIds?: string[];
  expectedRecord?: {
    postId?: string;
    sourceType?: string;
    sourceId?: string;
    identityConfidence?: string;
    permalinkPath?: string | null;
    authorFound?: boolean;
    rootTextFound?: boolean;
    mediaCount?: number;
    exactMediaCount?: number;
  } | null;
  [key: string]: unknown;
};

export async function enqueueFacebookGalleryJob(listingId: string): Promise<{ jobId: string | null; status: FacebookGalleryStatus; listingId: string; created?: boolean; message?: string }> {
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

  const match = await supabase.from("listing_filter_matches").select("search_filter_id").eq("listing_id", listingId).order("last_matched_at", { ascending: false }).limit(1).maybeSingle();
  if (match.error || !match.data?.search_filter_id) throw new Error("FACEBOOK_GALLERY_FILTER_CONTEXT_MISSING");
  const enqueue = await supabase.rpc("enqueue_facebook_gallery_job", {
    p_listing_id: listingId,
    p_search_filter_id: match.data.search_filter_id,
    p_post_id: postId,
    p_source_url: sourceUrl,
  }).single();
  if (enqueue.error || !enqueue.data) throw new Error(`FACEBOOK_GALLERY_JOB_CREATE_FAILED: ${enqueue.error?.message ?? "missing result"}`);
  const result = row(enqueue.data);
  const jobId = string(result?.job_id);
  const status = galleryStatus(result?.gallery_status);
  if ((status === "PENDING" || status === "RUNNING") && !jobId) throw new Error("FACEBOOK_GALLERY_JOB_CREATE_FAILED: missing job id");
  return { jobId, status, listingId, created: result?.job_created === true };
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
  gallery?: { status?: string; expectedPostId?: string; sourceMediaCount?: number; candidates?: unknown[]; diagnostics?: unknown };
}): Promise<FacebookGalleryJobResult> {
  const supabase = createFacebookWatcherAdminClient();
  const jobResult = await supabase.from("facebook_scan_jobs").select("id,status,job_type,lease_token,worker_id,gallery_listing_id,gallery_post_id").eq("id", input.jobId).maybeSingle();
  const job = row(jobResult.data);
  if (jobResult.error || !job || job.job_type !== "GALLERY_HYDRATION" || job.status !== "running" || job.lease_token !== input.leaseToken || job.worker_id !== input.workerId) throw new Error("FACEBOOK_GALLERY_JOB_LEASE_LOST");
  const listingId = string(job.gallery_listing_id);
  const expectedPostId = string(job.gallery_post_id);
  if (!listingId || !expectedPostId) throw new Error("FACEBOOK_GALLERY_JOB_TARGET_INVALID");
  if (input.status === "failed") {
    // A gallery page can be unavailable to the bounded content-script
    // resolver even though the source scan already persisted authoritative,
    // exact-root media provenance for this same post. Reuse only that
    // provenance; never infer media from a photo id, neighbour story, or
    // unverified URL. This keeps gallery hydration fail-closed while making
    // the explicit user action useful for media already proven at scan time.
    if (input.errorCode === "FACEBOOK_GALLERY_ROOT_NOT_FOUND") {
      const recovered = await recoverGalleryFromExactMetadata({ supabase, jobId: input.jobId, leaseToken: input.leaseToken, workerId: input.workerId, listingId, expectedPostId });
      if (recovered) return recovered;
    }
    const errorCode = input.errorCode ?? "FACEBOOK_GALLERY_FAILED";
    const diagnostics = sanitizeGalleryDiagnostics(input.gallery?.diagnostics);
    await markGalleryFailed(supabase, input.jobId, listingId, errorCode, diagnostics);
    return { jobId: input.jobId, listingId, postId: expectedPostId, status: "FAILED", sourceMediaCount: 0, exactMediaCount: 0, alreadyStored: 0, downloadRequired: 0, downloaded: 0, storageSuccess: 0, persistedTotal: 0, errorCode, diagnostics };
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

async function recoverGalleryFromExactMetadata(input: {
  supabase: ReturnType<typeof createFacebookWatcherAdminClient>;
  jobId: string;
  leaseToken: string;
  workerId: string;
  listingId: string;
  expectedPostId: string;
}): Promise<FacebookGalleryJobResult | null> {
  const metadataResult = await input.supabase.from("listing_source_metadata").select("metadata").eq("listing_id", input.listingId).eq("source", "facebook").maybeSingle();
  if (metadataResult.error) return null;
  const metadata = row(metadataResult.data?.metadata) ?? {};
  const candidates = exactMetadataCandidates(metadata.mediaProvenance, input.expectedPostId);
  if (candidates.length === 0) return null;
  const listingResult = await input.supabase.from("listings").select("images,original_url").eq("id", input.listingId).maybeSingle();
  const listing = row(listingResult.data);
  if (listingResult.error || !listing) return null;
  const existingImages = stringArray(listing.images);
  const existingMediaIds = new Set(stringArray(metadata.galleryMediaIds));
  return persistVerifiedGallery({
    supabase: input.supabase,
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    workerId: input.workerId,
    listingId: input.listingId,
    expectedPostId: input.expectedPostId,
    sourceMediaCount: candidates.length,
    candidates,
    existingImages,
    existingMediaIds,
    metadata,
    sourceUrl: safeFacebookPostUrl(listing.original_url),
    recoveryReason: "EXACT_ROOT_STORY_METADATA_REUSE",
  });
}

function exactMetadataCandidates(value: unknown, expectedPostId: string): FacebookMediaCandidate[] {
  if (!Array.isArray(value) || value.length > 50) return [];
  return value.flatMap((entry): FacebookMediaCandidate[] => {
    const item = row(entry);
    const url = string(item?.normalizedMediaUrl);
    const sourcePostId = string(item?.sourcePostId);
    const storyRootPostId = string(item?.storyRootPostId);
    const bindingMethod = string(item?.bindingMethod);
    const classification = string(item?.classification);
    const confidence = typeof item?.bindingConfidence === "number" && Number.isFinite(item.bindingConfidence) ? item.bindingConfidence : 0;
    if (!url || !/^https:\/\/scontent[^/]*\.fbcdn\.net\//i.test(url) || sourcePostId !== expectedPostId || storyRootPostId !== expectedPostId || bindingMethod !== "EXACT_ROOT_STORY" || confidence < 0.9 || classification !== "PROPERTY_IMAGE") return [];
    const mediaId = string(item?.mediaId);
    return [{ url: url.slice(0, 2_000), mediaId, expectedPostId, storyRootPostId: expectedPostId, boundPostId: expectedPostId, bindingConfidence: Math.min(1, confidence), bindingProvenance: "EXACT_ROOT_STORY", rootStoryUnique: true, foreignPostIdsDetected: [], classification: "PROPERTY_IMAGE", classificationConfidence: 0.95, structuredPostMediaProvenance: true }];
  });
}

async function persistVerifiedGallery(input: {
  supabase: ReturnType<typeof createFacebookWatcherAdminClient>;
  jobId: string;
  leaseToken: string;
  workerId: string;
  listingId: string;
  expectedPostId: string;
  sourceMediaCount: number;
  candidates: FacebookMediaCandidate[];
  existingImages: string[];
  existingMediaIds: Set<string>;
  metadata: Row;
  sourceUrl: string | null;
  recoveryReason?: string;
}): Promise<FacebookGalleryJobResult> {
  const validation = validateFacebookRevalidationCandidates(input.candidates, input.expectedPostId);
  const verifiedCandidates = validation.verified as FacebookMediaCandidate[];
  const exactMediaCount = verifiedCandidates.length;
  const existingSet = new Set(input.existingImages);
  const alreadyStored = verifiedCandidates.filter((candidate) => existingSet.has(candidate.url) || (candidate.mediaId ? input.existingMediaIds.has(candidate.mediaId) : false)).length;
  const downloadRequired = Math.max(0, exactMediaCount - alreadyStored);
  const missingCandidates = selectMissingGalleryCandidates(verifiedCandidates, input.existingMediaIds, existingSet);
  const mirrored = await mirrorFacebookImages({ listingId: input.listingId, imageUrls: missingCandidates.map((candidate) => candidate.url), existingImages: input.existingImages, preserveExistingImages: true });
  const downloaded = Math.max(0, mirrored.stats.uploadedCount);
  const storageSuccess = downloaded;
  const status: "PARTIAL" | "COMPLETE" = mirrored.stats.failedCount > 0 || input.sourceMediaCount > exactMediaCount || Boolean(input.recoveryReason) ? "PARTIAL" : "COMPLETE";
  const errorCode = mirrored.stats.failedCount > 0 ? "FACEBOOK_GALLERY_STORAGE_PARTIAL" : input.sourceMediaCount > exactMediaCount ? "FACEBOOK_GALLERY_PROVENANCE_PARTIAL" : input.recoveryReason ? "FACEBOOK_GALLERY_ROOT_NOT_AVAILABLE_METADATA_REUSE" : null;
  const now = new Date().toISOString();
  await input.supabase.from("listings").update({ images: mirrored.images, gallery_status: status, gallery_completed_at: now, gallery_total: Math.max(input.sourceMediaCount, exactMediaCount, mirrored.images.length), gallery_persisted_count: mirrored.images.length, gallery_error: errorCode }).eq("id", input.listingId);
  if (input.sourceUrl) {
    const nextMediaIds = [...new Set([...input.existingMediaIds, ...collectGalleryMediaIds(verifiedCandidates)])];
    const metadata = await input.supabase.from("listing_source_metadata").upsert({ listing_id: input.listingId, source: "facebook", source_post_url: input.sourceUrl, collected_at: now, metadata: { ...input.metadata, galleryMediaIds: nextMediaIds, galleryStatus: status, galleryUpdatedAt: now } }, { onConflict: "source,source_post_url" });
    if (metadata.error) throw new Error(`FACEBOOK_GALLERY_METADATA_PERSIST_FAILED: ${metadata.error.message}`);
  }
  const result: FacebookGalleryJobResult = { jobId: input.jobId, listingId: input.listingId, postId: input.expectedPostId, status, sourceMediaCount: input.sourceMediaCount, exactMediaCount, alreadyStored, downloadRequired, downloaded, storageSuccess, persistedTotal: mirrored.images.length, errorCode, diagnostics: input.recoveryReason ? { rootBindingSource: input.recoveryReason, rootCount: 1, expectedPostId: input.expectedPostId, exactMediaCount, mediaCount: input.sourceMediaCount } : null };
  const finished = await input.supabase.from("facebook_scan_jobs").update({ status: "completed", finished_at: now, leased_until: null, heartbeat_at: now, result_summary: { kind: "GALLERY_HYDRATION", ...result }, error_code: errorCode, error_message: errorCode }).eq("id", input.jobId).eq("status", "running").eq("lease_token", input.leaseToken).eq("worker_id", input.workerId);
  if (finished.error) throw new Error(`FACEBOOK_GALLERY_JOB_FINALIZE_FAILED: ${finished.error.message}`);
  return result;
}

async function markGalleryFailed(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, jobId: string, listingId: string, errorCode: string, diagnostics: GalleryFailureDiagnostics | null = null): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("listings").update({ gallery_status: "FAILED", gallery_completed_at: now, gallery_error: errorCode }).eq("id", listingId);
  const finished = await supabase.from("facebook_scan_jobs").update({ status: "failed", finished_at: now, leased_until: null, heartbeat_at: now, result_summary: { kind: "GALLERY_HYDRATION", status: "FAILED", errorCode, diagnostics }, error_code: errorCode, error_message: errorCode }).eq("id", jobId).eq("status", "running");
  if (finished.error) throw new Error(`FACEBOOK_GALLERY_JOB_FINALIZE_FAILED: ${finished.error.message}`);
}

function sanitizeGalleryDiagnostics(value: unknown): GalleryFailureDiagnostics | null {
  const input = row(value);
  if (!input) return null;
  const number = (key: string, max: number) => typeof input[key] === "number" && Number.isFinite(input[key]) ? Math.max(0, Math.min(max, Math.floor(input[key] as number))) : undefined;
  const text = (key: string, max: number) => typeof input[key] === "string" && (input[key] as string).trim() ? (input[key] as string).slice(0, max) : null;
  const bool = (key: string) => typeof input[key] === "boolean" ? input[key] as boolean : undefined;
  const rawIds = Array.isArray(input.networkRecordPostIds) ? input.networkRecordPostIds : [];
  const expected = row(input.expectedRecord);
  return {
    elapsedMs: number("elapsedMs", 120_000),
    currentPath: text("currentPath", 500),
    expectedPostId: text("expectedPostId", 30),
    expectedGroup: text("expectedGroup", 120),
    resolvedGroup: text("resolvedGroup", 120),
    rootBindingSource: text("rootBindingSource", 80),
    rootCount: number("rootCount", 50),
    networkResponses: number("networkResponses", 200),
    networkRecordCount: number("networkRecordCount", 200),
    networkRecordPostIds: rawIds.filter((id): id is string => typeof id === "string" && /^\d{5,30}$/.test(id)).slice(0, 50),
    expectedRecord: expected ? {
      postId: typeof expected.postId === "string" ? expected.postId.slice(0, 30) : undefined,
      sourceType: typeof expected.sourceType === "string" ? expected.sourceType.slice(0, 20) : undefined,
      sourceId: typeof expected.sourceId === "string" ? expected.sourceId.slice(0, 120) : undefined,
      identityConfidence: typeof expected.identityConfidence === "string" ? expected.identityConfidence.slice(0, 20) : undefined,
      permalinkPath: typeof expected.permalinkPath === "string" ? expected.permalinkPath.slice(0, 500) : null,
      authorFound: boolFrom(expected.authorFound),
      rootTextFound: boolFrom(expected.rootTextFound),
      mediaCount: finiteFrom(expected.mediaCount, 50),
      exactMediaCount: finiteFrom(expected.exactMediaCount, 50),
    } : null,
  };
}

function boolFrom(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function finiteFrom(value: unknown, max: number): number | undefined { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : undefined; }

export function parseFacebookGalleryCandidates(value: unknown, expectedPostId: string): FacebookMediaCandidate[] {
  if (!Array.isArray(value) || value.length > 50) return [];
  return value.flatMap((entry): FacebookMediaCandidate[] => {
    const item = row(entry);
    if (!item || typeof item.url !== "string" || item.expectedPostId !== expectedPostId || item.storyRootPostId !== expectedPostId || item.boundPostId !== expectedPostId || item.bindingProvenance !== "EXACT_ROOT_STORY" || item.rootStoryUnique !== true || !Array.isArray(item.foreignPostIdsDetected) || item.foreignPostIdsDetected.length > 0) return [];
    return [{ url: item.url.slice(0, 2_000), mediaId: string(item.mediaId), expectedPostId, storyRootPostId: expectedPostId, boundPostId: expectedPostId, bindingConfidence: 1, bindingProvenance: "EXACT_ROOT_STORY", rootStoryUnique: true, foreignPostIdsDetected: [], classification: "PROPERTY_IMAGE", classificationConfidence: 0.95, structuredPostMediaProvenance: false }];
  });
}

function galleryStatus(value: unknown): FacebookGalleryStatus { return value === "PENDING" || value === "RUNNING" || value === "PARTIAL" || value === "COMPLETE" || value === "FAILED" ? value : "NOT_REQUESTED"; }
function boundedCount(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(50, Math.floor(value)) : fallback; }
function row(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : []; }
