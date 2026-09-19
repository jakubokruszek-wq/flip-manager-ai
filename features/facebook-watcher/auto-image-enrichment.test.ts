import assert from "node:assert/strict";
import test from "node:test";

import { shouldAutoEnrichFacebookImages } from "./auto-image-enrichment.ts";

// -----------------------------------------------------------------------------
// D/E. Both NORMAL (MATCHED) and NEEDS_REVIEW candidates must queue photo
// enrichment automatically when priority 1/2 images were not available.
// -----------------------------------------------------------------------------

test("D. a MATCHED candidate with zero mirrored images is queued for enrichment", () => {
  assert.equal(shouldAutoEnrichFacebookImages({ bucket: "MATCHED", manualRejected: false, mirroredImageCount: 0 }), true);
});

test("E. a REVIEW candidate with zero mirrored images is queued for enrichment too", () => {
  assert.equal(shouldAutoEnrichFacebookImages({ bucket: "REVIEW", manualRejected: false, mirroredImageCount: 0 }), true);
});

test("a listing that already has post images from priority 1/2 is not re-enriched", () => {
  assert.equal(shouldAutoEnrichFacebookImages({ bucket: "MATCHED", manualRejected: false, mirroredImageCount: 3 }), false);
  assert.equal(shouldAutoEnrichFacebookImages({ bucket: "REVIEW", manualRejected: false, mirroredImageCount: 1 }), false);
});

test("a REJECTED listing is never enriched regardless of image count", () => {
  assert.equal(shouldAutoEnrichFacebookImages({ bucket: "REJECTED", manualRejected: false, mirroredImageCount: 0 }), false);
});

test("a manually rejected listing is never enriched even if its computed bucket looks matched", () => {
  assert.equal(shouldAutoEnrichFacebookImages({ bucket: "MATCHED", manualRejected: true, mirroredImageCount: 0 }), false);
});
