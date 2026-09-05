import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCollectorHealth, normalizeFacebookCollectorBatch } from "./facebook-batch.ts";

const sourceId = "lodzsprzedazzakupwynajem";

test("normalizes a healthy exact-source collector batch and deduplicates posts", () => {
  const post = { postId: "1577700267381450", permalink: `https://www.facebook.com/groups/${sourceId}/posts/1577700267381450/`, sourceId, sourceType: "GROUP", author: "A", text: "Sprzedam mieszkanie", publishedAt: "2026-08-29T10:00:00Z", timestampText: "2 godz.", media: [{ url: "https://scontent.example/image.jpg", mediaId: "99", exactPostId: "1577700267381450", exactAssociation: true, discoveryLayers: ["DOM"] }], discoveryLayers: ["DOM", "NETWORK"], firstSeenIteration: 0 };
  const batch = normalizeFacebookCollectorBatch({ scanId: "11111111-1111-4111-8111-111111111111", batchId: "22222222-2222-4222-8222-222222222222", sourceId, sourceType: "GROUP", sourceUrl: `https://www.facebook.com/groups/${sourceId}/`, collectedAt: "2026-08-29T12:00:00Z", health: { status: "HEALTHY", visibleCardCount: 1, capturedPostCount: 1, scrolls: 3, durationMs: 5000, stopReason: "NO_NEW_IDS", reasons: [] }, posts: [post, post] });
  assert.equal(batch.posts.length, 1);
  assert.equal(batch.posts[0]?.media[0]?.exactAssociation, true);
});

test("normalizes bounded per-query search telemetry without affecting post identity", () => {
  const batch = normalizeFacebookCollectorBatch({
    scanId: "11111111-1111-4111-8111-111111111111",
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceId,
    sourceType: "GROUP",
    sourceUrl: `https://www.facebook.com/groups/${sourceId}/`,
    collectedAt: "2026-08-29T12:00:00Z",
    health: { status: "DEGRADED", visibleCardCount: 0, capturedPostCount: 0, scrolls: 5, durationMs: 90_000, stopReason: "SEARCH_GLOBAL_TIME_BUDGET", reasons: ["COLLECTOR_SEARCH_GLOBAL_TIME_BUDGET"] },
    searchTelemetry: {
      hardTimeBudgetMs: 90_000,
      durationMs: 90_000,
      queriesPlanned: 6,
      queriesExecuted: 5,
      budgetExhausted: true,
      queries: [{ query: "sprzedam", executed: true, status: "HEALTHY", scrolls: 3, visibleCards: 12, captured: 1, unique: 1, duplicatesVsMainFeed: 0, uniqueContribution: 1, sellContribution: 1, tilesSeen: 5, tilesOpened: 5, tilesResolved: 5, tilesUnverified: 0, uniqueParentPosts: 1, verifiedParentPosts: 1, duplicatesByMedia: 4, durationMs: 14_500, stopReason: "MAX_SCROLLS" }],
    },
    posts: [],
  });
  assert.equal(batch.searchTelemetry?.hardTimeBudgetMs, 90_000);
  assert.equal(batch.searchTelemetry?.budgetExhausted, true);
  assert.deepEqual(batch.searchTelemetry?.queries[0], { query: "sprzedam", executed: true, status: "HEALTHY", scrolls: 3, visibleCards: 12, captured: 1, unique: 1, duplicatesVsMainFeed: 0, uniqueContribution: 1, sellContribution: 1, tilesSeen: 5, tilesOpened: 5, tilesResolved: 5, tilesUnverified: 0, uniqueParentPosts: 1, verifiedParentPosts: 1, duplicatesByMedia: 4, durationMs: 14_500, stopReason: "MAX_SCROLLS" });
});

test("keeps discovery coverage separate from the bounded resolution cap", () => {
  const batch = normalizeFacebookCollectorBatch({
    scanId: "11111111-1111-4111-8111-111111111111",
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceId,
    sourceType: "GROUP",
    sourceUrl: `https://www.facebook.com/groups/${sourceId}/`,
    collectedAt: "2026-08-29T12:00:00Z",
    health: { status: "DEGRADED", visibleCardCount: 10, capturedPostCount: 0, scrolls: 30, durationMs: 30_000, stopReason: "QUERY_TIME_BUDGET", reasons: [] },
    searchTelemetry: {
      hardTimeBudgetMs: 280_000,
      durationMs: 34_000,
      queriesPlanned: 7,
      queriesExecuted: 1,
      budgetExhausted: false,
      queries: [{ query: "sprzedam", executed: true, status: "DEGRADED", scrolls: 30, scrollCount: 30, visibleCards: 10, captured: 0, unique: 0, duplicatesVsMainFeed: 0, uniqueContribution: 0, sellContribution: 0, tilesSeen: 100, rawTilesSeen: 220, uniqueTilesFound: 120, candidateBufferSize: 100, candidateCapReached: true, resolutionCandidates: 10, tilesOpened: 10, tilesResolved: 0, tilesUnverified: 10, uniqueParentPosts: 0, verifiedParentPosts: 0, duplicatesByMedia: 0, discoveryDurationMs: 30_000, discoveryDuration: 30_000, resolutionDurationMs: 4_000, resolutionDuration: 4_000, discoveryStopReason: "QUERY_TIME_BUDGET", resolutionStopReason: "RESOLUTION_TIME_BUDGET", discoveryEvidence: { scrollAttempts: 30, reachedBottom: false, consecutiveBottomChecks: 0, stableScrollPosition: false, urlStable: true, pageErrorFree: true, consecutiveNoGrowthChecks: 2, consecutiveNoVisibleGrowthChecks: 2, networkQuietChecks: 1, noPendingContent: false, finalScrollTop: 1000, finalScrollHeight: 5000, viewportHeight: 900, uniqueTileProgression: [100, 110, 120] }, durationMs: 34_000, stopReason: "RESOLUTION_TIME_BUDGET" }],
    },
    posts: [],
  });
  const query = batch.searchTelemetry?.queries[0];
  assert.equal(query?.rawTilesSeen, 220);
  assert.equal(query?.uniqueTilesFound, 120);
  assert.equal(query?.candidateCapReached, true);
  assert.equal(query?.resolutionCandidates, 10);
  assert.equal(query?.discoveryDurationMs, 30_000);
  assert.equal(query?.scrollCount, 30);
  assert.equal(query?.discoveryEvidence?.reachedBottom, false);
  assert.equal(query?.discoveryEvidence?.urlStable, true);
  assert.deepEqual(query?.discoveryEvidence?.uniqueTileProgression, [100, 110, 120]);
});

test("preserves verified media-tile discovery provenance without gallery media", () => {
  const postId = "1576413074176836";
  const batch = normalizeFacebookCollectorBatch({
    scanId: "11111111-1111-4111-8111-111111111111", batchId: "22222222-2222-4222-8222-222222222222", sourceId, sourceType: "GROUP", sourceUrl: `https://www.facebook.com/groups/${sourceId}/`, collectedAt: "2026-08-29T12:00:00Z",
    health: { status: "HEALTHY", visibleCardCount: 0, capturedPostCount: 1, scrolls: 3, durationMs: 14_000, stopReason: "SEARCH_FALLBACK_COMPLETED", reasons: [] },
    posts: [{ postId, permalink: `https://www.facebook.com/groups/${sourceId}/posts/${postId}/`, sourceId, sourceType: "GROUP", author: "Anna Balcerek", text: "Sprzedam 3 pokoje, 46,77 m2", media: [], discoveryLayers: ["SEARCH_MEDIA_RESOLVE"], firstSeenIteration: 0, identityConfidence: "EXACT", identityReasons: ["STRUCTURED_EXACT_MEDIA_CONTAINER_STORY"], discoverySource: "SEARCH", searchQuery: "sprzedam", searchQueries: ["sprzedam"], foundInMainFeed: false, firstSeenPhase: "SEARCH", resolvedFromMediaTile: true, mediaIds: ["28074641558832168"], parentResolutionEvidence: ["STRUCTURED_EXACT_MEDIA_CONTAINER_STORY"] }],
  });
  assert.equal(batch.posts[0]?.resolvedFromMediaTile, true);
  assert.deepEqual(batch.posts[0]?.mediaIds, ["28074641558832168"]);
  assert.deepEqual(batch.posts[0]?.media, []);
  assert.equal(batch.posts[0]?.identityConfidence, "EXACT");
});

test("normalizes bounded diagnostic telemetry without accepting raw DOM or secrets", () => {
  const batch = normalizeFacebookCollectorBatch({
    scanId: "11111111-1111-4111-8111-111111111111", batchId: "22222222-2222-4222-8222-222222222222", sourceId, sourceType: "GROUP", sourceUrl: `https://www.facebook.com/groups/${sourceId}/`, collectedAt: "2026-08-29T12:00:00Z",
    health: { status: "DEGRADED", visibleCardCount: 1, capturedPostCount: 0, scrolls: 3, durationMs: 5000, stopReason: "ROOT_TEXT_FOUND", reasons: [] }, posts: [],
    mainFeedTelemetry: [{ postId: "1577700267381450", sourceLayer: "DOM", structuredAuthorPresent: false, structuredTextPresent: false, structuredTextPath: null, rootCardFound: true, rootCardPostIdBound: true, rootCardPermalink: `https://www.facebook.com/groups/${sourceId}/posts/1577700267381450/`, rootAuthorFound: true, rootTextFound: false, seeMorePresent: true, seeMoreClicked: true, rootTextAfterExpand: false, authorMatch: true, postIdMatch: true, finalIdentity: "UNVERIFIED", failSubstep: "ROOT_TEXT_FOUND", token: "must-not-survive" }],
    searchTelemetry: { hardTimeBudgetMs: 90000, durationMs: 100, queriesPlanned: 1, queriesExecuted: 1, budgetExhausted: false, queries: [{ query: "mieszkanie", executed: true, status: "DEGRADED", scrolls: 1, visibleCards: 1, captured: 0, unique: 0, duplicatesVsMainFeed: 0, uniqueContribution: 0, sellContribution: 0, tilesSeen: 1, tilesOpened: 1, tilesResolved: 0, tilesUnverified: 1, uniqueParentPosts: 0, verifiedParentPosts: 0, duplicatesByMedia: 0, durationMs: 100, stopReason: "SEARCH_ROOT_TEXT_MISSING", tileDiagnostics: [{ query: "mieszkanie", mediaId: "28074641558832168", photoOpened: true, structuredPayloadFound: true, currMediaId: "28074641558832168", containerStoryPostId: null, topLevelPostId: null, mediaAttachmentCrosscheck: false, parentPostId: null, parentPermalink: null, rootAuthorFound: false, rootTextFound: false, identityResult: "UNVERIFIED", failSubstep: "SEARCH_CONTAINER_STORY_MISSING", elapsedMs: 30, secret: "must-not-survive" }] }] },
  });
  assert.equal(batch.mainFeedTelemetry?.[0]?.failSubstep, "ROOT_TEXT_FOUND");
  assert.equal((batch.mainFeedTelemetry?.[0] as Record<string, unknown>).token, undefined);
  assert.equal(batch.searchTelemetry?.queries[0]?.tileDiagnostics?.[0]?.failSubstep, "SEARCH_CONTAINER_STORY_MISSING");
  assert.equal((batch.searchTelemetry?.queries[0]?.tileDiagnostics?.[0] as Record<string, unknown>).secret, undefined);
});

test("fails closed on source mismatch and forged media association", () => {
  const raw = { scanId: "11111111-1111-4111-8111-111111111111", batchId: "22222222-2222-4222-8222-222222222222", sourceId, sourceType: "GROUP", sourceUrl: `https://www.facebook.com/groups/${sourceId}/`, collectedAt: "2026-08-29T12:00:00Z", health: { status: "HEALTHY", visibleCardCount: 1, capturedPostCount: 1, scrolls: 3, durationMs: 5000, stopReason: "MAX_POSTS", reasons: [] }, posts: [{ postId: "1577700267381450", permalink: `https://www.facebook.com/groups/${sourceId}/posts/1577700267381450/`, sourceId, sourceType: "GROUP", media: [{ url: "https://scontent.example/image.jpg", exactPostId: "foreign", exactAssociation: true }], discoveryLayers: ["DOM"], firstSeenIteration: 0 }] };
  const batch = normalizeFacebookCollectorBatch(raw);
  assert.equal(batch.posts[0]?.media[0]?.exactAssociation, false);
  assert.throws(() => normalizeFacebookCollectorBatch({ ...raw, posts: [{ ...raw.posts[0], sourceId: "foreign" }] }), /COLLECTOR_POST_SOURCE_MISMATCH/);
  assert.throws(() => normalizeFacebookCollectorBatch({ ...raw, sourceId: "foreign" }), /COLLECTOR_SOURCE_URL_ID_MISMATCH/);
  assert.throws(() => normalizeFacebookCollectorBatch({ ...raw, posts: [{ ...raw.posts[0], permalink: "https://www.facebook.com/groups/foreign/posts/1577700267381450/" }] }), /COLLECTOR_POST_SOURCE_URL_MISMATCH/);
});

test("health check marks low coverage and growing feeds without IDs as degraded", () => {
  const health = evaluateCollectorHealth({ visibleCardCount: 10, capturedPostCount: 2, scrolls: 3, durationMs: 8000, feedGrew: true, newIdsAfterScroll: false, stopReason: "NO_NEW_IDS" });
  assert.equal(health.status, "DEGRADED");
  assert.deepEqual(health.reasons, ["COLLECTOR_LOW_CAPTURE_COUNT", "COLLECTOR_LOW_CAPTURE_RATIO", "COLLECTOR_GROWING_FEED_WITHOUT_NEW_IDS"]);
});

test("one failed discovery layer does not degrade a healthy union", () => {
  const health = evaluateCollectorHealth({ visibleCardCount: 8, capturedPostCount: 8, scrolls: 3, durationMs: 8000, feedGrew: true, newIdsAfterScroll: true, stopReason: "MAX_POSTS" });
  assert.equal(health.status, "HEALTHY");
});

test("zero visible and zero captured posts never reports a false healthy completion", () => {
  const health = evaluateCollectorHealth({ visibleCardCount: 0, capturedPostCount: 0, scrolls: 3, durationMs: 10_000, feedGrew: false, newIdsAfterScroll: false, stopReason: "NO_NEW_POSTS_3_SCROLLS" });
  assert.equal(health.status, "DEGRADED");
  assert.deepEqual(health.reasons, ["COLLECTOR_NO_VISIBLE_OR_CAPTURED_POSTS"]);
});

test("growing visible feed with stalled unique capture is degraded", () => {
  const health = evaluateCollectorHealth({ visibleCardCount: 8, capturedPostCount: 5, scrolls: 5, durationMs: 20_000, feedGrew: true, newIdsAfterScroll: true, visibleFeedAdvanced: true, capturedAdvanced: false, stopReason: "MAX_SCROLLS" });
  assert.equal(health.status, "DEGRADED");
  assert.match(health.reasons.join(","), /COLLECTOR_VISIBLE_FEED_ADVANCED_WITHOUT_CAPTURE_GROWTH/);
});
