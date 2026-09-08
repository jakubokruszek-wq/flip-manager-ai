import type { FacebookMediaCandidate } from "./types";

export type FacebookGallerySeedMedia = {
  mediaId: string;
};

/**
 * Returns bounded navigation seeds that were already proven against the exact
 * root story during SOURCE_SCAN. The CDN filename is used only to recover a
 * photo id for opening Facebook's viewer; the viewer must independently prove
 * top_level_post_id + photo_attachments_list before the image is accepted.
 */
export function gallerySeedMediaFromProvenance(value: unknown, expectedPostId: string): FacebookGallerySeedMedia[] {
  if (!Array.isArray(value) || !/^\d{5,30}$/.test(expectedPostId)) return [];
  const seen = new Set<string>();
  const seeds: FacebookGallerySeedMedia[] = [];
  for (const raw of value.slice(0, 50)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const url = typeof item.normalizedMediaUrl === "string" ? item.normalizedMediaUrl.trim() : "";
    const sourcePostId = typeof item.sourcePostId === "string" ? item.sourcePostId : "";
    const storyRootPostId = typeof item.storyRootPostId === "string" ? item.storyRootPostId : "";
    const bindingMethod = typeof item.bindingMethod === "string" ? item.bindingMethod : "";
    const classification = typeof item.classification === "string" ? item.classification : "";
    const confidence = typeof item.bindingConfidence === "number" && Number.isFinite(item.bindingConfidence) ? item.bindingConfidence : 0;
    if (!isFacebookCdnImage(url) || sourcePostId !== expectedPostId || storyRootPostId !== expectedPostId || bindingMethod !== "EXACT_ROOT_STORY" || confidence < 0.9 || classification !== "PROPERTY_IMAGE") continue;
    const explicitMediaId = typeof item.mediaId === "string" && /^\d{5,30}$/.test(item.mediaId) ? item.mediaId : null;
    const mediaId = explicitMediaId ?? facebookCdnMediaId(url);
    if (!mediaId || seen.has(mediaId)) continue;
    seen.add(mediaId);
    seeds.push({ mediaId });
    if (seeds.length >= 10) break;
  }
  return seeds;
}

function isFacebookCdnImage(value: string): boolean {
  try { return /^https:$/.test(new URL(value).protocol) && /(^|\.)fbcdn\.net$/i.test(new URL(value).hostname); } catch { return false; }
}

function facebookCdnMediaId(value: string): string | null {
  try {
    const filename = new URL(value).pathname.split("/").pop() ?? "";
    return filename.match(/^[^_]+_(\d{8,30})_/)?.[1] ?? null;
  } catch { return null; }
}

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
