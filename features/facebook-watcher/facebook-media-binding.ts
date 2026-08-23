import type { FacebookListingInput } from "./types";

export function exactBoundPropertyImages(input: FacebookListingInput, expectedPostId: string): string[] {
  return [...new Set((input.mediaCandidates ?? [])
    .filter((candidate) => candidate.expectedPostId === expectedPostId
      && candidate.boundPostId === expectedPostId
      && candidate.rootStoryUnique
      && candidate.foreignPostIdsDetected.length === 0
      && candidate.bindingConfidence >= 0.9
      && candidate.classification === "PROPERTY_IMAGE"
      && (candidate.classificationConfidence ?? 0) >= 0.8)
    .map((candidate) => candidate.url))];
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
}) {
  const existing = new Set(input.existingImages);
  const persistedNewImageCount = input.finalListingImages.filter((image) => !existing.has(image)).length;
  const relevanceRejected = Math.max(0, input.exactBoundCandidates - input.relevanceAccepted);
  const imageReasonCode = persistedNewImageCount === input.mirroredCount ? "NONE" : "FACEBOOK_IMAGE_PERSIST_COUNT_MISMATCH";
  return {
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
  };
}

export function preserveFacebookPublishedAt(incoming: string | null | undefined, existing: string | null | undefined): string | null {
  return incoming ?? existing ?? null;
}
