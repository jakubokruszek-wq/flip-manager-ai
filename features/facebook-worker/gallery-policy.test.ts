import assert from "node:assert/strict";
import test from "node:test";

import { galleryMediaIds, gallerySeedMediaFromCollectorBatches, gallerySeedMediaFromProvenance, selectMissingGalleryCandidates } from "./gallery-policy.ts";
import type { FacebookMediaCandidate } from "./types";

function candidate(mediaId: string, url = `https://scontent.xx.fbcdn.net/${mediaId}.jpg`): FacebookMediaCandidate {
  return { mediaId, url, expectedPostId: "123456", storyRootPostId: "123456", boundPostId: "123456", bindingConfidence: 1, bindingProvenance: "EXACT_ROOT_STORY", rootStoryUnique: true, foreignPostIdsDetected: [], classification: "PROPERTY_IMAGE", classificationConfidence: 0.95, structuredPostMediaProvenance: false };
}

test("gallery download plan fetches only media missing from persisted ids", () => {
  const source = [candidate("1"), candidate("2"), candidate("3"), candidate("3")];
  const missing = selectMissingGalleryCandidates(source, new Set(["1", "2"]));
  assert.deepEqual(missing.map((item) => item.mediaId), ["3"]);
  assert.deepEqual(galleryMediaIds(source), ["1", "2", "3"]);
});

test("gallery download plan preserves existing urls and empty input", () => {
  const source = [candidate("1", "https://storage.example/one.jpg"), candidate("2")];
  assert.deepEqual(selectMissingGalleryCandidates(source, new Set(), new Set(["https://storage.example/one.jpg"])).map((item) => item.mediaId), ["2"]);
  assert.deepEqual(selectMissingGalleryCandidates([], new Set(), new Set()), []);
});

test("gallery viewer seeds require an explicit exact-root media id", () => {
  const exact = {
    sourcePostId: "1749121366325600",
    storyRootPostId: "1749121366325600",
    normalizedMediaUrl: "https://scontent-waw2-2.xx.fbcdn.net/v/t39.30808-6/791849411_28459992303624928_2386612899756008195_n.jpg?x=1",
    bindingMethod: "EXACT_ROOT_STORY",
    bindingConfidence: 1,
    classification: "PROPERTY_IMAGE",
  };
  assert.deepEqual(gallerySeedMediaFromProvenance([exact], "1749121366325600"), []);
  assert.deepEqual(gallerySeedMediaFromProvenance([{ ...exact, mediaId: "28459992263624932" }], "1749121366325600"), [{ mediaId: "28459992263624932" }]);
  assert.deepEqual(gallerySeedMediaFromProvenance([{ ...exact, storyRootPostId: "999999" }], "1749121366325600"), []);
  assert.deepEqual(gallerySeedMediaFromProvenance([{ ...exact, bindingConfidence: 0.5 }], "1749121366325600"), []);
  assert.deepEqual(gallerySeedMediaFromProvenance([{ ...exact, normalizedMediaUrl: "https://example.com/image.jpg" }], "1749121366325600"), []);
});

test("legacy gallery seed is recovered only from an exact historical collector binding", () => {
  const postId = "1749121366325600";
  const sourceUrl = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/1749121366325600";
  const exactBatch = {
    payload: {
      sourceId: "lodzsprzedazzakupwynajem",
      sourceType: "GROUP",
      sourceUrl: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/",
      posts: [{
        postId,
        permalink: sourceUrl,
        identityConfidence: "EXACT",
        author: "Joanna Gral",
        text: "Sprzedam mieszkanie w Łodzi",
        mediaIds: ["28459992263624932"],
        media: [{ mediaId: "28459992263624932", exactPostId: postId, exactAssociation: true, url: "https://scontent-waw2-2.xx.fbcdn.net/photo.jpg" }],
      }],
    },
  };
  assert.deepEqual(gallerySeedMediaFromCollectorBatches([exactBatch], postId, sourceUrl), [{ mediaId: "28459992263624932" }]);
  assert.deepEqual(gallerySeedMediaFromCollectorBatches([{ payload: { ...exactBatch.payload, posts: [{ ...exactBatch.payload.posts[0], identityConfidence: "UNVERIFIED" }] } }], postId, sourceUrl), []);
  assert.deepEqual(gallerySeedMediaFromCollectorBatches([{ payload: { ...exactBatch.payload, posts: [{ ...exactBatch.payload.posts[0], mediaIds: [] }] } }], postId, sourceUrl), []);
  assert.deepEqual(gallerySeedMediaFromCollectorBatches([{ payload: { ...exactBatch.payload, posts: [{ ...exactBatch.payload.posts[0], permalink: "https://www.facebook.com/groups/other/posts/1749121366325600" }] } }], postId, sourceUrl), []);
});
