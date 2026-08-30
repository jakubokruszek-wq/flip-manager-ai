import type { FacebookPostSnapshot } from "@/features/facebook-worker/types";

import type { FacebookCollectorBatch } from "./facebook-batch";

export const COLLECTOR_MAX_POST_AGE_MS = 72 * 60 * 60 * 1_000;

export function collectorPostsForProcessing(batch: FacebookCollectorBatch, now = Date.now(), identityConflictPostIds: ReadonlySet<string> = new Set()): FacebookPostSnapshot[] {
  return batch.posts.filter((post) => post.identityConfidence === "EXACT" && !identityConflictPostIds.has(post.postId) && isCollectorPostFresh(post.publishedAt, now)).map((post) => ({
    postId: post.postId,
    groupId: post.sourceId,
    permalink: post.permalink,
    authoritativePostText: post.text,
    authoritativePostTextSource: "POST_REGION_DOM",
    authoritativePostTextProvenance: "ROOT_AUTHOR_MESSAGE",
    text: post.text ?? "",
    imageUrls: [],
    mediaCandidates: [],
    publishedAt: post.publishedAt,
    vision: null,
    discoverySource: post.discoverySource,
    searchQuery: post.searchQuery,
    searchQueries: post.searchQueries,
    foundInMainFeed: post.foundInMainFeed,
    firstSeenPhase: post.firstSeenPhase,
  }));
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
