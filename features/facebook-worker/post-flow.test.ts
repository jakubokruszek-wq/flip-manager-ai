import assert from "node:assert/strict";
import test from "node:test";
import { processFacebookPostBatch, type FacebookPostImportResult } from "./post-flow.ts";
import type { FacebookPostSnapshot } from "./types.ts";

function post(postId: string, text = "Sprzedam mieszkanie 45 m2, 2 pokoje, 350000 zl"): FacebookPostSnapshot {
  return { postId, groupId: "group-1", permalink: `https://www.facebook.com/groups/group-1/posts/${postId}/`, text, imageUrls: [], publishedAt: "2026-08-16T10:00:00.000Z" };
}

function outcome(patch: Partial<FacebookPostImportResult> = {}): FacebookPostImportResult {
  return { status: "created", listingId: "listing-1", listingCreated: true, listingUpdated: false, matched: true, matchCreated: true, imagesMirrored: 1, priceDrops: 0, warnings: [], ...patch };
}

test("post with successful extraction creates a listing and match", async () => {
  const result = await processFacebookPostBatch([post("1")], async () => outcome());
  assert.deepEqual({ created: result.listingsCreated, matched: result.matched, errors: result.errors }, { created: 1, matched: 1, errors: 0 });
});

test("the same post processed twice keeps one listing identity", async () => {
  const seen = new Set<string>();
  const result = await processFacebookPostBatch([post("1"), post("1")], async (item) => {
    const existing = seen.has(item.postId!); seen.add(item.postId!);
    return outcome({ status: existing ? "updated" : "created", listingId: "listing-1", listingCreated: !existing, listingUpdated: false, matchCreated: !existing });
  });
  assert.equal(result.listingsCreated, 1);
  assert.deepEqual(result.listingIds, ["listing-1"]);
});

test("not-a-property post is skipped", async () => {
  const result = await processFacebookPostBatch([post("2", "Spotkanie grupy w sobote")], async () => outcome({ status: "skipped", listingId: null, listingCreated: false, matched: false, matchCreated: false, imagesMirrored: 0 }));
  assert.equal(result.listingsSkipped, 1);
  assert.equal(result.listingsCreated, 0);
});

test("one extraction failure does not stop the batch", async () => {
  const result = await processFacebookPostBatch([post("bad"), post("good")], async (item) => {
    if (item.postId === "bad") throw new Error("FACEBOOK_POST_EXTRACTION_FAILED");
    return outcome();
  });
  assert.equal(result.extractionFailed, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.listingsCreated, 1);
});

test("image failure warning does not prevent listing persistence", async () => {
  const result = await processFacebookPostBatch([post("3")], async () => outcome({ imagesMirrored: 0, warnings: ["image fetch failed"] }));
  assert.equal(result.listingsCreated, 1);
  assert.equal(result.imagesMirrored, 0);
  assert.deepEqual(result.warnings, ["image fetch failed"]);
});

test("matching listing is counted", async () => {
  const result = await processFacebookPostBatch([post("4")], async () => outcome({ matched: true }));
  assert.equal(result.matched, 1);
});

test("non-matching listing is persisted without a match", async () => {
  const result = await processFacebookPostBatch([post("5")], async () => outcome({ matched: false, matchCreated: false }));
  assert.equal(result.listingsCreated, 1);
  assert.equal(result.matched, 0);
});

test("existing listing is updated without creating a duplicate", async () => {
  const result = await processFacebookPostBatch([post("6")], async () => outcome({ status: "updated", listingId: "existing", listingCreated: false, listingUpdated: true, matchCreated: false, priceDrops: 1 }));
  assert.equal(result.listingsCreated, 0);
  assert.equal(result.listingsUpdated, 1);
  assert.equal(result.priceDrops, 1);
  assert.deepEqual(result.listingIds, ["existing"]);
});

test("post without stable id and permalink is skipped before extraction", async () => {
  let called = false;
  const value = { ...post("7"), postId: null, permalink: null };
  const result = await processFacebookPostBatch([value], async () => { called = true; return outcome(); });
  assert.equal(called, false);
  assert.equal(result.listingsSkipped, 1);
});
