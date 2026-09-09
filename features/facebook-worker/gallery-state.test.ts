import assert from "node:assert/strict";
import test from "node:test";
import { deriveMonotonicGalleryFailure } from "./gallery-state.ts";

test("failed hydration with no prior images remains FAILED", () => {
  assert.deepEqual(deriveMonotonicGalleryFailure({ currentStatus: "RUNNING", imageCount: 0, persistedCount: 0, total: 0, exactMetadataCount: 0 }), { status: "FAILED", persistedTotal: 0, total: 0 });
});

test("failed retry preserves one persisted image as PARTIAL", () => {
  assert.deepEqual(deriveMonotonicGalleryFailure({ currentStatus: "PARTIAL", imageCount: 1, persistedCount: 1, total: 1, exactMetadataCount: 1 }), { status: "PARTIAL", persistedTotal: 1, total: 1 });
});

test("viewer and response timeout failures share the monotonic PARTIAL state", () => {
  for (const error of ["GALLERY_VIEWER_CURRENT_IMAGE_NOT_FOUND", "FACEBOOK_GALLERY_RESPONSE_TIMEOUT"]) {
    assert.equal(deriveMonotonicGalleryFailure({ currentStatus: "PARTIAL", imageCount: 1, persistedCount: 1, total: 1, exactMetadataCount: 1 }).status, "PARTIAL", error);
  }
});

test("complete gallery never degrades after a failed retry", () => {
  assert.deepEqual(deriveMonotonicGalleryFailure({ currentStatus: "COMPLETE", imageCount: 7, persistedCount: 7, total: 7, exactMetadataCount: 7 }), { status: "COMPLETE", persistedTotal: 7, total: 7 });
});

test("complete status remains monotonic even if legacy counters are inconsistent", () => {
  assert.deepEqual(deriveMonotonicGalleryFailure({ currentStatus: "COMPLETE", imageCount: 0, persistedCount: 0, total: 0, exactMetadataCount: 0 }), { status: "COMPLETE", persistedTotal: 0, total: 0 });
});

test("empty incoming failure does not erase existing images or counts", () => {
  const before = { imageCount: 1, persistedCount: 1, total: 7 };
  const after = deriveMonotonicGalleryFailure({ currentStatus: "PARTIAL", ...before, exactMetadataCount: 1 });
  assert.equal(after.persistedTotal, before.persistedCount);
  assert.equal(after.total, before.total);
});

test("metadata evidence prevents a destructive downgrade without inventing a count", () => {
  assert.deepEqual(deriveMonotonicGalleryFailure({ currentStatus: "RUNNING", imageCount: 0, persistedCount: 0, total: 0, exactMetadataCount: 1 }), { status: "PARTIAL", persistedTotal: 0, total: 0 });
});
