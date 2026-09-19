/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const test = require("node:test");
require("./collector-core.js");

const core = globalThis.FlipFacebookCollectorCore;

function healthyMetrics(overrides = {}) {
  return {
    uniqueCanonicalPosts: 17,
    capturedPosts: 17,
    freshPosts: 13,
    oldPosts: 1,
    unknownAgePosts: 3,
    duplicateCount: 2,
    visibleCards: 18,
    scrollCount: 18,
    networkResponses: 20,
    networkRecordCount: 17,
    stopReason: "MAX_SCROLLS",
    ...overrides,
  };
}

// A. healthy current-depth -> sufficient -> deeper not triggered
test("A: a healthy scan (18 scrolls, 17 captured, mostly fresh) is sufficient and never pays a deeper-feed penalty", () => {
  const sufficiency = core.evaluateCurrentDepthSufficiency(healthyMetrics());
  assert.equal(sufficiency.sufficient, true);
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "NO_NEW_POSTS_AND_CARDS_3_SCROLLS", aborted: false, metrics: healthyMetrics() });
  assert.equal(transition.triggerDeeper, false);
  assert.equal(transition.reason, "CURRENT_DEPTH_SUFFICIENT");
});

// B. sparse current-depth -> deeper triggered
test("B: a sparse scan (3 unique posts, early stop) triggers deeper feed", () => {
  const metrics = healthyMetrics({ uniqueCanonicalPosts: 3, capturedPosts: 3, freshPosts: 2, duplicateCount: 1, visibleCards: 4, scrollCount: 4 });
  const sufficiency = core.evaluateCurrentDepthSufficiency({ ...metrics, stopReason: "NO_NEW_POSTS_AND_CARDS_3_SCROLLS" });
  assert.equal(sufficiency.sufficient, false);
  assert.ok(sufficiency.reasons.includes("SPARSE_UNIQUE_POST_COUNT"));
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "NO_NEW_POSTS_AND_CARDS_3_SCROLLS", aborted: false, metrics });
  assert.equal(transition.triggerDeeper, true);
});

// C. mostly duplicates -> deeper may trigger
test("C: a duplicate-heavy scan may trigger deeper feed even with a non-trivial raw capture count", () => {
  const metrics = healthyMetrics({ uniqueCanonicalPosts: 6, capturedPosts: 6, duplicateCount: 20, freshPosts: 4, visibleCards: 10, scrollCount: 12 });
  const sufficiency = core.evaluateCurrentDepthSufficiency({ ...metrics, stopReason: "MAX_SCROLLS" });
  assert.equal(sufficiency.sufficient, false);
  assert.ok(sufficiency.reasons.includes("HIGH_DUPLICATE_RATIO"));
});

// D. TEN_CONSECUTIVE_OLDER_THAN_72H -> deeper never triggers
test("D: the 72h frontier is a hard block — deeper never triggers even for a sparse scan", () => {
  const sparse = healthyMetrics({ uniqueCanonicalPosts: 2, capturedPosts: 2, freshPosts: 0 });
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "TEN_CONSECUTIVE_OLDER_THAN_72H", aborted: false, metrics: sparse });
  assert.equal(transition.triggerDeeper, false);
  assert.equal(transition.reason, "TEN_CONSECUTIVE_OLDER_THAN_72H", "the frontier's own detailed reason must not be renamed to something generic");
});

// E. FAST_SCAN_TIME_LIMIT -> deeper never triggers
test("E: the fast-scan time limit is a hard block — deeper never triggers", () => {
  const sparse = healthyMetrics({ uniqueCanonicalPosts: 1, capturedPosts: 1, freshPosts: 0 });
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "FAST_SCAN_TIME_LIMIT", aborted: false, metrics: sparse });
  assert.equal(transition.triggerDeeper, false);
  assert.equal(transition.reason, "FAST_SCAN_TIME_LIMIT");
});

// F. abort -> deeper never triggers
test("F: an aborted collection never triggers deeper feed, regardless of sufficiency", () => {
  const sparse = healthyMetrics({ uniqueCanonicalPosts: 1, capturedPosts: 1, freshPosts: 0 });
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "MAX_SCROLLS", aborted: true, metrics: sparse });
  assert.equal(transition.triggerDeeper, false);
  assert.equal(transition.reason, "ABORTED");
});

// G. lease failure -> deeper never triggers (represented via the same cooperative-abort signal a lease loss would raise)
test("G: a lease-loss abort never triggers deeper feed, regardless of sufficiency", () => {
  const sparse = healthyMetrics({ uniqueCanonicalPosts: 2, capturedPosts: 2, freshPosts: 0 });
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "MAX_SCROLLS", aborted: true, metrics: sparse });
  assert.equal(transition.triggerDeeper, false);
  assert.equal(transition.reason, "ABORTED");
});

test("non-FAST_REPEAT scan modes and SEARCH are never eligible for deeper feed", () => {
  const sparse = healthyMetrics({ uniqueCanonicalPosts: 1, capturedPosts: 1, freshPosts: 0 });
  assert.equal(core.evaluateDeeperFeedTransition({ scanMode: "DEEP_RECALL", searchMode: false, stopReason: "MAX_SCROLLS", aborted: false, metrics: sparse }).triggerDeeper, false);
  assert.equal(core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: true, stopReason: "MAX_SCROLLS", aborted: false, metrics: sparse }).triggerDeeper, false);
});

// H. deeper discovers new posts -> canonical set grows
test("H: continuing to merge into the same records array grows the canonical set when deeper feed finds new posts", () => {
  const source = { sourceType: "GROUP", sourceId: "g", sourceUrl: "https://www.facebook.com/groups/g/" };
  const record = (postId) => ({ postId, permalink: `https://www.facebook.com/groups/g/posts/${postId}/`, sourceId: "g", sourceType: "GROUP", author: null, text: null, publishedAt: null, timestampText: null, media: [], discoveryLayers: ["DOM"], firstSeenIteration: 0 });
  let records = core.mergeRecords([record("1"), record("2")]);
  assert.equal(records.length, 2);
  // Simulate DEEPER_NETWORK_FEED continuing the same accumulation with newly found posts.
  records = core.mergeRecords([...records, record("3"), record("4")]);
  assert.equal(records.length, 4);
  assert.deepEqual(records.map((item) => item.postId).sort(), ["1", "2", "3", "4"]);
  void source;
});

// I. same post in both passes -> processed once
test("I: a post rediscovered in the deeper pass is merged, never duplicated", () => {
  const record = (postId, layer) => ({ postId, permalink: `https://www.facebook.com/groups/g/posts/${postId}/`, sourceId: "g", sourceType: "GROUP", author: null, text: null, publishedAt: null, timestampText: null, media: [], discoveryLayers: [layer], firstSeenIteration: 0 });
  let records = core.mergeRecords([record("1", "DOM"), record("2", "DOM")]);
  assert.equal(records.length, 2);
  // The deeper pass rediscovers post "1" (e.g. via network hydration this time) plus one genuinely new post.
  records = core.mergeRecords([...records, record("1", "NETWORK"), record("3", "DOM")]);
  assert.equal(records.length, 3, "post 1 must be merged, not duplicated");
  const post1 = records.find((item) => item.postId === "1");
  assert.deepEqual(post1.discoveryLayers.sort(), ["DOM", "NETWORK"], "the rediscovery still contributes its evidence, without a second row");
});
