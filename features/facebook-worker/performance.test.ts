import assert from "node:assert/strict";
import test from "node:test";
import { aggregateFacebookPerformance, createCachedFacebookPostSnapshot, FACEBOOK_FRESH_AGE_CACHE_TTL_MS, FACEBOOK_POST_CACHE_TTL_MS, isFacebookCachedPostStillFresh, parseReusableFacebookAgeCache, parseReusableFacebookPostCache, partitionFacebookPostsByCache, resolveFacebookAgeCacheHits, resolveFacebookPostCacheHits, shouldStopForKnownOldSequence } from "./performance.ts";
import { processFacebookPostBatch } from "./post-flow.ts";
import { isExpectedFacebookPostPage, runFacebookDiscoveryLoop } from "../../workers/facebook-browser/src/post-page.ts";

const now = Date.parse("2026-08-22T12:00:00.000Z");
const publishedAt = "2026-08-22T10:00:00.000Z";
const source = (overrides: Record<string, unknown> = {}) => ({ jobId: "job-1", runId: "run-1", resultSummary: { postCache: [{ postId: "123", listingId: "listing-1", analyzedAt: new Date(now - 60_000).toISOString(), publishedAt, outcome: "SELL_PERSISTED", ...overrides }] } });

test("same post in two group jobs reuses one successful Vision result", () => {
  let visionCalls = 0;
  const firstGroupResult = source();
  visionCalls += 1;
  const hits = resolveFacebookPostCacheHits({ currentRunId: "run-1", sources: [firstGroupResult], postIds: ["123"], nowMs: now });
  const second = partitionFacebookPostsByCache([{ postId: "123" }], hits, now);
  if (second.uncached.length) visionCalls += 1;
  assert.equal(visionCalls, 1);
  assert.equal(second.cached.length, 1);
  assert.equal(second.cached[0].hit.scope, "RUN");
});

test("cache reuse creates no listing update or duplicate snapshot signal", async () => {
  const hit = resolveFacebookPostCacheHits({ currentRunId: "run-1", sources: [source()], postIds: ["123"], nowMs: now })["123"];
  const snapshot = createCachedFacebookPostSnapshot({ postId: "123", permalink: "https://www.facebook.com/groups/2/posts/123/" }, { id: "group-2", name: "Two", url: "https://www.facebook.com/groups/2/" }, hit);
  const result = await processFacebookPostBatch([snapshot], async () => ({ status: "reused", listingId: "listing-1", listingCreated: false, listingUpdated: false, matched: true, matchCreated: false, imagesMirrored: 0, priceDrops: 0, warnings: [] }));
  assert.equal(result.listingsCreated, 0);
  assert.equal(result.listingsUpdated, 0);
  assert.equal(result.priceDrops, 0);
  assert.equal(result.reusablePosts.length, 1);
});

test("BUY, UNKNOWN and failed results cannot be reused as SELL", () => {
  for (const outcome of ["BUY_PROPERTY", "UNKNOWN", "FAILED"]) {
    assert.deepEqual(parseReusableFacebookPostCache({ postCache: [{ postId: "123", listingId: "listing-1", analyzedAt: new Date(now).toISOString(), publishedAt, outcome }] }), []);
  }
});

test("expired cache performs normal extraction", () => {
  const expired = source({ analyzedAt: new Date(now - FACEBOOK_POST_CACHE_TTL_MS - 1).toISOString() });
  const hits = resolveFacebookPostCacheHits({ currentRunId: "run-1", sources: [expired], postIds: ["123"], nowMs: now });
  assert.deepEqual(hits, {});
});

test("fresh known unchanged post is safely reused", () => {
  const hits = resolveFacebookPostCacheHits({ currentRunId: "run-2", sources: [source()], postIds: ["123"], nowMs: now });
  const result = partitionFacebookPostsByCache([{ postId: "123" }], hits, now);
  assert.equal(result.cached.length, 1);
  assert.equal(result.cached[0].hit.scope, "RECENT");
});

test("72 hour freshness boundary remains strict", () => {
  assert.equal(isFacebookCachedPostStillFresh(new Date(now - 72 * 60 * 60_000).toISOString(), now), true);
  assert.equal(isFacebookCachedPostStillFresh(new Date(now - 72 * 60 * 60_000 - 1).toISOString(), now), false);
});

test("age detection and extraction reuse the already open dedicated page", () => {
  assert.equal(isExpectedFacebookPostPage("https://www.facebook.com/groups/1/posts/123/", "123"), true);
  assert.equal(isExpectedFacebookPostPage("https://www.facebook.com/groups/1/posts/456/", "123"), false);
});

test("discovery early stop requires a conservative sequence of known old posts", () => {
  const posts = Array.from({ length: 5 }, (_, index) => ({ postId: String(index), publishedAt: new Date(now - (73 + index) * 60 * 60_000).toISOString() }));
  assert.equal(shouldStopForKnownOldSequence(posts, new Set(posts.map((post) => post.postId)), now), true);
  assert.equal(shouldStopForKnownOldSequence([{ ...posts[0], publishedAt: new Date(now - 10 * 60 * 60_000).toISOString() }, ...posts.slice(1)], new Set(posts.map((post) => post.postId)), now), false);
  assert.equal(shouldStopForKnownOldSequence([{ ...posts[0], publishedAt: new Date(now - 72 * 60 * 60_000).toISOString() }, ...posts.slice(1)], new Set(posts.map((post) => post.postId)), now), false);
});

test("discovery loop stops before scrolling on a trailing known-old sequence", async () => {
  const posts = Array.from({ length: 5 }, (_, index) => ({ postId: String(index), permalink: `https://www.facebook.com/groups/1/posts/${index}/`, discoveredPublishedAt: null, freshnessFailure: "FACEBOOK_POST_AGE_UNKNOWN" as const }));
  let scrolls = 0;
  const result = await runFacebookDiscoveryLoop({
    collect: async () => posts,
    scroll: async () => { scrolls += 1; return { moved: true, scrollY: 100 }; },
    lookupKnown: async () => Object.fromEntries(posts.map((post, index) => [post.postId, { publishedAt: new Date(now - (73 + index) * 60 * 60_000).toISOString() }])),
  });
  assert.equal(result.stopReason, "KNOWN_OLD_SEQUENCE");
  assert.equal(scrolls, 0);
});

test("TOO_OLD age cache is reusable while UNKNOWN is never an unsafe old hit", () => {
  const checkedAt = new Date(now - 60_000).toISOString();
  const resultSummary = { ageCache: [
    { postId: "old", checkedAt, publishedAt: new Date(now - 80 * 60 * 60_000).toISOString(), decision: "TOO_OLD", source: "FEED" },
    { postId: "unknown", checkedAt, publishedAt: null, decision: "UNKNOWN", source: "POST_PAGE" },
  ] };
  assert.equal(parseReusableFacebookAgeCache(resultSummary).length, 1);
  const hits = resolveFacebookAgeCacheHits({ currentRunId: "run-2", sources: [{ jobId: "job-1", runId: "run-1", resultSummary }], postIds: ["old", "unknown"], nowMs: now });
  assert.equal(hits.old.decision, "TOO_OLD");
  assert.equal(hits.unknown, undefined);
});

test("expired FRESH age cache requires a normal age recheck", () => {
  const resultSummary = { ageCache: [{ postId: "fresh", checkedAt: new Date(now - FACEBOOK_FRESH_AGE_CACHE_TTL_MS - 1).toISOString(), publishedAt, decision: "FRESH", source: "POST_PAGE_METADATA" }] };
  const hits = resolveFacebookAgeCacheHits({ currentRunId: "run-2", sources: [{ jobId: "job-1", runId: "run-1", resultSummary }], postIds: ["fresh"], nowMs: now });
  assert.equal(hits.fresh, undefined);
});

test("run performance summary aggregates age optimization counters", () => {
  const summary = aggregateFacebookPerformance([{ performance: {
    postsDiscovered: 5, discoveredPostIds: ["1", "2"], duplicatePostIdsSkipped: 0,
    pageOpens: 1, visionCalls: 0, visionCacheHits: 0, knownPostSkips: 2, discoveryScrolls: 3,
    feedAgeHits: 2, ageCacheHits: 2, agePageFallbacks: 1,
    oldPostsSkippedBeforePageOpen: 4, earlyStopOldBoundaryCount: 1,
  } }], 1_500);
  assert.equal(summary.feedAgeHits, 2);
  assert.equal(summary.ageCacheHits, 2);
  assert.equal(summary.agePageFallbacks, 1);
  assert.equal(summary.oldPostsSkippedBeforePageOpen, 4);
  assert.equal(summary.earlyStopOldBoundaryCount, 1);
});
