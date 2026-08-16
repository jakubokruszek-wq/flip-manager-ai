import assert from "node:assert/strict";
import test from "node:test";
import { processFacebookPostBatch, type FacebookPostImportResult } from "./post-flow.ts";
import type { FacebookPostSnapshot, FacebookVisionExtraction } from "./types.ts";
import { detectedVisionFields, facebookVisionToListingInput } from "./vision-adapter.ts";

function vision(isProperty: boolean): FacebookVisionExtraction {
  return { isProperty, title: isProperty ? "Mieszkanie Łódź" : null, description: isProperty ? "Sprzedam mieszkanie 45 m²" : null, visibleText: isProperty ? "Sprzedam mieszkanie 45 m², 2 pokoje" : "Spotkanie grupy w sobotę", city: isProperty ? "Łódź" : null, district: null, neighborhood: null, street: null, price: isProperty ? 350_000 : null, area: isProperty ? 45 : null, rooms: isProperty ? 2 : null, floor: null, totalFloors: null, condition: null, sellerType: isProperty ? "private" : null, confidence: 0.95 };
}

function post(result: FacebookVisionExtraction): FacebookPostSnapshot {
  return { postId: "99", groupId: "group-1", permalink: "https://www.facebook.com/groups/1/posts/99/", text: result.visibleText ?? "", imageUrls: [], publishedAt: null, vision: result };
}

function persisted(): FacebookPostImportResult {
  return { status: "created", listingId: "listing-1", listingCreated: true, listingUpdated: false, matched: true, matchCreated: true, imagesMirrored: 0, priceDrops: 0, warnings: [] };
}

test("Vision output maps into the existing Facebook listing input", () => {
  const input = facebookVisionToListingInput(post(vision(true)), "Group");
  assert.equal(input.postText, "Sprzedam mieszkanie 45 m², 2 pokoje");
  assert.equal(input.overrides?.price, 350_000);
  assert.equal(input.overrides?.area, 45);
  assert.deepEqual(input.analysisFlags, ["vision_post_region"]);
});

test("Vision property continues through the persistence batch", async () => {
  let called = false;
  const result = await processFacebookPostBatch([post(vision(true))], async () => { called = true; return persisted(); });
  assert.equal(called, true);
  assert.equal(result.listingsCreated, 1);
  assert.equal(result.matched, 1);
});

test("Vision not-a-property is skipped without persistence", async () => {
  const item = post(vision(false)); let persistedCalled = false;
  const result = await processFacebookPostBatch([item], async (candidate) => {
    if (candidate.vision?.isProperty === false) return { ...persisted(), status: "skipped", listingId: null, listingCreated: false, matched: false, matchCreated: false, notProperty: { realEstateLanguage: false, structuredFieldCount: detectedVisionFields(candidate.vision).length, detectedFields: [] } };
    persistedCalled = true; return persisted();
  });
  assert.equal(persistedCalled, false);
  assert.equal(result.listingsSkipped, 1);
  assert.equal(result.listingsCreated, 0);
});
