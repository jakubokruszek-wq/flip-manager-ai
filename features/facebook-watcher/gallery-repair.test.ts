import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resetFacebookGalleryMetadata } from "./gallery-repair.ts";

test("gallery repair removes gallery metadata only and keeps provenance and source facts", () => {
  assert.deepEqual(resetFacebookGalleryMetadata({ galleryMediaIds: ["bad"], galleryStatus: "COMPLETE", galleryUpdatedAt: "x", mediaProvenance: { source: "network" }, sourceFacts: { price: 300000 }, workflowStatus: "review" }), { mediaProvenance: { source: "network" }, sourceFacts: { price: 300000 }, workflowStatus: "review" });
});

test("gallery repair delegates reset, exact identity proof, and enqueue to one RPC", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "features/facebook-worker/gallery-jobs.ts"), "utf8");
  const migration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260920160000_facebook_quality_v1_3_2_safety_closure.sql"), "utf8");
  const start = source.indexOf("export async function repairFacebookGalleryJob");
  const end = source.indexOf("export async function getFacebookGalleryStatus", start);
  const repair = source.slice(start, end);
  assert.match(repair, /rpc\("repair_facebook_gallery_job"/);
  assert.doesNotMatch(repair, /enqueueFacebookGalleryJob\(listingId\)/);
  assert.doesNotMatch(repair, /SOURCE_SCAN/);
  assert.match(migration, /create or replace function public\.repair_facebook_gallery_job/);
  assert.match(migration, /metadata_count <> 1/);
  assert.match(migration, /FACEBOOK_GALLERY_METADATA_GROUP_MISMATCH/);
  assert.match(migration, /set images = '\[\]'::jsonb/);
  assert.match(migration, /'GALLERY_HYDRATION'/);
  assert.match(migration, /listing_post_id/);
});
