import assert from "node:assert/strict";
import test from "node:test";
import { exactBoundPropertyImages, facebookImagePersistenceDiagnostics, facebookMediaBindingSummary, isSuspiciousSmallSquare, preserveFacebookPublishedAt } from "./facebook-media-binding.ts";
import type { FacebookListingInput } from "./types.ts";

function input(candidates: NonNullable<FacebookListingInput["mediaCandidates"]>): FacebookListingInput {
  return { mediaCandidates: candidates };
}

const exact = { url: "https://scontent.xx.fbcdn.net/a.jpg", expectedPostId: "A", storyRootPostId: "A", boundPostId: "A", bindingConfidence: 1, bindingProvenance: "EXACT_ROOT_STORY" as const, rootStoryUnique: true, foreignPostIdsDetected: [], classification: "PROPERTY_IMAGE" as const, classificationConfidence: 0.95 };

test("exact-bound property media is accepted only for its expected post", () => {
  assert.deepEqual(exactBoundPropertyImages(input([exact]), "A"), [exact.url]);
  assert.deepEqual(exactBoundPropertyImages(input([exact]), "B"), []);
});

test("foreign and ambiguous gallery media are rejected", () => {
  const foreign = { ...exact, url: "https://scontent.xx.fbcdn.net/b.jpg", boundPostId: "B", rootStoryUnique: false, foreignPostIdsDetected: ["B"] };
  const ambiguous = { ...exact, url: "https://scontent.xx.fbcdn.net/c.jpg", boundPostId: null, bindingConfidence: 0, bindingProvenance: "AMBIGUOUS" as const, rootStoryUnique: false };
  const value = input([exact, foreign, ambiguous]);
  assert.deepEqual(exactBoundPropertyImages(value, "A"), [exact.url]);
  assert.deepEqual(facebookMediaBindingSummary(value, "A"), { candidates: 3, exactBound: 1, foreignRejected: 1, ambiguousRejected: 2 });
});

test("zero confidently bound images remains an empty safe result", () => {
  assert.deepEqual(exactBoundPropertyImages(input([]), "A"), []);
});

test("rejects a small square avatar even when Vision calls it a property image", () => {
  const avatar = { ...exact, intrinsicWidth: 160, intrinsicHeight: 159 };
  assert.equal(isSuspiciousSmallSquare(avatar), true);
  assert.deepEqual(exactBoundPropertyImages(input([avatar]), "A"), []);
});

test("keeps a verified interior image with strong dimensions", () => {
  const interior = { ...exact, intrinsicWidth: 1_200, intrinsicHeight: 800 };
  assert.equal(isSuspiciousSmallSquare(interior), false);
  assert.deepEqual(exactBoundPropertyImages(input([interior]), "A"), [interior.url]);
});

test("rejects the confirmed post-fix hotel image without a story root", () => {
  const hotel = { ...exact, url: "https://scontent.xx.fbcdn.net/hotel.jpg", storyRootPostId: null, bindingProvenance: "DEDICATED_POST_VIEWER" as const, bindingConfidence: 0.95, classificationConfidence: 0.9, intrinsicWidth: 90, intrinsicHeight: 160 };
  assert.deepEqual(exactBoundPropertyImages(input([hotel]), "A"), []);
});

test("structured exact-post media provenance is an explicit safe exception", () => {
  const structured = { ...exact, storyRootPostId: null, bindingProvenance: "EXACT_POST_METADATA" as const, structuredPostMediaProvenance: true };
  assert.deepEqual(exactBoundPropertyImages(input([structured]), "A"), [structured.url]);
});

test("a later scan without creation time preserves published_at", () => {
  const existing = "2026-08-17T13:18:00.000Z";
  assert.equal(preserveFacebookPublishedAt(null, existing), existing);
  assert.equal(preserveFacebookPublishedAt("2026-08-17T13:18:00.000Z", null), existing);
});

test("image persistence diagnostics distinguish candidates, new uploads and final listing count", () => {
  const value = facebookImagePersistenceDiagnostics({
    postId: "A", creationTime: null, timestampSource: "UNKNOWN", publishedAtCandidate: null,
    publishedAtPersistAttempted: true, publishedAtPersisted: true, exactBoundCandidates: 5,
    relevanceAccepted: 1, mirrorAttempted: 1, mirroredCount: 0,
    existingImages: ["existing"], finalListingImages: ["existing"],
  });
  assert.deepEqual(value, {
    postId: "A", creationTime: null, timestampSource: "UNKNOWN", publishedAtCandidate: null,
    publishedAtPersistAttempted: true, publishedAtPersisted: true, exactBoundCandidates: 5,
    relevanceAccepted: 1, relevanceRejected: 4, mirrorAttempted: 1, mirroredCount: 0,
    persistedNewImageCount: 0, finalListingImageCount: 1, persistedImageCount: 1,
    imageReasonCode: "NONE", reasonCodes: [],
  });
});

test("all accepted images can be mirrored and persisted as new", () => {
  const value = facebookImagePersistenceDiagnostics({
    postId: "A", creationTime: null, timestampSource: "UNKNOWN", publishedAtCandidate: null,
    publishedAtPersistAttempted: true, publishedAtPersisted: true, exactBoundCandidates: 5,
    relevanceAccepted: 5, mirrorAttempted: 5, mirroredCount: 5,
    existingImages: [], finalListingImages: ["1", "2", "3", "4", "5"],
  });
  assert.equal(value.relevanceRejected, 0);
  assert.equal(value.persistedNewImageCount, 5);
  assert.equal(value.finalListingImageCount, 5);
  assert.equal(value.imageReasonCode, "NONE");
});
