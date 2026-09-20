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

test("a healthy scan (18 scrolls, 17 captured, mostly fresh) is sufficient and never pays a deeper-feed penalty", () => {
  const sufficiency = core.evaluateCurrentDepthSufficiency(healthyMetrics());
  assert.equal(sufficiency.sufficient, true);
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "NO_NEW_POSTS_AND_CARDS_3_SCROLLS", aborted: false, metrics: healthyMetrics() });
  assert.equal(transition.triggerDeeper, false);
  assert.equal(transition.reason, "CURRENT_DEPTH_SUFFICIENT");
});

test("a sparse scan (3 unique posts, early stop) triggers deeper feed", () => {
  const metrics = healthyMetrics({ uniqueCanonicalPosts: 3, capturedPosts: 3, freshPosts: 2, duplicateCount: 1, visibleCards: 4, scrollCount: 4 });
  const sufficiency = core.evaluateCurrentDepthSufficiency({ ...metrics, stopReason: "NO_NEW_POSTS_AND_CARDS_3_SCROLLS" });
  assert.equal(sufficiency.sufficient, false);
  assert.ok(sufficiency.reasons.includes("SPARSE_UNIQUE_POST_COUNT"));
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "NO_NEW_POSTS_AND_CARDS_3_SCROLLS", aborted: false, metrics });
  assert.equal(transition.triggerDeeper, true);
});

// E. 5 unique / 5 fresh / 100% capture -> sufficient (a small but complete group must not be
// forced through deeper traversal on every run merely for having a low absolute count).
test("E: a small but perfectly complete group (5 unique, 5 fresh, 100% capture) is sufficient", () => {
  const metrics = { uniqueCanonicalPosts: 5, capturedPosts: 5, freshPosts: 5, oldPosts: 0, unknownAgePosts: 0, duplicateCount: 0, visibleCards: 5, scrollCount: 6, stopReason: "NO_NEW_POSTS_AND_CARDS_3_SCROLLS" };
  const sufficiency = core.evaluateCurrentDepthSufficiency(metrics);
  assert.equal(sufficiency.sufficient, true, JSON.stringify(sufficiency));
  assert.deepEqual(sufficiency.reasons, ["SMALL_HIGH_QUALITY_COVERAGE"]);
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: metrics.stopReason, aborted: false, metrics });
  assert.equal(transition.triggerDeeper, false);
});

test("a small group that is NOT high quality (low fresh ratio or low capture ratio) still triggers deeper", () => {
  const lowFreshRatio = { uniqueCanonicalPosts: 5, capturedPosts: 5, freshPosts: 2, visibleCards: 5, scrollCount: 6, stopReason: "MAX_SCROLLS" };
  assert.equal(core.evaluateCurrentDepthSufficiency(lowFreshRatio).sufficient, false);
  const lowCaptureRatio = { uniqueCanonicalPosts: 5, capturedPosts: 5, freshPosts: 5, visibleCards: 12, scrollCount: 6, stopReason: "MAX_SCROLLS" };
  assert.equal(core.evaluateCurrentDepthSufficiency(lowCaptureRatio).sufficient, false);
});

// F. 2 unique / 0 fresh -> deeper
test("F: 2 unique posts with zero fresh posts triggers deeper feed", () => {
  const sparse = healthyMetrics({ uniqueCanonicalPosts: 2, capturedPosts: 2, freshPosts: 0 });
  const sufficiency = core.evaluateCurrentDepthSufficiency({ ...sparse, stopReason: "MAX_SCROLLS" });
  assert.equal(sufficiency.sufficient, false);
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "MAX_SCROLLS", aborted: false, metrics: sparse });
  assert.equal(transition.triggerDeeper, true);
});

test("many posts but zero fresh still triggers deeper", () => {
  const metrics = healthyMetrics({ uniqueCanonicalPosts: 20, capturedPosts: 20, freshPosts: 0, visibleCards: 20 });
  assert.equal(core.evaluateCurrentDepthSufficiency(metrics).sufficient, false);
});

test("a very low capture ratio with enough visible cards is judged insufficient (feed evidence suggests incompleteness)", () => {
  const metrics = { uniqueCanonicalPosts: 10, capturedPosts: 10, freshPosts: 8, visibleCards: 40, scrollCount: 10, stopReason: "MAX_SCROLLS" };
  const sufficiency = core.evaluateCurrentDepthSufficiency(metrics);
  assert.equal(sufficiency.sufficient, false);
  assert.ok(sufficiency.reasons.includes("LOW_CAPTURE_RATIO"), JSON.stringify(sufficiency));
});

// G. duplicate signal does NOT grow merely because the persistent network Map / DOM / hydration
// set is re-snapshotted across iterations.
test("G: isDuplicateRediscoveryIteration never fires from re-snapshot volume alone — only from genuinely new-this-iteration evidence", () => {
  // A large, ever-growing "already known" set contributes nothing here: this
  // predicate only ever looks at pre-diffed per-iteration deltas, never a raw
  // array/Map length.
  assert.equal(core.isDuplicateRediscoveryIteration({ iteration: 5, newVisibleCards: 0, networkResponsesThisIteration: 0, added: 0 }), false, "no new evidence at all is normal convergence, not a duplicate");
  assert.equal(core.isDuplicateRediscoveryIteration({ iteration: 0, newVisibleCards: 5, networkResponsesThisIteration: 5, added: 0 }), false, "the very first iteration is never counted (nothing to diff against yet)");
});

// H. real repeated canonical sightings can still be measured if the duplicate signal remains enabled.
test("H: genuinely new evidence that yields no new canonical post IS counted as a duplicate-rediscovery iteration", () => {
  assert.equal(core.isDuplicateRediscoveryIteration({ iteration: 3, newVisibleCards: 2, networkResponsesThisIteration: 0, added: 0 }), true, "new DOM cards rendered but nothing new was merged");
  assert.equal(core.isDuplicateRediscoveryIteration({ iteration: 3, newVisibleCards: 0, networkResponsesThisIteration: 1, added: 0 }), true, "a new network response landed but nothing new was merged");
  assert.equal(core.isDuplicateRediscoveryIteration({ iteration: 3, newVisibleCards: 2, networkResponsesThisIteration: 1, added: 2 }), false, "new evidence that DID yield new posts is not a duplicate iteration");
});

test("a duplicate-heavy run (many wasted iterations relative to scroll count) is judged insufficient", () => {
  const metrics = { uniqueCanonicalPosts: 6, capturedPosts: 6, freshPosts: 4, duplicateCount: 8, visibleCards: 10, scrollCount: 12, stopReason: "MAX_SCROLLS" };
  const sufficiency = core.evaluateCurrentDepthSufficiency(metrics);
  assert.equal(sufficiency.sufficient, false);
  assert.ok(sufficiency.reasons.includes("HIGH_DUPLICATE_RATIO"), JSON.stringify(sufficiency));
});

test("the duplicate ratio never grows just because scrollCount is small and duplicateCount stays proportionally low", () => {
  // 1 wasted iteration out of 18 scrolls is not "duplicate-heavy" — proves the
  // ratio is scrollCount-relative, not merely present/absent.
  const metrics = healthyMetrics({ duplicateCount: 1, scrollCount: 18 });
  const sufficiency = core.evaluateCurrentDepthSufficiency(metrics);
  assert.ok(!sufficiency.reasons.includes("HIGH_DUPLICATE_RATIO"));
});

// N. TEN_CONSECUTIVE_OLDER_THAN_72H -> deeper never triggers
test("N: the 72h frontier is a hard block — deeper never triggers even for a sparse scan", () => {
  const sparse = healthyMetrics({ uniqueCanonicalPosts: 2, capturedPosts: 2, freshPosts: 0 });
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "TEN_CONSECUTIVE_OLDER_THAN_72H", aborted: false, metrics: sparse });
  assert.equal(transition.triggerDeeper, false);
  assert.equal(transition.reason, "TEN_CONSECUTIVE_OLDER_THAN_72H", "the frontier's own detailed reason must not be renamed to something generic");
});

// O. FAST_SCAN_TIME_LIMIT -> deeper never triggers
test("O: the fast-scan time limit is a hard block — deeper never triggers", () => {
  const sparse = healthyMetrics({ uniqueCanonicalPosts: 1, capturedPosts: 1, freshPosts: 0 });
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "FAST_SCAN_TIME_LIMIT", aborted: false, metrics: sparse });
  assert.equal(transition.triggerDeeper, false);
  assert.equal(transition.reason, "FAST_SCAN_TIME_LIMIT");
});

test("an aborted collection never triggers deeper feed, regardless of sufficiency", () => {
  const sparse = healthyMetrics({ uniqueCanonicalPosts: 1, capturedPosts: 1, freshPosts: 0 });
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "MAX_SCROLLS", aborted: true, metrics: sparse });
  assert.equal(transition.triggerDeeper, false);
  assert.equal(transition.reason, "ABORTED");
});

// M. hard block precedence: abort + otherwise healthy metrics -> abort wins
test("M: abort wins even when the metrics would otherwise have been judged healthy/sufficient", () => {
  const healthy = healthyMetrics();
  // Prove, independently, that these exact metrics WOULD be sufficient without the abort.
  assert.equal(core.evaluateCurrentDepthSufficiency(healthy).sufficient, true);
  const transition = core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: false, stopReason: "NO_NEW_POSTS_AND_CARDS_3_SCROLLS", aborted: true, metrics: healthy });
  assert.equal(transition.triggerDeeper, false);
  assert.equal(transition.reason, "ABORTED", "abort must be checked and win before sufficiency is even consulted");
});

test("non-FAST_REPEAT scan modes and SEARCH are never eligible for deeper feed", () => {
  const sparse = healthyMetrics({ uniqueCanonicalPosts: 1, capturedPosts: 1, freshPosts: 0 });
  assert.equal(core.evaluateDeeperFeedTransition({ scanMode: "DEEP_RECALL", searchMode: false, stopReason: "MAX_SCROLLS", aborted: false, metrics: sparse }).triggerDeeper, false);
  assert.equal(core.evaluateDeeperFeedTransition({ scanMode: "FAST_REPEAT", searchMode: true, stopReason: "MAX_SCROLLS", aborted: false, metrics: sparse }).triggerDeeper, false);
});

// deeper discovers new posts -> canonical set grows
test("continuing to merge into the same records array grows the canonical set when deeper feed finds new posts", () => {
  const record = (postId) => ({ postId, permalink: `https://www.facebook.com/groups/g/posts/${postId}/`, sourceId: "g", sourceType: "GROUP", author: null, text: null, publishedAt: null, timestampText: null, media: [], discoveryLayers: ["DOM"], firstSeenIteration: 0 });
  let records = core.mergeRecords([record("1"), record("2")]);
  assert.equal(records.length, 2);
  // Simulate DEEPER_NETWORK_FEED continuing the same accumulation with newly found posts.
  records = core.mergeRecords([...records, record("3"), record("4")]);
  assert.equal(records.length, 4);
  assert.deepEqual(records.map((item) => item.postId).sort(), ["1", "2", "3", "4"]);
});

// I. dedup identity across current/deeper remains intact -> same post in both passes -> processed once
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

// Recall engine V1.2: evaluateExplorationContinuation — the minimum
// exploration floor / value-based continuation envelope that decides whether
// NO_NEW_POSTS_AND_CARDS_3_SCROLLS alone is allowed to stop a normal
// FAST_REPEAT main-feed pass, using only existing scroll/network signals.
function explorable(overrides = {}) {
  return { elapsedMs: 7_091, atBottom: false, scrollHeightGrewRecently: false, networkStillActive: false, ...overrides };
}

// A. the exact real production canary shape (17 scrolls / 14 posts / ~7s / NO_NEW_3) is still expandable -> continue deeper
test("A: the real production canary shape (~7s, well under the floor, not at the physical bottom) must continue exploring", () => {
  const decision = core.evaluateExplorationContinuation(explorable({ elapsedMs: 7_091, atBottom: false }));
  assert.equal(decision.continue, true);
  assert.equal(decision.reason, "BELOW_MIN_EXPLORATION_FLOOR");
});

// B. the same ~7s shape but the feed is confirmed non-expandable (physical bottom, no growth, no network) -> stopping is allowed
test("B: the same ~7s shape but confirmed non-expandable (at the bottom, nothing else moving) may still stop", () => {
  const decision = core.evaluateExplorationContinuation(explorable({ elapsedMs: 7_091, atBottom: true, scrollHeightGrewRecently: false, networkStillActive: false }));
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, "FEED_NOT_EXPANDABLE");
});

// C. 25+ scrolls / adequate exploration / genuinely exhausted by the outer envelope -> stop normally, even if still technically "not at the bottom"
test("C: past the outer 60s exploration envelope, normal traversal always terminates gracefully", () => {
  const decision = core.evaluateExplorationContinuation(explorable({ elapsedMs: 60_000, atBottom: false, scrollHeightGrewRecently: true, networkStillActive: true }));
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, "NORMAL_EXPLORATION_ENVELOPE_COMPLETE");
});

test("within the 15-30s preferred window, ordinary expansion evidence (network still active) is enough to continue", () => {
  const decision = core.evaluateExplorationContinuation(explorable({ elapsedMs: 20_000, atBottom: true, scrollHeightGrewRecently: false, networkStillActive: true }));
  assert.equal(decision.continue, true);
  assert.equal(decision.reason, "WITHIN_PREFERRED_EXPLORATION_WINDOW");
});

test("within the 15-30s preferred window, a confirmed non-expandable feed may still stop", () => {
  const decision = core.evaluateExplorationContinuation(explorable({ elapsedMs: 20_000, atBottom: true, scrollHeightGrewRecently: false, networkStillActive: false }));
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, "FEED_NOT_EXPANDABLE");
});

test("between 30-60s the bar is stricter: merely 'not confirmed at the bottom' is no longer enough on its own", () => {
  const decision = core.evaluateExplorationContinuation(explorable({ elapsedMs: 45_000, atBottom: false, scrollHeightGrewRecently: false, networkStillActive: true }));
  assert.equal(decision.continue, false, "network activity alone does not clear the 30-60s bar the way it does before 30s");
  assert.equal(decision.reason, "NO_ADDITIONAL_RECALL_VALUE_EVIDENCE");
});

test("between 30-60s, concrete structural growth (scrollHeight still expanding, not at the bottom) does clear the stricter bar", () => {
  const decision = core.evaluateExplorationContinuation(explorable({ elapsedMs: 45_000, atBottom: false, scrollHeightGrewRecently: true }));
  assert.equal(decision.continue, true);
  assert.equal(decision.reason, "VALUE_BASED_CONTINUATION_EVIDENCE");
});

test("the 60s outer envelope always wins even when every expandability signal still looks favorable", () => {
  const decision = core.evaluateExplorationContinuation(explorable({ elapsedMs: 90_000, atBottom: false, scrollHeightGrewRecently: true, networkStillActive: true }));
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, "NORMAL_EXPLORATION_ENVELOPE_COMPLETE");
});
