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

export function preserveFacebookPublishedAt(incoming: string | null | undefined, existing: string | null | undefined): string | null {
  return incoming ?? existing ?? null;
}
