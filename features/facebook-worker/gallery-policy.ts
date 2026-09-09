import type { FacebookMediaCandidate } from "./types";

export type FacebookGallerySeedMedia = {
  mediaId: string;
};

/**
 * Returns bounded navigation seeds that were already proven against the exact
 * root story during SOURCE_SCAN. A Facebook CDN filename is an asset name, not
 * a reliable photo id, so only the explicit mediaId captured from Facebook's
 * structured payload is eligible as a viewer seed.
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
    const mediaId = typeof item.mediaId === "string" && /^\d{5,30}$/.test(item.mediaId) ? item.mediaId : null;
    if (!mediaId || seen.has(mediaId)) continue;
    seen.add(mediaId);
    seeds.push({ mediaId });
    if (seeds.length >= 10) break;
  }
  return seeds;
}

/**
 * Recovers an explicit viewer seed for legacy listing metadata from the
 * immutable collector batch that originally proved the exact parent. Every
 * binding is rechecked; a number embedded in a CDN filename is never used.
 */
export function gallerySeedMediaFromCollectorBatches(value: unknown, expectedPostId: string, expectedSourceUrl: string): FacebookGallerySeedMedia[] {
  if (!Array.isArray(value) || !/^\d{5,30}$/.test(expectedPostId)) return [];
  const expectedGroup = facebookGroupId(expectedSourceUrl);
  if (!expectedGroup) return [];
  const seen = new Set<string>();
  const seeds: FacebookGallerySeedMedia[] = [];
  for (const rawRow of value.slice(0, 20)) {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) continue;
    const row = rawRow as Record<string, unknown>;
    const payloadValue = row.payload ?? row;
    if (!payloadValue || typeof payloadValue !== "object" || Array.isArray(payloadValue)) continue;
    const payload = payloadValue as Record<string, unknown>;
    if (payload.sourceType !== "GROUP" || payload.sourceId !== expectedGroup || facebookGroupId(payload.sourceUrl) !== expectedGroup || !Array.isArray(payload.posts)) continue;
    for (const rawPost of payload.posts.slice(0, 500)) {
      if (!rawPost || typeof rawPost !== "object" || Array.isArray(rawPost)) continue;
      const post = rawPost as Record<string, unknown>;
      if (post.postId !== expectedPostId || post.identityConfidence !== "EXACT" || !exactFacebookPostUrl(post.permalink, expectedGroup, expectedPostId)) continue;
      if (typeof post.author !== "string" || !post.author.trim() || typeof post.text !== "string" || !post.text.trim() || !Array.isArray(post.media)) continue;
      const declaredMediaIds = new Set(Array.isArray(post.mediaIds) ? post.mediaIds.filter((item): item is string => typeof item === "string" && /^\d{5,30}$/.test(item)) : []);
      for (const rawMedia of post.media.slice(0, 50)) {
        if (!rawMedia || typeof rawMedia !== "object" || Array.isArray(rawMedia)) continue;
        const media = rawMedia as Record<string, unknown>;
        const mediaId = typeof media.mediaId === "string" && /^\d{5,30}$/.test(media.mediaId) ? media.mediaId : null;
        const url = typeof media.url === "string" ? media.url.trim() : "";
        if (!mediaId || !declaredMediaIds.has(mediaId) || media.exactAssociation !== true || media.exactPostId !== expectedPostId || !isFacebookCdnImage(url) || seen.has(mediaId)) continue;
        seen.add(mediaId);
        seeds.push({ mediaId });
        if (seeds.length >= 10) return seeds;
      }
    }
  }
  return seeds;
}

function isFacebookCdnImage(value: string): boolean {
  try { return /^https:$/.test(new URL(value).protocol) && /(^|\.)fbcdn\.net$/i.test(new URL(value).hostname); } catch { return false; }
}

function facebookGroupId(value: unknown): string | null {
  try {
    return new URL(String(value || "")).pathname.match(/^\/groups\/([^/]+)(?:\/|$)/i)?.[1] ?? null;
  } catch { return null; }
}

function exactFacebookPostUrl(value: unknown, expectedGroup: string, expectedPostId: string): boolean {
  try {
    const url = new URL(String(value || ""));
    return /(^|\.)facebook\.com$/i.test(url.hostname)
      && url.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d{5,30})(?:\/|$)/i)?.slice(1, 3).join(":") === `${expectedGroup}:${expectedPostId}`;
  } catch { return false; }
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
