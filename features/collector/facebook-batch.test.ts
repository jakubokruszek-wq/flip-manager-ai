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
