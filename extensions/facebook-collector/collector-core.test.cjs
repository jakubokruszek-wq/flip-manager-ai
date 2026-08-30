/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const test = require("node:test");
require("./collector-core.js");

const core = globalThis.FlipFacebookCollectorCore;
const source = { sourceType: "GROUP", sourceId: "lodzsprzedazzakupwynajem", sourceUrl: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/" };

test("unions DOM, hydration and network records without losing layers", () => {
  const base = { postId: "1577700267381450", permalink: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/1577700267381450/", sourceId: source.sourceId, sourceType: "GROUP", author: null, text: null, publishedAt: null, timestampText: null, media: [], firstSeenIteration: 0 };
  const records = core.mergeRecords([{ ...base, discoveryLayers: ["DOM"] }, { ...base, text: "Sprzedam mieszkanie", discoveryLayers: ["HYDRATION"] }, { ...base, discoveryLayers: ["NETWORK"] }]);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].discoveryLayers.sort(), ["DOM", "HYDRATION", "NETWORK"]);
  assert.equal(records[0].text, "Sprzedam mieszkanie");
});

test("extracts exact structured post-media binding and rejects foreign, avatar and comment data", () => {
  const body = JSON.stringify({ __typename: "Story", post_id: "1578068947344582", permalink_url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/1578068947344582/", message: { text: "Na sprzedaż 50 m2" }, creation_time: 1788000000, actor: { name: "A", profile_picture: { media_id: "777111", uri: "https://scontent.xx.fbcdn.net/avatar.jpg" } }, feedback: { comments: [{ message: { text: "Sprzedam coś zupełnie innego" } }] }, attachments: [{ __typename: "Photo", media_id: "999111", image: { uri: "https://scontent.xx.fbcdn.net/a.jpg" } }, { __typename: "Story", post_id: "999999999", attachments: [{ __typename: "Photo", media_id: "888111", image: { uri: "https://scontent.xx.fbcdn.net/foreign.jpg" } }] }] });
  const [post] = core.extractStructuredRecordsFromText(body, "NETWORK", source, 2);
  assert.equal(post.postId, "1578068947344582");
  assert.equal(post.media.length, 1);
  assert.equal(post.media[0].mediaId, "999111");
  assert.equal(post.media[0].exactAssociation, true);
  assert.equal(post.text, "Na sprzedaż 50 m2");
});

test("scroll contract requires three scrolls and three consecutive empty iterations", () => {
  assert.equal(core.shouldStopDiscovery({ durationMs: 1000, budgetMs: 110000, uniqueCount: 2, maxPosts: 50, scrolls: 1, maxScrolls: 18, minScrolls: 3, consecutiveNoNew: 1, consecutiveNoVisibleGrowth: 1, consecutiveOldNewPosts: 0 }), null);
  assert.equal(core.shouldStopDiscovery({ durationMs: 1000, budgetMs: 110000, uniqueCount: 2, maxPosts: 50, scrolls: 3, maxScrolls: 18, minScrolls: 3, consecutiveNoNew: 3, consecutiveNoVisibleGrowth: 2, consecutiveOldNewPosts: 0 }), null);
  assert.equal(core.shouldStopDiscovery({ durationMs: 1000, budgetMs: 110000, uniqueCount: 2, maxPosts: 50, scrolls: 3, maxScrolls: 18, minScrolls: 3, consecutiveNoNew: 3, consecutiveNoVisibleGrowth: 3, consecutiveOldNewPosts: 0 }), "NO_NEW_POSTS_AND_CARDS_3_SCROLLS");
});

test("non-chronological fresh-old-fresh-old feed never triggers an early age cutoff", () => {
  const now = Date.parse("2026-08-30T00:00:00Z");
  const fresh = (id) => ({ postId: id, publishedAt: "2026-08-29T12:00:00Z" });
  const old = (id) => ({ postId: id, publishedAt: "2026-08-20T12:00:00Z" });
  let streak = core.updateAgeCutoffStreak(0, [fresh("1"), old("2"), fresh("3"), old("4")], now);
  assert.equal(streak, 1);
  assert.equal(core.shouldStopDiscovery({ durationMs: 20_000, budgetMs: 110_000, uniqueCount: 4, maxPosts: 50, scrolls: 3, maxScrolls: 18, minScrolls: 3, consecutiveNoNew: 0, consecutiveNoVisibleGrowth: 0, consecutiveOldNewPosts: streak }), null);
  streak = core.updateAgeCutoffStreak(streak, [old("5"), old("6"), old("7"), old("8")], now);
  assert.equal(streak, 5);
  assert.equal(core.shouldStopDiscovery({ durationMs: 30_000, budgetMs: 110_000, uniqueCount: 8, maxPosts: 50, scrolls: 4, maxScrolls: 18, minScrolls: 3, consecutiveNoNew: 0, consecutiveNoVisibleGrowth: 0, consecutiveOldNewPosts: streak }), "RELIABLE_AGE_CUTOFF");
});

test("health check prevents false completed status and enables bounded search fallback", () => {
  const health = core.evaluateHealth({ visibleCardCount: 10, capturedPostCount: 1, scrolls: 3, durationMs: 1000, feedGrew: true, newIdsAfterScroll: false, stopReason: "NO_NEW_POSTS_3_SCROLLS" });
  assert.equal(health.status, "DEGRADED");
  assert.equal(core.needsSearchFallback(health, "GROUP"), true);
  assert.equal(core.needsSearchFallback(health, "PROFILE"), false);
  assert.equal(core.evaluateHealth({ visibleCardCount: 0, capturedPostCount: 0, scrolls: 3, durationMs: 1000, feedGrew: false, newIdsAfterScroll: false, stopReason: "NO_NEW_POSTS_3_SCROLLS" }).status, "DEGRADED");
  assert.equal(core.evaluateHealth({ visibleCardCount: 8, capturedPostCount: 5, scrolls: 5, durationMs: 5000, feedGrew: true, newIdsAfterScroll: true, visibleFeedAdvanced: true, capturedAdvanced: false, stopReason: "MAX_SCROLLS" }).status, "DEGRADED");
});

test("ground-truth ids retain discovery layer and first iteration", () => {
  for (const postId of ["1577700267381450", "1578068947344582", "1577710350713775", "4454910774779580", "4453116338292357"]) {
    const link = core.parsePostLink(`https://www.facebook.com/groups/2928219830782023/posts/${postId}/`, { ...source, sourceId: "2928219830782023" });
    assert.equal(link.postId, postId);
  }
  assert.equal(core.parsePostLink("https://www.facebook.com/groups/foreign/posts/1577700267381450/", source), null);
});

test("structured records without an exact source permalink fail closed", () => {
  const records = core.extractStructuredRecordsFromText(JSON.stringify({ __typename: "Story", post_id: "1577700267381450", message: { text: "Sprzedam mieszkanie" } }), "NETWORK", source, 0);
  assert.deepEqual(records, []);
});

test("same canonical post id cannot inherit a different card author or text", () => {
  const base = { postId: "1565561595261984", permalink: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/1565561595261984/", sourceId: source.sourceId, sourceType: "GROUP", publishedAt: null, timestampText: null, media: [], firstSeenIteration: 0, discoveryLayers: ["DOM"], identityConfidence: "EXACT", identityReasons: [] };
  const [record] = core.mergeRecords([
    { ...base, author: "Autor BUY", text: "Kupię mieszkanie w Łodzi" },
    { ...base, author: "Autor SELL", text: "Sprzedam mieszkanie w Łodzi" },
  ]);
  assert.equal(record.identityConfidence, "UNVERIFIED");
  assert.equal(record.author, null);
  assert.equal(record.text, null);
  assert.ok(record.identityReasons.includes("POST_IDENTITY_CONFLICT"));
});

test("merge retains main-feed and search discovery evidence", () => {
  const base = { postId: "1577700267381450", permalink: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/1577700267381450/", sourceId: source.sourceId, sourceType: "GROUP", author: "A", text: "Sprzedam mieszkanie", publishedAt: null, timestampText: null, media: [], firstSeenIteration: 0, identityConfidence: "EXACT", identityReasons: [], discoverySource: "MAIN_FEED", foundInMainFeed: true, firstSeenPhase: "MAIN_FEED" };
  const [record] = core.mergeRecords([base, { ...base, discoverySource: "SEARCH", searchQuery: "mieszkanie", searchQueries: ["mieszkanie"], foundInMainFeed: false, firstSeenPhase: "SEARCH" }]);
  assert.equal(record.foundInMainFeed, true);
  assert.deepEqual(record.searchQueries, ["mieszkanie"]);
  assert.equal(record.firstSeenPhase, "MAIN_FEED");
});
