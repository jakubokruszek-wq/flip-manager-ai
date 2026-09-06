import assert from "node:assert/strict";
import test from "node:test";

import { galleryMediaIds, selectMissingGalleryCandidates } from "./gallery-policy.ts";
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
