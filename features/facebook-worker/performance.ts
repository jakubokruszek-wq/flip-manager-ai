import type { FacebookGroupSnapshot, FacebookPerformanceMetrics, FacebookPostCacheEntry, FacebookPostCacheHit, FacebookPostSnapshot } from "./types.ts";

export const FACEBOOK_POST_CACHE_TTL_MS = 15 * 60_000;
export const FACEBOOK_KNOWN_OLD_STREAK_LIMIT = 5;
export const FACEBOOK_KNOWN_OLD_MIN_AGE_MS = 60 * 60 * 60_000;

type CacheSource = { jobId: string; runId: string; resultSummary: unknown };

export function emptyFacebookPerformanceMetrics(): FacebookPerformanceMetrics {
  return { postsDiscovered: 0, discoveredPostIds: [], duplicatePostIdsSkipped: 0, pageOpens: 0, visionCalls: 0, visionCacheHits: 0, knownPostSkips: 0, discoveryScrolls: 0 };
}

export function parseReusableFacebookPostCache(value: unknown): FacebookPostCacheEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entries = (value as Record<string, unknown>).postCache;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    if (row.outcome !== "SELL_PERSISTED" || typeof row.postId !== "string" || !row.postId || typeof row.listingId !== "string" || !row.listingId || typeof row.analyzedAt !== "string" || typeof row.publishedAt !== "string") return [];
    if (!Number.isFinite(Date.parse(row.analyzedAt)) || !Number.isFinite(Date.parse(row.publishedAt))) return [];
    return [{ postId: row.postId, listingId: row.listingId, analyzedAt: row.analyzedAt, publishedAt: row.publishedAt, outcome: "SELL_PERSISTED" as const }];
  });
}

export function resolveFacebookPostCacheHits(input: { currentRunId: string; sources: CacheSource[]; postIds: string[]; nowMs?: number; ttlMs?: number }): Record<string, FacebookPostCacheHit & { publishedAt: string }> {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? FACEBOOK_POST_CACHE_TTL_MS;
  const requested = new Set(input.postIds);
  const hits: Record<string, FacebookPostCacheHit & { publishedAt: string }> = {};
  const sorted = [...input.sources].sort((left, right) => newestAnalyzedAt(right.resultSummary) - newestAnalyzedAt(left.resultSummary));
  for (const source of sorted) {
    for (const entry of parseReusableFacebookPostCache(source.resultSummary)) {
      if (!requested.has(entry.postId) || hits[entry.postId]) continue;
      const age = nowMs - Date.parse(entry.analyzedAt);
      if (age < 0 || age > ttlMs) continue;
      hits[entry.postId] = { sourceJobId: source.jobId, listingId: entry.listingId, analyzedAt: entry.analyzedAt, publishedAt: entry.publishedAt, scope: source.runId === input.currentRunId ? "RUN" : "RECENT" };
    }
  }
  return hits;
}

export function isFacebookCachedPostStillFresh(publishedAt: string, nowMs = Date.now()): boolean {
  const published = Date.parse(publishedAt);
  return Number.isFinite(published) && published <= nowMs + 5 * 60_000 && nowMs - published <= 72 * 60 * 60_000;
}

export function partitionFacebookPostsByCache<T extends { postId: string }>(posts: T[], hits: Record<string, FacebookPostCacheHit & { publishedAt: string }>, nowMs = Date.now()): { cached: Array<{ post: T; hit: FacebookPostCacheHit & { publishedAt: string } }>; uncached: T[] } {
  const cached: Array<{ post: T; hit: FacebookPostCacheHit & { publishedAt: string } }> = [];
  const uncached: T[] = [];
  for (const post of posts) {
    const hit = hits[post.postId];
    if (hit && isFacebookCachedPostStillFresh(hit.publishedAt, nowMs)) cached.push({ post, hit });
    else uncached.push(post);
  }
  return { cached, uncached };
}

export function createCachedFacebookPostSnapshot(post: { postId: string; permalink: string }, group: FacebookGroupSnapshot, hit: FacebookPostCacheHit & { publishedAt: string }): FacebookPostSnapshot {
  return { postId: post.postId, groupId: group.id, permalink: post.permalink, authoritativePostText: "", authoritativePostTextSource: "NONE", authoritativePostTextProvenance: "NONE", text: "", imageUrls: [], publishedAt: hit.publishedAt, vision: null, cacheHit: hit };
}

export function shouldStopForKnownOldSequence(posts: Array<{ postId: string; publishedAt: string | null }>, known: ReadonlySet<string>, nowMs = Date.now(), limit = FACEBOOK_KNOWN_OLD_STREAK_LIMIT): boolean {
  let streak = 0;
  for (const post of posts) {
    const published = post.publishedAt ? Date.parse(post.publishedAt) : Number.NaN;
    const knownAndOld = known.has(post.postId) && Number.isFinite(published) && nowMs - published >= FACEBOOK_KNOWN_OLD_MIN_AGE_MS;
    streak = knownAndOld ? streak + 1 : 0;
  }
  return streak >= limit;
}

export function aggregateFacebookPerformance(results: unknown[], durationMs: number): Omit<FacebookPerformanceMetrics, "discoveredPostIds"> & { groupsProcessed: number; uniquePostIds: number; durationMs: number } {
  const metrics = results.flatMap((result) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) return [];
    const value = (result as Record<string, unknown>).performance;
    return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
  });
  const discoveredIds = new Set(metrics.flatMap((item) => Array.isArray(item.discoveredPostIds) ? item.discoveredPostIds.filter((id): id is string => typeof id === "string") : []));
  const sum = (field: string) => metrics.reduce((total, item) => total + (typeof item[field] === "number" ? Number(item[field]) : 0), 0);
  return { groupsProcessed: metrics.length, postsDiscovered: sum("postsDiscovered"), uniquePostIds: discoveredIds.size, duplicatePostIdsSkipped: sum("duplicatePostIdsSkipped"), pageOpens: sum("pageOpens"), visionCalls: sum("visionCalls"), visionCacheHits: sum("visionCacheHits"), knownPostSkips: sum("knownPostSkips"), discoveryScrolls: sum("discoveryScrolls"), durationMs };
}

function newestAnalyzedAt(resultSummary: unknown): number {
  return Math.max(0, ...parseReusableFacebookPostCache(resultSummary).map((entry) => Date.parse(entry.analyzedAt)));
}
