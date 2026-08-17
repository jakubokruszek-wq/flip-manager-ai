import assert from "node:assert/strict";
import test from "node:test";
import { processFacebookPostBatch, type FacebookPostImportResult } from "./post-flow.ts";
import type { FacebookPostSnapshot, FacebookVisionExtraction } from "./types.ts";
import { acceptedFacebookPropertyImages, detectedVisionFields, facebookVisionToListingInput, persistEligibleFacebookPost } from "./vision-adapter.ts";

function vision(isProperty: boolean): FacebookVisionExtraction {
  return { isProperty, listingIntent: isProperty ? "SELL_PROPERTY" : "OTHER", intentConfidence: 0.98, title: isProperty ? "Mieszkanie Łódź" : null, description: isProperty ? "Sprzedam mieszkanie 45 m²" : null, visibleText: isProperty ? "Sprzedam mieszkanie 45 m², 2 pokoje" : "Spotkanie grupy w sobotę", city: isProperty ? "Łódź" : null, district: null, neighborhood: null, street: null, price: isProperty ? 350_000 : null, area: isProperty ? 45 : null, rooms: isProperty ? 2 : null, floor: null, totalFloors: null, condition: null, sellerType: isProperty ? "private" : null, confidence: 0.95, fieldConfidence: { price: 0.96, area: 0.94, rooms: 0.93, city: 0.9 }, imageAssessments: [] };
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
  assert.equal(input.overrides?.rooms, 2);
  assert.equal(input.analysisFieldConfidence?.area, 0.94);
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

test("buy request is gated before persistence, matching, score, alerts and price history", async () => {
  const text = "Kupię za gotówkę mieszkanie 1-2 pokoje (30-40m2) w Łodzi. Może być do remontu. Do 220 000 zł";
  const buy = { ...vision(true), listingIntent: "SELL_PROPERTY" as const, intentConfidence: 0.98, visibleText: "Mieszkanie w Łodzi", price: 220_000, area: 40, rooms: 2 };
  const item = { ...post(buy), authoritativePostText: text, imageUrls: ["unrelated-profile"] };
  let persistenceCalls = 0;
  const result = await persistEligibleFacebookPost(item, async () => { persistenceCalls += 1; return persisted(); });
  assert.equal(persistenceCalls, 0);
  assert.deepEqual({ status: result.status, listingId: result.listingId, matched: result.matched, matchCreated: result.matchCreated, priceDrops: result.priceDrops, imagesMirrored: result.imagesMirrored }, { status: "skipped", listingId: null, matched: false, matchCreated: false, priceDrops: 0, imagesMirrored: 0 });
  assert.equal(result.notProperty?.reasonCode, "FACEBOOK_BUY_REQUEST");
});

test("surrounding Vision sale text cannot override authoritative BUY post text", async () => {
  const authoritativeText = "Kupię za gotówkę mieszkanie 1-2 pokoje w Łodzi";
  const contaminatedVision = { ...vision(true), visibleText: "Sprzedam mieszkanie 42 m²", listingIntent: "SELL_PROPERTY" as const, intentConfidence: 0.99 };
  const item = { ...post(contaminatedVision), authoritativePostText: authoritativeText };
  let persistenceCalls = 0;
  const result = await persistEligibleFacebookPost(item, async () => { persistenceCalls += 1; return persisted(); });
  assert.equal(persistenceCalls, 0);
  assert.equal(result.notProperty?.reasonCode, "FACEBOOK_BUY_REQUEST");
});

test("metadata and DOM intent conflict is skipped before persistence even when Vision says sale", async () => {
  const conflicting = { ...post(vision(true)), authoritativePostText: "", authoritativePostTextSource: "CONFLICT" as const };
  let persistenceCalls = 0;
  const result = await persistEligibleFacebookPost(conflicting, async () => { persistenceCalls += 1; return persisted(); });
  assert.equal(persistenceCalls, 0);
  assert.equal(result.status, "skipped");
  assert.equal(result.notProperty?.reasonCode, "FACEBOOK_INTENT_UNKNOWN");
});

test("unrelated portraits, group, quote and lifestyle images are not accepted", () => {
  const urls = ["portrait", "group", "quote", "lifestyle"];
  const assessments = urls.map((_, imageIndex) => ({ imageIndex, relevance: "NON_PROPERTY_IMAGE" as const, confidence: 0.99 }));
  assert.deepEqual(acceptedFacebookPropertyImages(urls, assessments), []);
});

test("sale passes gate and only confirmed interior images reach persistence", async () => {
  const sale = { ...vision(true), imageAssessments: [{ imageIndex: 0, relevance: "PROPERTY_IMAGE" as const, confidence: 0.97 }, { imageIndex: 1, relevance: "NON_PROPERTY_IMAGE" as const, confidence: 0.99 }] };
  const item = { ...post(sale), imageUrls: ["interior", "profile"] };
  let receivedImages: string[] = [];
  const result = await persistEligibleFacebookPost(item, async (eligible) => { receivedImages = facebookVisionToListingInput(eligible, "Group").images ?? []; return persisted(); });
  assert.equal(result.status, "created");
  assert.deepEqual(receivedImages, ["interior"]);
});
