import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resetFacebookGalleryMetadata } from "./gallery-repair.ts";

test("gallery repair removes gallery metadata only and keeps provenance and source facts", () => {
  assert.deepEqual(resetFacebookGalleryMetadata({ galleryMediaIds: ["bad"], galleryStatus: "COMPLETE", galleryUpdatedAt: "x", mediaProvenance: { source: "network" }, sourceFacts: { price: 300000 }, workflowStatus: "review" }), { mediaProvenance: { source: "network" }, sourceFacts: { price: 300000 }, workflowStatus: "review" });
});

test("gallery repair resets once and delegates to one hydration enqueue without a source scan", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "features/facebook-worker/gallery-jobs.ts"), "utf8");
  const start = source.indexOf("export async function repairFacebookGalleryJob");
  const end = source.indexOf("export async function getFacebookGalleryStatus", start);
  const repair = source.slice(start, end);
  assert.equal((repair.match(/enqueueFacebookGalleryJob\(listingId\)/g) ?? []).length, 1);
  assert.match(repair, /job_type.*GALLERY_HYDRATION/);
  assert.doesNotMatch(repair, /SOURCE_SCAN/);
  assert.match(repair, /gallery_status: "NOT_REQUESTED"/);
});
