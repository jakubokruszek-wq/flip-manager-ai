import { hasApprovedFacebookImageProvenance } from "../facebook-watcher/facebook-media-binding.ts";
import type { FacebookImageRevalidationCandidate, FacebookImageRevalidationTarget } from "./types.ts";

export const FACEBOOK_IMAGE_REVALIDATION_VERSION = 1;

export type RevalidationListingRecord = FacebookImageRevalidationTarget & {
  imageExtractionVersion: number | null;
  hasPerImageProvenance: boolean;
};

export function selectFacebookImageRevalidationTargets(
  listings: RevalidationListingRecord[],
  options: { limit?: number; listingId?: string | null; postId?: string | null } = {},
): RevalidationListingRecord[] {
  const limit = Math.max(1, Math.min(50, options.limit ?? 5));
  return listings
    .filter((listing) => listing.currentImages.length > 0)
    .filter((listing) => !options.listingId || listing.listingId === options.listingId)
    .filter((listing) => !options.postId || listing.postId === options.postId)
    .filter((listing) => !listing.hasPerImageProvenance || listing.imageExtractionVersion !== FACEBOOK_IMAGE_REVALIDATION_VERSION)
    .slice(0, limit);
}

export function validateFacebookRevalidationCandidates(
  candidates: FacebookImageRevalidationCandidate[],
  expectedPostId: string,
): { verified: FacebookImageRevalidationCandidate[]; rejected: FacebookImageRevalidationCandidate[]; reasons: string[] } {
  const verified: FacebookImageRevalidationCandidate[] = [];
  const rejected: FacebookImageRevalidationCandidate[] = [];
  const reasons = new Set<string>();
  for (const candidate of candidates) {
    if (!hasApprovedFacebookImageProvenance(candidate, expectedPostId)) {
      rejected.push(candidate);
      reasons.add("FACEBOOK_IMAGE_PROVENANCE_INSUFFICIENT");
      continue;
    }
    if (candidate.classification !== "PROPERTY_IMAGE" || (candidate.classificationConfidence ?? 0) < 0.8) {
      rejected.push(candidate);
      reasons.add("FACEBOOK_IMAGE_RELEVANCE_REJECTED");
      continue;
    }
    verified.push(candidate);
  }
  return { verified, rejected, reasons: [...reasons] };
}

export function shouldReplaceFacebookRevalidationGallery(input: {
  pageAvailable: boolean;
  provenanceKnown: boolean;
  mirrorFailed: boolean;
}): boolean {
  return input.pageAvailable && input.provenanceKnown && !input.mirrorFailed;
}
