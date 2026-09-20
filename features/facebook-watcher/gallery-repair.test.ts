import test from "node:test";
import assert from "node:assert/strict";
import { resetFacebookGalleryMetadata } from "./gallery-repair.ts";

test("gallery repair removes gallery metadata only and keeps provenance and source facts", () => {
  assert.deepEqual(resetFacebookGalleryMetadata({ galleryMediaIds: ["bad"], galleryStatus: "COMPLETE", galleryUpdatedAt: "x", mediaProvenance: { source: "network" }, sourceFacts: { price: 300000 }, workflowStatus: "review" }), { mediaProvenance: { source: "network" }, sourceFacts: { price: 300000 }, workflowStatus: "review" });
});
