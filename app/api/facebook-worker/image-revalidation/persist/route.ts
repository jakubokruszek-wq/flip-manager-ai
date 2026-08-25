import { authenticateFacebookWorkerRequest } from "@/features/facebook-worker/auth";
import { validateFacebookRevalidationCandidates, FACEBOOK_IMAGE_REVALIDATION_VERSION } from "@/features/facebook-worker/image-revalidation";
import type { FacebookImageRevalidationCandidate } from "@/features/facebook-worker/types";
import { mirrorFacebookImages } from "@/features/facebook-watcher/server/mirror-facebook-images";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const auth = await authenticateFacebookWorkerRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = parseInput(JSON.parse(auth.body) as unknown);
    const checked = validateFacebookRevalidationCandidates(input.candidates, input.postId);
    const verified = checked.verified.filter((candidate) => input.verifiedCandidates.some((item) => item.url === candidate.url));
    const base = { listingId: input.listingId, postId: input.postId, beforeCount: 0, afterCount: verified.length, candidates: input.candidates.length, verifiedImages: verified.length, rejectedImages: input.candidates.length - verified.length, rejectionReasons: checked.reasons, visionCalls: input.visionCalls, pageOpens: input.pageOpens, durationMs: input.durationMs, wouldReplaceGallery: true };
    if (input.dryRun) return Response.json({ ...base, status: "DRY_RUN" });
    const supabase = createFacebookWatcherAdminClient();
    const existing = await supabase.from("listings").select("id,images,source,external_listing_id,original_url").eq("id", input.listingId).eq("source", "facebook").eq("status", "active").maybeSingle();
    if (existing.error || !existing.data || String(existing.data.external_listing_id) !== input.postId) throw new Error("FACEBOOK_REVALIDATION_LISTING_MISMATCH");
    const beforeImages = Array.isArray(existing.data.images) ? existing.data.images.filter((value): value is string => typeof value === "string") : [];
    const mirrored = await mirrorFacebookImages({ listingId: input.listingId, imageUrls: verified.map((candidate) => candidate.url), existingImages: [], preserveExistingImages: false });
    if (mirrored.stats.failedCount > 0) return Response.json({ ...base, beforeCount: beforeImages.length, afterCount: beforeImages.length, status: "FAILED", wouldReplaceGallery: false, rejectionReasons: [...checked.reasons, "FACEBOOK_REVALIDATION_MIRROR_FAILED"] });
    const updated = await supabase.from("listings").update({ images: mirrored.images }).eq("id", input.listingId).eq("source", "facebook").eq("status", "active");
    if (updated.error) return Response.json({ ...base, beforeCount: beforeImages.length, afterCount: beforeImages.length, status: "FAILED", wouldReplaceGallery: false, rejectionReasons: [...checked.reasons, "FACEBOOK_REVALIDATION_GALLERY_PERSIST_FAILED"] });
    const prior = await supabase.from("listing_source_metadata").select("source_post_url,group_name,author_name,published_at,collected_at,metadata").eq("listing_id", input.listingId).eq("source", "facebook").order("collected_at", { ascending: false }).limit(1).maybeSingle();
    if (prior.error || !prior.data) {
      await supabase.from("listings").update({ images: beforeImages }).eq("id", input.listingId).eq("source", "facebook");
      return Response.json({ ...base, beforeCount: beforeImages.length, afterCount: beforeImages.length, status: "FAILED", wouldReplaceGallery: false, rejectionReasons: [...checked.reasons, "FACEBOOK_REVALIDATION_METADATA_NOT_FOUND"] });
    }
    const metadata = asRow(prior.data.metadata);
    const imageProvenance = verified.map((candidate, index) => ({ imageUrl: mirrored.images[index] ?? null, sourceUrl: candidate.url, contentHash: candidate.contentHash ?? null, sourcePostId: candidate.expectedPostId, storyRootPostId: candidate.storyRootPostId, structuredPostMediaProvenance: candidate.structuredPostMediaProvenance === true, bindingMethod: candidate.bindingProvenance, bindingConfidence: candidate.bindingConfidence, classification: candidate.classification, classificationConfidence: candidate.classificationConfidence, imageExtractionVersion: FACEBOOK_IMAGE_REVALIDATION_VERSION }));
    const saved = await supabase.from("listing_source_metadata").update({ metadata: { ...metadata, imageRevalidationVersion: FACEBOOK_IMAGE_REVALIDATION_VERSION, imageProvenance, imageRevalidationAt: new Date().toISOString(), imageRevalidationStatus: "SUCCESS" } }).eq("listing_id", input.listingId).eq("source", "facebook").eq("source_post_url", String(prior.data.source_post_url));
    if (saved.error) {
      // Compensate the gallery update if provenance cannot be recorded. The old
      // gallery remains the safe visible state; storage objects are untouched.
      await supabase.from("listings").update({ images: beforeImages }).eq("id", input.listingId).eq("source", "facebook");
      return Response.json({ ...base, beforeCount: beforeImages.length, afterCount: beforeImages.length, status: "FAILED", wouldReplaceGallery: false, rejectionReasons: [...checked.reasons, "FACEBOOK_REVALIDATION_METADATA_PERSIST_FAILED"] });
    }
    return Response.json({ ...base, beforeCount: beforeImages.length, afterCount: mirrored.images.length, status: "SUCCESS", verifiedImages: mirrored.images.length, rejectedImages: input.candidates.length - verified.length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "FACEBOOK_REVALIDATION_PERSIST_FAILED" }, { status: 422 });
  }
}

function parseInput(value: unknown): { listingId: string; postId: string; dryRun: boolean; candidates: FacebookImageRevalidationCandidate[]; verifiedCandidates: FacebookImageRevalidationCandidate[]; pageOpens: number; visionCalls: number; durationMs: number } {
  const row = asRow(value);
  const listingId = requiredString(row.listingId, 100); const postId = requiredString(row.postId, 300);
  const parseCandidates = (value: unknown) => Array.isArray(value) ? value.map(parseCandidate) : [];
  const candidates = parseCandidates(row.candidates); const verifiedCandidates = parseCandidates(row.verifiedCandidates);
  if (candidates.length > 5 || verifiedCandidates.length > 5) throw new Error("INVALID_REVALIDATION_CANDIDATES");
  return { listingId, postId, dryRun: row.dryRun === true, candidates, verifiedCandidates, pageOpens: nonnegative(row.pageOpens), visionCalls: nonnegative(row.visionCalls), durationMs: nonnegative(row.durationMs) };
}
function parseCandidate(value: unknown): FacebookImageRevalidationCandidate {
  const row = asRow(value);
  const url = requiredString(row.url, 2_000); const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("INVALID_REVALIDATION_CANDIDATE_URL");
  const expectedPostId = requiredString(row.expectedPostId, 300);
  const storyRootPostId = row.storyRootPostId === null || row.storyRootPostId === undefined ? null : requiredString(row.storyRootPostId, 300);
  const boundPostId = row.boundPostId === null || row.boundPostId === undefined ? null : requiredString(row.boundPostId, 300);
  const bindingConfidence = Number(row.bindingConfidence); const classificationConfidence = row.classificationConfidence === null || row.classificationConfidence === undefined ? null : Number(row.classificationConfidence);
  if (!Number.isFinite(bindingConfidence) || bindingConfidence < 0 || bindingConfidence > 1 || classificationConfidence !== null && (!Number.isFinite(classificationConfidence) || classificationConfidence < 0 || classificationConfidence > 1)) throw new Error("INVALID_REVALIDATION_CANDIDATE_CONFIDENCE");
  return { url: parsed.toString(), expectedPostId, storyRootPostId, boundPostId, bindingConfidence, bindingProvenance: row.bindingProvenance === "EXACT_ROOT_STORY" || row.bindingProvenance === "EXACT_POST_METADATA" || row.bindingProvenance === "DEDICATED_POST_VIEWER" || row.bindingProvenance === "AMBIGUOUS" ? row.bindingProvenance : "AMBIGUOUS", rootStoryUnique: row.rootStoryUnique === true, foreignPostIdsDetected: Array.isArray(row.foreignPostIdsDetected) ? row.foreignPostIdsDetected.filter((item): item is string => typeof item === "string").slice(0, 20) : [], classification: row.classification === "PROPERTY_IMAGE" || row.classification === "NON_PROPERTY_IMAGE" || row.classification === "UNKNOWN" ? row.classification : "UNKNOWN", classificationConfidence, structuredPostMediaProvenance: row.structuredPostMediaProvenance === true, contentHash: typeof row.contentHash === "string" ? row.contentHash.slice(0, 200) : null, storageUrl: typeof row.storageUrl === "string" ? row.storageUrl.slice(0, 2_000) : null };
}
function asRow(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function requiredString(value: unknown, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("INVALID_PAYLOAD"); return value.trim(); }
function nonnegative(value: unknown): number { const n = Number(value); if (!Number.isFinite(n) || n < 0) throw new Error("INVALID_REVALIDATION_METRICS"); return Math.round(n); }
