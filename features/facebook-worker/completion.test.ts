import assert from "node:assert/strict";
import test from "node:test";
import { assertFacebookPostsBelongToGroup, parseFacebookCompletionPayload, parseFacebookGroupSnapshot } from "./completion.ts";

const groupA = { id: "group-a", name: "Group A", url: "https://www.facebook.com/groups/group-a/" };
const groupB = { id: "group-b", name: "Group B", url: "https://www.facebook.com/groups/group-b/" };

test("parses exactly one group bound to a queue job", () => assert.deepEqual(parseFacebookGroupSnapshot([groupA]), groupA));
test("job A accepts only posts from group A", () => assert.doesNotThrow(() => assertFacebookPostsBelongToGroup([{ groupId: "group-a" }], groupA)));
test("job B accepts only posts from group B", () => assert.doesNotThrow(() => assertFacebookPostsBelongToGroup([{ groupId: "group-b" }], groupB)));
test("completion rejects a post from another group", () => assert.throws(() => assertFacebookPostsBelongToGroup([{ groupId: "group-b" }], groupA), /FACEBOOK_GROUP_MISMATCH/));

test("completion accepts a server-verifiable cache reference and performance metrics", () => {
  const completion = parseFacebookCompletionPayload({
    jobId: "job-2", leaseToken: "lease-2", workerId: "worker-2", warnings: [], durationMs: 100,
    performance: { postsDiscovered: 1, discoveredPostIds: ["123"], duplicatePostIdsSkipped: 1, pageOpens: 1, visionCalls: 0, visionCacheHits: 1, knownPostSkips: 1, discoveryScrolls: 0, feedAgeHits: 1, ageCacheHits: 0, agePageFallbacks: 0, oldPostsSkippedBeforePageOpen: 1, earlyStopOldBoundaryCount: 1, feedTimestampCandidates: 2, exactBoundFeedTimestamps: 1, rejectedAmbiguousFeedTimestamps: 0, feedAgeHitRate: 1 },
    ageCache: [{ postId: "123", checkedAt: "2026-08-22T10:02:00.000Z", publishedAt: "2026-08-22T10:00:00.000Z", decision: "FRESH", source: "FEED" }],
    posts: [{ postId: "123", groupId: "group-b", permalink: "https://www.facebook.com/groups/group-b/posts/123/", text: "", imageUrls: [], publishedAt: "2026-08-22T10:00:00.000Z", vision: null, cacheHit: { sourceJobId: "job-1", listingId: "listing-1", analyzedAt: "2026-08-22T10:01:00.000Z", scope: "RUN" } }],
  });
  assert.equal(completion.posts[0].cacheHit?.listingId, "listing-1");
  assert.equal(completion.performance.visionCalls, 0);
  assert.equal(completion.performance.feedAgeHits, 1);
  assert.equal(completion.performance.feedTimestampCandidates, 2);
  assert.equal(completion.performance.exactBoundFeedTimestamps, 1);
  assert.equal(completion.performance.feedAgeHitRate, 1);
  assert.equal(completion.ageCache[0].source, "FEED");
});

test("round-trips bounded discovery trace from browser payload", () => {
  const completion = parseFacebookCompletionPayload({
    jobId: "job-trace", leaseToken: "lease-trace", workerId: "worker-trace", warnings: [], durationMs: 100,
    performance: {
      postsDiscovered: 1, discoveredPostIds: ["123"], duplicatePostIdsSkipped: 0, pageOpens: 0, visionCalls: 0,
      visionCacheHits: 0, knownPostSkips: 0, discoveryScrolls: 1, discoveryTrace: [{
        iteration: 0, domPostIds: ["123"], hydrationPostIds: ["123"], networkPostIds: ["123"], mergedPostIds: ["123"],
        visibleCardCount: 1, scrollTop: 0, scrollHeight: 900, feedMode: "UNKNOWN", currentUrl: "https://www.facebook.com/groups/group-a/",
        newIdsThisIteration: 1, networkResponsesSinceLastScroll: 2, hydrationChanged: true, stopReason: "MAX_SCROLLS",
      }],
    },
    ageCache: [], posts: [],
  });
  assert.equal(completion.performance.discoveryTrace?.length, 1);
  assert.deepEqual(completion.performance.discoveryTrace?.[0].mergedPostIds, ["123"]);
  assert.equal(completion.performance.discoveryTrace?.[0].networkResponsesSinceLastScroll, 2);
});
