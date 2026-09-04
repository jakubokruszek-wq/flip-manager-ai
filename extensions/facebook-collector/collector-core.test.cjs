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

test("photo media fbid is never promoted to a canonical post id", () => {
  assert.equal(core.parsePostLink("https://www.facebook.com/photo/?fbid=28074641558832168&set=pcb.1576413074176836", source), null);
  assert.equal(core.parsePostLink("https://www.facebook.com/photo.php?fbid=28074641558832168", source), null);
});

test("search media resolver binds five tiles to five distinct exact container stories", () => {
  const photos = Array.from({ length: 5 }, (_, index) => {
    const mediaId = `2807464155883216${index}`;
    const postId = `157641307417683${index}`;
    return { __typename: "Photo", id: mediaId, image: { uri: `https://scontent.xx.fbcdn.net/${mediaId}.jpg` }, container_story: { __typename: "Story", post_id: postId, url: `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/permalink/${postId}/`, actors: [{ name: `Author ${index}` }], message: { text: `Exact text ${index}` } } };
  });
  const body = JSON.stringify({ data: { photos } });
  const records = photos.flatMap((photo) => core.resolveSearchMediaParentFromText(body, "SEARCH_MEDIA_RESOLVE", source, photo.id));
  assert.deepEqual(records.map((record) => record.postId), photos.map((photo) => photo.container_story.post_id));
  assert.equal(new Set(records.map((record) => record.postId)).size, 5);
  records.forEach((record, index) => {
    assert.equal(record.author, `Author ${index}`);
    assert.equal(record.text, `Exact text ${index}`);
    assert.equal(record.identityConfidence, "EXACT");
    assert.equal(record.media[0].mediaId, photos[index].id);
    assert.equal(record.media[0].exactPostId, record.postId);
    assert.equal(record.media[0].exactAssociation, true);
  });
});

test("search media resolver cannot leak a neighboring story and fails closed without full identity", () => {
  const body = JSON.stringify({ data: [
    { __typename: "Photo", id: "28074641558832168", image: { uri: "https://scontent.xx.fbcdn.net/expected.jpg" }, container_story: { __typename: "Story", post_id: "1576413074176836", url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/permalink/1576413074176836/", actors: [{ name: "Expected Author" }], message: { text: "Expected text" } } },
    { __typename: "Photo", id: "28074642035498787", image: { uri: "https://scontent.xx.fbcdn.net/neighbor.jpg" }, container_story: { __typename: "Story", post_id: "1576413094176834", url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/permalink/1576413094176834/", actors: [{ name: "Neighbor Author" }], message: { text: "Neighbor text" } } },
  ] });
  const [record] = core.resolveSearchMediaParentFromText(body, "SEARCH_MEDIA_RESOLVE", source, "28074641558832168");
  assert.equal(record.postId, "1576413074176836");
  assert.equal(record.author, "Expected Author");
  assert.equal(record.text, "Expected text");
  assert.equal(core.resolveSearchMediaParentFromText(body, "SEARCH_MEDIA_RESOLVE", source, "99999999999999999").length, 0);

  const [unverified] = core.resolveSearchMediaParentFromText(JSON.stringify({ __typename: "Photo", id: "28074641558832168", image: { uri: "https://scontent.xx.fbcdn.net/expected.jpg" }, container_story: { __typename: "Story", post_id: "1576413074176836", url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/permalink/1576413074176836/", message: { text: "No author" } } }), "SEARCH_MEDIA_RESOLVE", source, "28074641558832168");
  assert.equal(unverified.identityConfidence, "UNVERIFIED");
  assert.equal(unverified.media[0].exactAssociation, false);
});

test("search media resolver accepts explicit top-level tracking binding without importing unverified media", () => {
  const story = { __typename: "Story", post_id: "1576413074176836", url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/permalink/1576413074176836/", actors: [{ name: "Anna" }], message: { text: "Sprzedam mieszkanie" }, tracking: JSON.stringify({ top_level_post_id: "1576413074176836", photo_attachments_list: ["28074641558832168", "28074642035498787"] }) };
  const [record] = core.resolveSearchMediaParentFromText(JSON.stringify(story), "SEARCH_MEDIA_RESOLVE", source, "28074642035498787");
  assert.equal(record.postId, "1576413074176836");
  assert.equal(record.identityConfidence, "EXACT");
  assert.deepEqual(record.identityReasons, ["STRUCTURED_EXACT_MEDIA_TRACKING_TO_STORY"]);
  assert.deepEqual(record.media, []);
  assert.equal(core.resolveSearchMediaParentFromText(JSON.stringify(story), "SEARCH_MEDIA_RESOLVE", source, "99999999999999999").length, 0);
});

test("verified media parent gate rejects ambiguity and wrong association", () => {
  const record = (postId, mediaId, exactPostId = postId) => ({ postId, permalink: `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/${postId}/`, sourceId: source.sourceId, sourceType: "GROUP", author: "Anna", text: "Sprzedam mieszkanie", media: [{ url: `https://scontent.xx.fbcdn.net/${mediaId}.jpg`, mediaId, exactPostId, exactAssociation: exactPostId === postId }], identityConfidence: "EXACT", identityReasons: ["STRUCTURED_EXACT_MEDIA_CONTAINER_STORY"], discoveryLayers: ["SEARCH_MEDIA_RESOLVE"], firstSeenIteration: 0 });
  const expectedMediaId = "28074641558832168";
  assert.equal(core.verifySearchMediaParent([record("1576413074176836", expectedMediaId), record("1576413080843502", expectedMediaId)], expectedMediaId).status, "UNVERIFIED");
  assert.equal(core.verifySearchMediaParent([record("1576413074176836", expectedMediaId, "1576413080843502")], expectedMediaId).status, "UNVERIFIED");
  const verified = core.verifySearchMediaParent([record("1576413074176836", expectedMediaId)], expectedMediaId);
  assert.equal(verified.status, "VERIFIED");
  assert.equal(verified.records[0].resolvedFromMediaTile, true);
  assert.deepEqual(verified.records[0].media, []);
});

test("five resolved media tiles collapse to one parent with complete discovery provenance", () => {
  const postId = "1576413074176836";
  const records = Array.from({ length: 5 }, (_, index) => ({ postId, permalink: `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/${postId}/`, sourceId: source.sourceId, sourceType: "GROUP", author: "Anna Balcerek", text: "Sprzedam 3 pokoje, 46,77 m2", media: [], identityConfidence: "EXACT", identityReasons: ["STRUCTURED_EXACT_MEDIA_CONTAINER_STORY"], discoveryLayers: ["SEARCH_MEDIA_RESOLVE"], firstSeenIteration: 0, discoverySource: "SEARCH", searchQuery: "sprzedam", searchQueries: ["sprzedam"], foundInMainFeed: false, firstSeenPhase: "SEARCH", resolvedFromMediaTile: true, mediaIds: [`2807464155883216${index}`], parentResolutionEvidence: ["STRUCTURED_EXACT_MEDIA_CONTAINER_STORY"] }));
  const merged = core.mergeRecords(records);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].mediaIds.length, 5);
  assert.deepEqual(merged[0].media, []);
  assert.equal(merged[0].identityConfidence, "EXACT");
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

test("root story author and message are exact-bound with explicit provenance", () => {
  const verified = core.resolveRootStoryIdentity({ rootPostId: "1579666997184777", author: "Oleh Zaitsev", text: "Na sprzedaż mieszkanie 52 m²", rootAuthorSource: "ROOT_CARD_AUTHOR", rootTextSource: "ROOT_CARD_MESSAGE", rootTextVerified: true }, "1579666997184777");
  assert.equal(verified.identityConfidence, "EXACT");
  assert.equal(verified.rootTextVerified, true);
  assert.ok(verified.identityReasons.includes("ROOT_TEXT_VERIFIED"));
});

test("root story resolver fails closed for comment, neighboring and media-only text", () => {
  for (const input of [
    { rootPostId: "1579666997184777", author: "Oleh Zaitsev", text: "Komentarz sąsiada", rootAuthorSource: "COMMENT", rootTextSource: "COMMENT", rootTextVerified: false },
    { rootPostId: "1579666997184777", author: "Inny autor", text: "Sąsiednia karta", rootAuthorSource: "NEIGHBOR", rootTextSource: "NEIGHBOR", rootTextVerified: false },
    { rootPostId: "1579666997184777", author: "Oleh Zaitsev", text: "Caption zdjęcia", rootAuthorSource: "ROOT_CARD_AUTHOR", rootTextSource: "MEDIA_CAPTION", rootTextVerified: false },
  ]) assert.equal(core.resolveRootStoryIdentity(input, "1579666997184777").identityConfidence, "UNVERIFIED");
  const expanded = core.resolveRootStoryIdentity({ rootPostId: "1579666997184777", author: "Oleh Zaitsev", text: "Pełna treść po Zobacz więcej", rootAuthorSource: "ROOT_CARD_AUTHOR", rootTextSource: "ROOT_CARD_MESSAGE_EXPANDED", rootTextVerified: true }, "1579666997184777");
  assert.equal(expanded.identityConfidence, "EXACT");
});

test("diagnostic search inspection reports evidence without inventing a parent id", () => {
  const mediaId = "28074641558832168";
  const postId = "1576413074176836";
  const body = JSON.stringify({ __typename: "Photo", id: mediaId, container_story: { __typename: "Story", post_id: postId, url: `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/permalink/${postId}/`, actors: [{ name: "Anna" }], message: { text: "Sprzedam mieszkanie" } } });
  const diagnostic = core.inspectSearchMediaParentFromText(body, source, mediaId);
  assert.equal(diagnostic.currMediaId, mediaId);
  assert.equal(diagnostic.containerStoryPostId, postId);
  assert.equal(diagnostic.parentPostId, postId);
  assert.equal(diagnostic.rootAuthorFound, true);
  assert.equal(diagnostic.rootTextFound, true);
  assert.equal(diagnostic.identityResult, "EXACT");
  const missing = core.inspectSearchMediaParentFromText(body, source, "28074641558832169");
  assert.equal(missing.parentPostId, null);
  assert.equal(missing.identityResult, "UNVERIFIED");
});

test("merge retains main-feed and search discovery evidence", () => {
  const base = { postId: "1577700267381450", permalink: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/1577700267381450/", sourceId: source.sourceId, sourceType: "GROUP", author: "A", text: "Sprzedam mieszkanie", publishedAt: null, timestampText: null, media: [], firstSeenIteration: 0, identityConfidence: "EXACT", identityReasons: [], discoverySource: "MAIN_FEED", foundInMainFeed: true, firstSeenPhase: "MAIN_FEED" };
  const [record] = core.mergeRecords([base, { ...base, discoverySource: "SEARCH", searchQuery: "mieszkanie", searchQueries: ["mieszkanie"], foundInMainFeed: false, firstSeenPhase: "SEARCH" }]);
  assert.equal(record.foundInMainFeed, true);
  assert.deepEqual(record.searchQueries, ["mieszkanie"]);
  assert.equal(record.firstSeenPhase, "MAIN_FEED");
});
test("resolves a nested exact root story message without borrowing attached or comment text", () => {
  const postId = "1583208690163941";
  const body = JSON.stringify({
    __typename: "Story",
    post_id: postId,
    permalink_url: `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/${postId}/`,
    actor: { name: "Root Author" },
    comet_sections: { content: { story: { __typename: "Story", post_id: postId, message: { text: "Na sprzedaż mieszkanie 2 pokoje" } } } },
    feedback: { comments: [{ message: { text: "Komentarz nie jest rootem" } }] },
    attachments: [{ __typename: "Story", post_id: "999999999999999", message: { text: "Obcy załącznik" } }],
  });
  const [record] = core.extractStructuredRecordsFromText(body, "NETWORK", source, 0);
  assert.equal(record.postId, postId);
  assert.equal(record.author, "Root Author");
  assert.equal(record.text, "Na sprzedaż mieszkanie 2 pokoje");
  assert.equal(record.identityConfidence, "EXACT");
});

test("search media resolver resolves author and text from an exact nested container story", () => {
  const mediaId = "28074641558832168";
  const postId = "1583208690163941";
  const body = JSON.stringify({
    __typename: "Photo",
    id: mediaId,
    image: { uri: "https://scontent.xx.fbcdn.net/exact.jpg" },
    container_story: {
      __typename: "Story",
      post_id: postId,
      permalink_url: `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/${postId}/`,
      comet_sections: { content: { story: { __typename: "Story", post_id: postId, actor: { name: "Nested Root Author" }, message: { text: "Na sprzedaż mieszkanie 2 pokoje" } } } },
      feedback: { comments: [{ actor: { name: "Comment Author" }, message: { text: "Nie jest root" } }] },
    },
  });
  const [record] = core.resolveSearchMediaParentFromText(body, "SEARCH_MEDIA_RESOLVE", source, mediaId);
  assert.equal(record.postId, postId);
  assert.equal(record.author, "Nested Root Author");
  assert.equal(record.text, "Na sprzedaż mieszkanie 2 pokoje");
  assert.equal(record.identityConfidence, "EXACT");
  assert.equal(record.media[0].exactPostId, postId);
});

test("search media resolver recovers parent id from container story tracking when direct id is omitted", () => {
  const mediaId = "28074641558832168";
  const postId = "1583208690163941";
  const body = JSON.stringify({
    data: { currMedia: {
      __typename: "Photo",
      id: mediaId,
      image: { uri: `https://scontent.xx.fbcdn.net/${mediaId}.jpg` },
      container_story: {
        __typename: "Story",
        permalink_url: `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/permalink/${postId}/`,
        actors: [{ name: "Tracked Root Author" }],
        message: { text: "Na sprzedaĹĽ mieszkanie" },
        tracking: JSON.stringify({ top_level_post_id: postId, photo_attachments_list: [mediaId] }),
      },
    } },
  });
  const [record] = core.resolveSearchMediaParentFromText(body, "SEARCH_MEDIA_RESOLVE", source, mediaId);
  assert.equal(record.postId, postId);
  assert.equal(record.identityConfidence, "EXACT");
  assert.equal(record.media[0].exactAssociation, true);
  const inspected = core.inspectSearchMediaParentFromText(body, source, mediaId);
  assert.equal(inspected.containerStoryPostId, postId);
  assert.equal(inspected.parentPostId, postId);
  assert.equal(inspected.identityResult, "EXACT");
});

test("search media resolver rejects tracking parent without requested media binding", () => {
  const mediaId = "28074641558832168";
  const postId = "1583208690163941";
  const body = JSON.stringify({
    __typename: "Photo",
    id: mediaId,
    image: { uri: `https://scontent.xx.fbcdn.net/${mediaId}.jpg` },
    container_story: {
      __typename: "Story",
      permalink_url: `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/permalink/${postId}/`,
      actors: [{ name: "Tracked Root Author" }],
      message: { text: "Na sprzedaĹĽ mieszkanie" },
      tracking: JSON.stringify({ top_level_post_id: postId, photo_attachments_list: ["28074642035498787"] }),
    },
  });
  assert.deepEqual(core.resolveSearchMediaParentFromText(body, "SEARCH_MEDIA_RESOLVE", source, mediaId), []);
});

test("search media resolver rejects conflicting direct and tracking parent ids", () => {
  const mediaId = "28074641558832168";
  const body = JSON.stringify({
    __typename: "Photo",
    id: mediaId,
    image: { uri: `https://scontent.xx.fbcdn.net/${mediaId}.jpg` },
    container_story: {
      __typename: "Story",
      post_id: "1583208690163941",
      permalink_url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/permalink/1583208690163941/",
      actors: [{ name: "Tracked Root Author" }],
      message: { text: "Na sprzedaĹĽ mieszkanie" },
      tracking: JSON.stringify({ top_level_post_id: "1583208690163999", photo_attachments_list: [mediaId] }),
    },
  });
  assert.deepEqual(core.resolveSearchMediaParentFromText(body, "SEARCH_MEDIA_RESOLVE", source, mediaId), []);
});

test("search media resolver derives a canonical source permalink only from verified tracking", () => {
  const mediaId = "28074641558832168";
  const postId = "1583208690163941";
  const body = JSON.stringify({
    __typename: "Photo",
    id: mediaId,
    image: { uri: `https://scontent.xx.fbcdn.net/${mediaId}.jpg` },
    container_story: {
      __typename: "Story",
      actors: [{ name: "Tracked Root Author" }],
      message: { text: "Na sprzedaĹĽ mieszkanie" },
      tracking: { top_level_post_id: postId, photo_attachments_list: [mediaId] },
    },
  });
  const [record] = core.resolveSearchMediaParentFromText(body, "SEARCH_MEDIA_RESOLVE", source, mediaId);
  assert.equal(record.postId, postId);
  assert.equal(record.permalink, `https://www.facebook.com/groups/${source.sourceId}/posts/${postId}/`);
  assert.equal(record.identityConfidence, "EXACT");
});
