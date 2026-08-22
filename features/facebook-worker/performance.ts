import type { FacebookAgeCacheEntry, FacebookAgeCacheHit, FacebookGroupSnapshot, FacebookPerformanceMetrics, FacebookPostCacheEntry, FacebookPostCacheHit, FacebookPostSnapshot } from "./types.ts";

export const FACEBOOK_POST_CACHE_TTL_MS = 15 * 60_000;
export const FACEBOOK_FRESH_AGE_CACHE_TTL_MS = 15 * 60_000;
export const FACEBOOK_TOO_OLD_AGE_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
export const FACEBOOK_KNOWN_OLD_STREAK_LIMIT = 5;
export const FACEBOOK_KNOWN_OLD_MIN_AGE_MS = 72 * 60 * 60_000;

type CacheSource = { jobId: string; runId: string; resultSummary: unknown };

export function emptyFacebookPerformanceMetrics(): FacebookPerformanceMetrics {
  return { postsDiscovered: 0, discoveredPostIds: [], duplicatePostIdsSkipped: 0, pageOpens: 0, visionCalls: 0, visionCacheHits: 0, knownPostSkips: 0, discoveryScrolls: 0, feedAgeHits: 0, ageCacheHits: 0, agePageFallbacks: 0, oldPostsSkippedBeforePageOpen: 0, earlyStopOldBoundaryCount: 0, feedTimestampCandidates: 0, exactBoundFeedTimestamps: 0, rejectedAmbiguousFeedTimestamps: 0, feedAgeHitRate: 0, duplicatePostIdsAcrossGroups: 0, fullExtractionCacheHits: 0, fullExtractionCacheMisses: 0, dedicatedPageReuses: 0, duplicateVisionCallsAvoided: 0, duplicatePageOpensAvoided: 0 };
}

export function parseReusableFacebookPostCache(value: unknown): FacebookPostCacheEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entries = (value as Record<string, unknown>).postCache;
  if (!Array.isArray(entries)) return [];
  const parsed: FacebookPostCacheEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if ((row.outcome !== "SELL_PERSISTED" && row.outcome !== "DETERMINISTIC_SKIP") || typeof row.postId !== "string" || !row.postId || typeof row.analyzedAt !== "string" || typeof row.publishedAt !== "string") continue;
    if (!Number.isFinite(Date.parse(row.analyzedAt)) || !Number.isFinite(Date.parse(row.publishedAt))) continue;
    if (row.outcome === "SELL_PERSISTED") {
      if (typeof row.listingId !== "string" || !row.listingId) continue;
      parsed.push({ postId: row.postId, listingId: row.listingId, analyzedAt: row.analyzedAt, publishedAt: row.publishedAt, outcome: "SELL_PERSISTED" });
      continue;
    }
    const safeReason = row.reasonCode === "FACEBOOK_BUY_REQUEST" || row.reasonCode === "FACEBOOK_RENT_REQUEST" || row.reasonCode === "FACEBOOK_SERVICE_POST";
    const safeIntent = row.listingIntent === "BUY_PROPERTY" || row.listingIntent === "RENT_OFFER" || row.listingIntent === "RENT_WANTED" || row.listingIntent === "SERVICE";
    const safeSource = row.intentSource === "DETERMINISTIC_BUY" || row.intentSource === "DETERMINISTIC_SELL";
    if (!safeReason || !safeIntent || !safeSource) continue;
    parsed.push({ postId: row.postId, listingId: null, analyzedAt: row.analyzedAt, publishedAt: row.publishedAt, outcome: "DETERMINISTIC_SKIP", reasonCode: row.reasonCode as FacebookPostCacheEntry["reasonCode"], listingIntent: row.listingIntent as FacebookPostCacheEntry["listingIntent"], intentSource: row.intentSource as FacebookPostCacheEntry["intentSource"] });
  }
  return parsed;
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
      hits[entry.postId] = { sourceJobId: source.jobId, listingId: entry.listingId, analyzedAt: entry.analyzedAt, publishedAt: entry.publishedAt, scope: source.runId === input.currentRunId ? "RUN" : "RECENT", outcome: entry.outcome, reasonCode: entry.reasonCode, listingIntent: entry.listingIntent, intentSource: entry.intentSource };
    }
  }
  return hits;
}

export function parseReusableFacebookAgeCache(value: unknown): FacebookAgeCacheEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entries = (value as Record<string, unknown>).ageCache;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.postId !== "string" || !row.postId || typeof row.checkedAt !== "string" || !Number.isFinite(Date.parse(row.checkedAt))) return [];
    if (row.decision !== "FRESH" && row.decision !== "TOO_OLD") return [];
    if (typeof row.publishedAt !== "string" || !Number.isFinite(Date.parse(row.publishedAt))) return [];
    if (row.source !== "FEED" && row.source !== "POST_PAGE_METADATA" && row.source !== "POST_PAGE") return [];
    return [{ postId: row.postId, checkedAt: row.checkedAt, publishedAt: row.publishedAt, decision: row.decision, source: row.source }];
  });
}

export function resolveFacebookAgeCacheHits(input: { currentRunId: string; sources: CacheSource[]; postIds: string[]; nowMs?: number }): Record<string, FacebookAgeCacheHit> {
  const nowMs = input.nowMs ?? Date.now();
  const requested = new Set(input.postIds);
  const hits: Record<string, FacebookAgeCacheHit> = {};
  const sorted = [...input.sources].sort((left, right) => newestAgeCheckedAt(right.resultSummary) - newestAgeCheckedAt(left.resultSummary));
  for (const source of sorted) {
    for (const entry of parseReusableFacebookAgeCache(source.resultSummary)) {
      if (!requested.has(entry.postId) || hits[entry.postId]) continue;
      const checkedAge = nowMs - Date.parse(entry.checkedAt);
      const ttl = entry.decision === "TOO_OLD" ? FACEBOOK_TOO_OLD_AGE_CACHE_TTL_MS : FACEBOOK_FRESH_AGE_CACHE_TTL_MS;
      if (checkedAge < 0 || checkedAge > ttl) continue;
      const publishedAtMs = Date.parse(entry.publishedAt!);
      if (!Number.isFinite(publishedAtMs) || publishedAtMs > nowMs + 5 * 60_000) continue;
      const currentDecision = nowMs - publishedAtMs <= FACEBOOK_KNOWN_OLD_MIN_AGE_MS ? "FRESH" : "TOO_OLD";
      hits[entry.postId] = { ...entry, decision: currentDecision, sourceJobId: source.jobId, scope: source.runId === input.currentRunId ? "RUN" : "RECENT" };
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

export function mergeFacebookGroupAssociationMetadata(metadata: Record<string, unknown>, group: { id: string; name: string }): Record<string, unknown> {
  const ids = new Set<string>([
    ...(Array.isArray(metadata.groupIds) ? metadata.groupIds.filter((value): value is string => typeof value === "string") : []),
    ...(typeof metadata.groupId === "string" ? [metadata.groupId] : []),
    group.id,
  ]);
  const names = new Set<string>([
    ...(Array.isArray(metadata.groupNames) ? metadata.groupNames.filter((value): value is string => typeof value === "string") : []),
    ...(typeof metadata.groupName === "string" ? [metadata.groupName] : []),
    group.name,
  ]);
  return { ...metadata, groupId: group.id, groupName: group.name, groupIds: [...ids], groupNames: [...names] };
}

export function shouldStopForKnownOldSequence(posts: Array<{ postId: string; publishedAt: string | null }>, known: ReadonlySet<string>, nowMs = Date.now(), limit = FACEBOOK_KNOWN_OLD_STREAK_LIMIT): boolean {
  let streak = 0;
  for (const post of posts) {
    const published = post.publishedAt ? Date.parse(post.publishedAt) : Number.NaN;
    const knownAndOld = known.has(post.postId) && Number.isFinite(published) && nowMs - published > FACEBOOK_KNOWN_OLD_MIN_AGE_MS;
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
  const postsDiscovered = sum("postsDiscovered");
  const exactBoundFeedTimestamps = sum("exactBoundFeedTimestamps");
  return { groupsProcessed: metrics.length, postsDiscovered, uniquePostIds: discoveredIds.size, duplicatePostIdsSkipped: sum("duplicatePostIdsSkipped"), pageOpens: sum("pageOpens"), visionCalls: sum("visionCalls"), visionCacheHits: sum("visionCacheHits"), knownPostSkips: sum("knownPostSkips"), discoveryScrolls: sum("discoveryScrolls"), feedAgeHits: sum("feedAgeHits"), ageCacheHits: sum("ageCacheHits"), agePageFallbacks: sum("agePageFallbacks"), oldPostsSkippedBeforePageOpen: sum("oldPostsSkippedBeforePageOpen"), earlyStopOldBoundaryCount: sum("earlyStopOldBoundaryCount"), feedTimestampCandidates: sum("feedTimestampCandidates"), exactBoundFeedTimestamps, rejectedAmbiguousFeedTimestamps: sum("rejectedAmbiguousFeedTimestamps"), feedAgeHitRate: postsDiscovered > 0 ? exactBoundFeedTimestamps / postsDiscovered : 0, duplicatePostIdsAcrossGroups: Math.max(0, postsDiscovered - discoveredIds.size), fullExtractionCacheHits: sum("fullExtractionCacheHits"), fullExtractionCacheMisses: sum("fullExtractionCacheMisses"), dedicatedPageReuses: sum("dedicatedPageReuses"), duplicateVisionCallsAvoided: sum("duplicateVisionCallsAvoided"), duplicatePageOpensAvoided: sum("duplicatePageOpensAvoided"), durationMs };
}

function newestAnalyzedAt(resultSummary: unknown): number {
  return Math.max(0, ...parseReusableFacebookPostCache(resultSummary).map((entry) => Date.parse(entry.analyzedAt)));
}

function newestAgeCheckedAt(resultSummary: unknown): number {
  return Math.max(0, ...parseReusableFacebookAgeCache(resultSummary).map((entry) => Date.parse(entry.checkedAt)));
}
