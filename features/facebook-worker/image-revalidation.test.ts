import test from "node:test";
import assert from "node:assert/strict";
import { selectFacebookImageRevalidationTargets, shouldReplaceFacebookRevalidationGallery, validateFacebookRevalidationCandidates } from "./image-revalidation.ts";

const candidate = (patch: Record<string, unknown> = {}) => ({
  url: "https://scontent.xx.fbcdn.net/image.jpg", expectedPostId: "post-1", storyRootPostId: "post-1", boundPostId: "post-1",
  bindingConfidence: 0.95, bindingProvenance: "EXACT_ROOT_STORY" as const, rootStoryUnique: true, foreignPostIdsDetected: [],
  classification: "PROPERTY_IMAGE" as const, classificationConfidence: 0.9, ...patch,
});

test("exact provenance and property classification are accepted", () => {
  const result = validateFacebookRevalidationCandidates([candidate()], "post-1");
  assert.equal(result.verified.length, 1);
  assert.equal(result.rejected.length, 0);
});

test("missing story root is rejected even with property classification", () => {
  const result = validateFacebookRevalidationCandidates([candidate({ storyRootPostId: null, bindingProvenance: "DEDICATED_POST_VIEWER" })], "post-1");
  assert.equal(result.verified.length, 0);
  assert.deepEqual(result.reasons, ["FACEBOOK_IMAGE_PROVENANCE_INSUFFICIENT"]);
});

test("structured exact-post provenance is accepted without a DOM root", () => {
  const result = validateFacebookRevalidationCandidates([candidate({ storyRootPostId: null, structuredPostMediaProvenance: true })], "post-1");
  assert.equal(result.verified.length, 1);
});

test("relevance and foreign binding remain fail closed", () => {
  const result = validateFacebookRevalidationCandidates([
    candidate({ classification: "NON_PROPERTY_IMAGE" }),
    candidate({ storyRootPostId: "post-2" }),
  ], "post-1");
  assert.equal(result.verified.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.deepEqual(result.reasons.sort(), ["FACEBOOK_IMAGE_PROVENANCE_INSUFFICIENT", "FACEBOOK_IMAGE_RELEVANCE_REJECTED"]);
});

test("revalidation selection respects limit and only selects stale/unprovenanced galleries", () => {
  const target = (id: string, version: number | null, provenance: boolean) => ({ listingId: id, postId: id, permalink: `https://www.facebook.com/groups/g/posts/${id}`, currentImages: ["https://storage/image"], imageExtractionVersion: version, hasPerImageProvenance: provenance });
  const selected = selectFacebookImageRevalidationTargets([
    target("fresh", 1, true), target("stale", null, false), target("stale-2", 1, false), target("stale-3", null, false),
  ], { limit: 2 });
  assert.deepEqual(selected.map((item) => item.listingId), ["stale", "stale-2"]);
});

test("failed or unknown revalidation preserves the old gallery", () => {
  assert.equal(shouldReplaceFacebookRevalidationGallery({ pageAvailable: false, provenanceKnown: false, mirrorFailed: false }), false);
  assert.equal(shouldReplaceFacebookRevalidationGallery({ pageAvailable: true, provenanceKnown: false, mirrorFailed: false }), false);
  assert.equal(shouldReplaceFacebookRevalidationGallery({ pageAvailable: true, provenanceKnown: true, mirrorFailed: true }), false);
  assert.equal(shouldReplaceFacebookRevalidationGallery({ pageAvailable: true, provenanceKnown: true, mirrorFailed: false }), true);
});

test("successful empty verification may replace a gallery with zero images", () => {
  assert.equal(shouldReplaceFacebookRevalidationGallery({ pageAvailable: true, provenanceKnown: true, mirrorFailed: false }), true);
});
