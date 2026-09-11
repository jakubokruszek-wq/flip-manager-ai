import type { FacebookListingInput } from "./types";
import type { FacebookImageProvenanceDiagnostic } from "../facebook-worker/post-flow";

export function exactBoundPropertyImages(input: FacebookListingInput, expectedPostId: string): string[] {
  return [...new Set((input.mediaCandidates ?? [])
    .filter((candidate) => candidate.expectedPostId === expectedPostId
      && candidate.boundPostId === expectedPostId
      && candidate.rootStoryUnique
      && candidate.foreignPostIdsDetected.length === 0
      && candidate.bindingConfidence >= 0.9
      && candidate.classification === "PROPERTY_IMAGE"
      && (candidate.classificationConfidence ?? 0) >= 0.8
      && hasApprovedFacebookImageProvenance(candidate, expectedPostId)
      && !isSuspiciousSmallSquare(candidate))
    .map((candidate) => candidate.url))];
}

export function hasApprovedFacebookImageProvenance(candidate: { expectedPostId: string; storyRootPostId?: string | null; structuredPostMediaProvenance?: boolean }, expectedPostId: string): boolean {
  return candidate.expectedPostId === expectedPostId
    && (candidate.storyRootPostId === expectedPostId || candidate.structuredPostMediaProvenance === true);
}

/** Conservative guard against avatars/profile tiles being treated as property photos. */
export function isSuspiciousSmallSquare(candidate: { intrinsicWidth?: number | null; intrinsicHeight?: number | null }): boolean {
  const width = candidate.intrinsicWidth ?? null;
  const height = candidate.intrinsicHeight ?? null;
  if (!width || !height || width > 200 || height > 200) return false;
  const ratio = width / height;
  return ratio >= 0.8 && ratio <= 1.25;
}

export function facebookMediaBindingSummary(input: FacebookListingInput, expectedPostId: string) {
  const candidates = input.mediaCandidates ?? [];
  return {
    candidates: candidates.length,
    exactBound: candidates.filter((candidate) => candidate.expectedPostId === expectedPostId && candidate.boundPostId === expectedPostId && candidate.rootStoryUnique).length,
    foreignRejected: candidates.filter((candidate) => candidate.foreignPostIdsDetected.length > 0 || (candidate.boundPostId !== null && candidate.boundPostId !== expectedPostId)).length,
    ambiguousRejected: candidates.filter((candidate) => candidate.boundPostId === null || !candidate.rootStoryUnique).length,
  };
}

export function facebookImagePersistenceDiagnostics(input: {
  listingId?: string | null;
  decision?: "MATCHED" | "REVIEW" | "REJECTED" | null;
  lifecycleStatus?: string | null;
  existingListingFound?: boolean;
  existingListingLifecycle?: string | null;
  imagePersistenceAttempted?: boolean;
  storageUploadAttempted?: number;
  storageUploadSuccess?: number;
  storageUploadFailed?: number;
  storageFailureReason?: string | null;
  postId: string | null;
  creationTime: string | null;
  timestampSource: "POST_PAGE_METADATA" | "POST_PAGE" | "UNKNOWN";
  publishedAtCandidate: string | null;
  publishedAtPersistAttempted: boolean;
  publishedAtPersisted: boolean;
  exactBoundCandidates: number;
  relevanceAccepted: number;
  mirrorAttempted: number;
  mirroredCount: number;
  existingImages: string[];
  finalListingImages: string[];
  imageProvenance?: FacebookImageProvenanceDiagnostic[];
  decisionReasons?: string[];
}) {
  const existing = new Set(input.existingImages);
  const persistedNewImageCount = input.finalListingImages.filter((image) => !existing.has(image)).length;
  const relevanceRejected = Math.max(0, input.exactBoundCandidates - input.relevanceAccepted);
  const imageReasonCode = persistedNewImageCount === input.mirroredCount ? "NONE" : "FACEBOOK_IMAGE_PERSIST_COUNT_MISMATCH";
  const hasExtendedDiagnostics = input.listingId !== undefined
    || input.decision !== undefined
    || input.lifecycleStatus !== undefined
    || input.existingListingFound !== undefined
    || input.existingListingLifecycle !== undefined
    || input.imagePersistenceAttempted !== undefined
    || input.storageUploadAttempted !== undefined
    || input.storageUploadSuccess !== undefined
    || input.storageUploadFailed !== undefined
    || input.storageFailureReason !== undefined;
  return {
    ...(hasExtendedDiagnostics ? {
      listingId: input.listingId ?? null,
      decision: input.decision ?? null,
      lifecycleStatus: input.lifecycleStatus ?? null,
      existingListingFound: input.existingListingFound ?? false,
      existingListingLifecycle: input.existingListingLifecycle ?? null,
      existingListingImageCount: input.existingImages.length,
      incomingImageCount: input.mirrorAttempted,
      imagePersistenceAttempted: input.imagePersistenceAttempted ?? input.publishedAtPersistAttempted,
      storageUploadAttempted: input.storageUploadAttempted ?? input.mirrorAttempted,
      storageUploadSuccess: input.storageUploadSuccess ?? input.mirroredCount,
      storageUploadFailed: input.storageUploadFailed ?? 0,
      storageFailureReason: input.storageFailureReason ?? null,
      imagesBeforeUpdate: input.existingImages.length,
      imagesAfterUpdate: input.finalListingImages.length,
      thumbnailBeforePresent: input.existingImages.length > 0,
      thumbnailAfterPresent: input.finalListingImages.length > 0,
    } : {}),
    postId: input.postId,
    creationTime: input.creationTime,
    timestampSource: input.timestampSource,
    publishedAtCandidate: input.publishedAtCandidate,
    publishedAtPersistAttempted: input.publishedAtPersistAttempted,
    publishedAtPersisted: input.publishedAtPersisted,
    exactBoundCandidates: input.exactBoundCandidates,
    relevanceAccepted: input.relevanceAccepted,
    relevanceRejected,
    mirrorAttempted: input.mirrorAttempted,
    mirroredCount: input.mirroredCount,
    persistedNewImageCount,
    finalListingImageCount: input.finalListingImages.length,
    persistedImageCount: input.finalListingImages.length,
    imageReasonCode,
    reasonCodes: imageReasonCode === "NONE" ? [] : [imageReasonCode],
    ...(input.decisionReasons ? { decisionReasons: [...new Set(input.decisionReasons.filter((reason) => /^[a-z0-9_:-]{1,120}$/i.test(reason)))].slice(0, 20) } : {}),
    imageProvenance: input.imageProvenance ?? [],
  };
}

/** Read-only per-candidate provenance telemetry; this never decides acceptance. */
export function facebookImageProvenanceDiagnostics(
  candidates: NonNullable<FacebookListingInput["mediaCandidates"]>,
  expectedPostId: string,
  verifiedUrls: ReadonlySet<string>,
): FacebookImageProvenanceDiagnostic[] {
  return candidates.map((candidate) => {
    const approved = hasApprovedFacebookImageProvenance(candidate, expectedPostId);
    const relevanceAccepted = candidate.classification === "PROPERTY_IMAGE" && (candidate.classificationConfidence ?? 0) >= 0.8;
    const finalVerified = verifiedUrls.has(candidate.url);
    const provenanceReasonCode = approved
      ? candidate.structuredPostMediaProvenance === true ? "STRUCTURED_EXACT_POST_MEDIA" : "EXACT_STORY_ROOT"
      : "FACEBOOK_IMAGE_PROVENANCE_INSUFFICIENT";
    const rejectionReason = !approved
      ? "FACEBOOK_IMAGE_PROVENANCE_INSUFFICIENT"
      : !relevanceAccepted
        ? "FACEBOOK_IMAGE_RELEVANCE_REJECTED"
        : !finalVerified ? "FACEBOOK_IMAGE_NOT_VERIFIED" : null;
    const mediaId = (candidate as unknown as { mediaId?: unknown }).mediaId;
    return {
      structuredPostMediaProvenance: candidate.structuredPostMediaProvenance === true,
      provenanceReasonCode,
      expectedPostId: candidate.expectedPostId,
      detectedStoryRootPostId: candidate.storyRootPostId ?? null,
      bindingMethod: candidate.bindingProvenance,
      bindingConfidence: candidate.bindingConfidence ?? null,
      mediaId: typeof mediaId === "string" && mediaId.trim() ? mediaId : null,
      normalizedMediaUrl: candidate.url || null,
      relevanceClassification: candidate.classification,
      relevanceConfidence: candidate.classificationConfidence ?? null,
      finalVerified,
      rejectionReason,
    };
  });
}

export function preserveFacebookPublishedAt(incoming: string | null | undefined, existing: string | null | undefined): string | null {
  return incoming ?? existing ?? null;
}
