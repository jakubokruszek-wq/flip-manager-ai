import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveMonotonicGalleryFailure,
  effectiveGalleryDisplayState,
  FACEBOOK_GALLERY_TIMEOUT_CODE,
  GALLERY_REQUEST_TIMEOUT_MS,
  isGalleryRequestTimedOut,
} from "./gallery-state.ts";

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

test("isGalleryRequestTimedOut never fires for a terminal or never-requested status", () => {
  const now = Date.now();
  const longAgo = new Date(now - GALLERY_REQUEST_TIMEOUT_MS * 10).toISOString();
  for (const status of ["NOT_REQUESTED", "PARTIAL", "COMPLETE", "FAILED", null, undefined] as const) {
    assert.equal(isGalleryRequestTimedOut(status, longAgo, now), false, `status ${status} must never time out`);
  }
});

test("isGalleryRequestTimedOut never fires for PENDING/RUNNING without a requestedAt", () => {
  const now = Date.now();
  assert.equal(isGalleryRequestTimedOut("PENDING", null, now), false);
  assert.equal(isGalleryRequestTimedOut("RUNNING", undefined, now), false);
});

test("isGalleryRequestTimedOut never fires when requestedAt cannot be parsed as a date", () => {
  const now = Date.now();
  assert.equal(isGalleryRequestTimedOut("PENDING", "not-a-date", now), false);
});

test("isGalleryRequestTimedOut is false just under the timeout and true at/over it", () => {
  const now = Date.now();
  const justUnder = new Date(now - (GALLERY_REQUEST_TIMEOUT_MS - 1_000)).toISOString();
  const exactlyAt = new Date(now - GALLERY_REQUEST_TIMEOUT_MS).toISOString();
  const wellOver = new Date(now - GALLERY_REQUEST_TIMEOUT_MS * 2).toISOString();
  assert.equal(isGalleryRequestTimedOut("PENDING", justUnder, now), false);
  assert.equal(isGalleryRequestTimedOut("PENDING", exactlyAt, now), true);
  assert.equal(isGalleryRequestTimedOut("RUNNING", wellOver, now), true);
});

test("effectiveGalleryDisplayState maps a timed-out PENDING/RUNNING listing to a FAILED timeout state", () => {
  const now = Date.now();
  const wellOver = new Date(now - GALLERY_REQUEST_TIMEOUT_MS * 2).toISOString();
  assert.deepEqual(effectiveGalleryDisplayState("PENDING", wellOver, null, now), { status: "FAILED", error: FACEBOOK_GALLERY_TIMEOUT_CODE });
  assert.deepEqual(effectiveGalleryDisplayState("RUNNING", wellOver, null, now), { status: "FAILED", error: FACEBOOK_GALLERY_TIMEOUT_CODE });
});

test("effectiveGalleryDisplayState passes a non-timed-out or already-terminal listing through unchanged", () => {
  const now = Date.now();
  const recent = new Date(now - 30_000).toISOString();
  assert.deepEqual(effectiveGalleryDisplayState("PENDING", recent, null, now), { status: "PENDING", error: null });
  assert.deepEqual(effectiveGalleryDisplayState("COMPLETE", null, null, now), { status: "COMPLETE", error: null });
  const longAgo = new Date(now - GALLERY_REQUEST_TIMEOUT_MS * 5).toISOString();
  assert.deepEqual(effectiveGalleryDisplayState("FAILED", longAgo, "FACEBOOK_GALLERY_ROOT_AMBIGUOUS", now), { status: "FAILED", error: "FACEBOOK_GALLERY_ROOT_AMBIGUOUS" });
  assert.deepEqual(effectiveGalleryDisplayState(null, null, null, now), { status: null, error: null });
});
