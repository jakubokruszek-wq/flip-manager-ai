import type { FacebookPostSnapshot } from "@/features/facebook-worker/types";
import type { FacebookMediaCandidate } from "@/features/facebook-worker/types";

import type { CollectorPostRecord, FacebookCollectorBatch } from "./facebook-batch";

export const COLLECTOR_MAX_POST_AGE_MS = 72 * 60 * 60 * 1_000;

export function collectorPostsForProcessing(batch: FacebookCollectorBatch, now = Date.now(), identityConflictPostIds: ReadonlySet<string> = new Set()): FacebookPostSnapshot[] {
  return batch.posts.filter((post) => post.identityConfidence === "EXACT" && !identityConflictPostIds.has(post.postId) && isCollectorPostFresh(post.publishedAt, now)).map((post) => {
    const mediaCandidates = exactCollectorMediaCandidates(post);
    return {
    postId: post.postId,
    groupId: post.sourceId,
    permalink: post.permalink,
    authoritativePostText: post.text,
    authoritativePostTextSource: "POST_REGION_DOM",
    authoritativePostTextProvenance: "ROOT_AUTHOR_MESSAGE",
    text: post.text ?? "",
    imageUrls: mediaCandidates.map((candidate) => candidate.url),
    mediaCandidates,
    publishedAt: post.publishedAt,
    vision: null,
    discoverySource: post.discoverySource,
    searchQuery: post.searchQuery,
    searchQueries: post.searchQueries,
    foundInMainFeed: post.foundInMainFeed,
    firstSeenPhase: post.firstSeenPhase,
  };
  });
}

/**
 * Converts only media found in the exact root story into the watcher candidate
 * format. The collector's exactAssociation flag is intentionally required;
 * URLs, media ids, captions or neighbouring cards are never promoted here.
 */
export function exactCollectorMediaCandidates(post: CollectorPostRecord): FacebookMediaCandidate[] {
  // Structured collector records may not carry the optional rootPostId field:
  // their canonical postId is already the exact root selected by the
  // structured story/link binding.  Keep that proof rather than dropping
  // media solely because the optional field was omitted in the batch.
  const rootPostId = post.rootPostId ?? post.postId;
  if (post.identityConfidence !== "EXACT" || rootPostId !== post.postId || !post.author?.trim() || !post.text?.trim()) return [];
  const candidates = post.media.filter((media) => media.exactAssociation === true && media.exactPostId === post.postId && isSafeFacebookMediaUrl(media.url));
  const seen = new Set<string>();
  return candidates.flatMap((media) => {
    const key = media.mediaId || media.url;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      url: media.url,
      mediaId: media.mediaId,
      expectedPostId: post.postId,
      storyRootPostId: rootPostId,
      boundPostId: post.postId,
      bindingConfidence: 1,
      bindingProvenance: "EXACT_ROOT_STORY",
      rootStoryUnique: true,
      foreignPostIdsDetected: [],
      classification: "PROPERTY_IMAGE",
      classificationConfidence: 0.9,
      structuredPostMediaProvenance: false,
    } satisfies FacebookMediaCandidate];
  });
}

function isSafeFacebookMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase().startsWith("scontent") && url.hostname.toLowerCase().endsWith(".fbcdn.net");
  } catch {
    return false;
  }
}

export function findHistoricalCollectorIdentityConflicts(batch: FacebookCollectorBatch, historicalPayloads: unknown[]): Set<string> {
  const prior = new Map<string, Array<{ author: string | null; text: string | null }>>();
  for (const payload of historicalPayloads) {
    if (!record(payload) || !Array.isArray(payload.posts)) continue;
    for (const post of payload.posts) {
      if (!record(post) || typeof post.postId !== "string") continue;
      const values = prior.get(post.postId) ?? [];
      values.push({ author: text(post.author), text: text(post.text) });
      prior.set(post.postId, values);
    }
  }
  return new Set(batch.posts.flatMap((post) => (prior.get(post.postId) ?? []).some((old) => identityConflict(post, old)) ? [post.postId] : []));
}

function identityConflict(current: { author: string | null; text: string | null }, previous: { author: string | null; text: string | null }): boolean {
  const currentAuthor = comparable(current.author); const previousAuthor = comparable(previous.author);
  if (currentAuthor && previousAuthor && currentAuthor !== previousAuthor) return true;
  const currentText = comparable(current.text); const previousText = comparable(previous.text);
  return Boolean(currentText && previousText && !currentText.includes(previousText) && !previousText.includes(currentText));
}
function comparable(value: string | null): string { return (value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/\s+/g, " ").trim(); }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function isCollectorPostFresh(publishedAt: string | null, now = Date.now()): boolean {
  return publishedAt === null || now - Date.parse(publishedAt) <= COLLECTOR_MAX_POST_AGE_MS;
}

export const COLLECTOR_IMAGE_IMPORT_OPTIONS = { preserveExistingImagesOnEmptyInput: true } as const;
