import type { FacebookMediaCandidate } from "./types";

/**
 * Selects only source media that are not already represented by a persisted
 * media id or stable URL. This is intentionally pure so queue retries can be
 * tested without touching Facebook or Storage.
 */
export function selectMissingGalleryCandidates(
  candidates: readonly FacebookMediaCandidate[],
  existingMediaIds: ReadonlySet<string> = new Set(),
  existingUrls: ReadonlySet<string> = new Set(),
): FacebookMediaCandidate[] {
  const seenMediaIds = new Set<string>();
  const seenUrls = new Set<string>();
  return candidates.filter((candidate) => {
    const url = candidate.url.trim();
    const mediaId = typeof candidate.mediaId === "string" ? candidate.mediaId.trim() : "";
    if (!url || existingUrls.has(url) || (mediaId && existingMediaIds.has(mediaId)) || seenUrls.has(url) || (mediaId && seenMediaIds.has(mediaId))) return false;
    seenUrls.add(url);
    if (mediaId) seenMediaIds.add(mediaId);
    return true;
  });
}

export function galleryMediaIds(candidates: readonly FacebookMediaCandidate[]): string[] {
  return [...new Set(candidates.flatMap((candidate) => typeof candidate.mediaId === "string" && candidate.mediaId.trim() ? [candidate.mediaId.trim()] : []))];
}
