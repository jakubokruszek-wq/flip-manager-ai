import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFacebookCollectorBatch } from "./facebook-batch.ts";
import { COLLECTOR_IMAGE_IMPORT_OPTIONS, collectorPostsForProcessing, findHistoricalCollectorIdentityConflicts } from "./facebook-batch-policy.ts";

function batch() {
  return normalizeFacebookCollectorBatch({ scanId: "11111111-1111-4111-8111-111111111111", batchId: "22222222-2222-4222-8222-222222222222", sourceId: "2928219830782023", sourceType: "GROUP", sourceUrl: "https://www.facebook.com/groups/2928219830782023/", collectedAt: "2026-08-29T12:00:00Z", health: { status: "HEALTHY", visibleCardCount: 2, capturedPostCount: 2, scrolls: 3, durationMs: 5000, stopReason: "NO_NEW_POSTS_3_SCROLLS", reasons: [] }, posts: [
    { postId: "4454910774779580", permalink: "https://www.facebook.com/groups/2928219830782023/posts/4454910774779580/", sourceId: "2928219830782023", sourceType: "GROUP", author: "Autor A", text: "Sprzedam własnościowe mieszkanie 43.05 m2", publishedAt: "2026-08-29T10:00:00Z", media: [], discoveryLayers: ["DOM"], firstSeenIteration: 0, identityConfidence: "EXACT", identityReasons: [] },
    { postId: "4453116338292357", permalink: "https://www.facebook.com/groups/2928219830782023/posts/4453116338292357/", sourceId: "2928219830782023", sourceType: "GROUP", author: "Autor B", text: "Stara oferta", publishedAt: "2026-08-20T10:00:00Z", media: [], discoveryLayers: ["HYDRATION"], firstSeenIteration: 1, identityConfidence: "EXACT", identityReasons: [] },
  ] });
}

test("collector processes fresh authoritative text without Vision or unverified images", () => {
  const posts = collectorPostsForProcessing(batch(), Date.parse("2026-08-29T12:00:00Z"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].postId, "4454910774779580");
  assert.equal(posts[0].authoritativePostText, "Sprzedam własnościowe mieszkanie 43.05 m2");
  assert.equal(posts[0].vision, null);
  assert.deepEqual(posts[0].imageUrls, []);
  assert.deepEqual(posts[0].mediaCandidates, []);
});

test("collector stays image-neutral until exact provenance is integrated", () => {
  assert.equal(COLLECTOR_IMAGE_IMPORT_OPTIONS.preserveExistingImagesOnEmptyInput, true);
});

test("unverified identity and a historical author/text conflict cannot reach processing", () => {
  const current = batch();
  current.posts[0].identityConfidence = "UNVERIFIED";
  assert.equal(collectorPostsForProcessing(current, Date.parse("2026-08-29T12:00:00Z")).length, 0);

  current.posts[0].identityConfidence = "EXACT";
  const conflicts = findHistoricalCollectorIdentityConflicts(current, [{
    ...current,
    batchId: "33333333-3333-4333-8333-333333333333",
    posts: [{ ...current.posts[0], author: "Inny autor", text: "Kupię mieszkanie za gotówkę" }],
  }]);
  assert.deepEqual([...conflicts], ["4454910774779580"]);
  assert.equal(collectorPostsForProcessing(current, Date.parse("2026-08-29T12:00:00Z"), conflicts).length, 0);
});
