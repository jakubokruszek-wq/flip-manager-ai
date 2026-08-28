import assert from "node:assert/strict";
import test from "node:test";
import { processFacebookPostBatch, type FacebookPostImportResult } from "./post-flow.ts";
import type { FacebookPostSnapshot, FacebookVisionExtraction } from "./types.ts";
import { acceptedFacebookPropertyImages, detectedVisionFields, facebookVisionToListingInput, isMirrorableFacebookMedia, persistEligibleFacebookPost } from "./vision-adapter.ts";

function vision(isProperty: boolean): FacebookVisionExtraction {
  return { isProperty, listingIntent: isProperty ? "SELL_PROPERTY" : "OTHER", intentConfidence: 0.98, title: isProperty ? "Mieszkanie Łódź" : null, description: isProperty ? "Sprzedam mieszkanie 45 m²" : null, visibleText: isProperty ? "Sprzedam mieszkanie 45 m², 2 pokoje" : "Spotkanie grupy w sobotę", city: isProperty ? "Łódź" : null, district: null, neighborhood: null, street: null, price: isProperty ? 350_000 : null, area: isProperty ? 45 : null, rooms: isProperty ? 2 : null, floor: null, totalFloors: null, condition: null, sellerType: isProperty ? "private" : null, confidence: 0.95, fieldConfidence: { price: 0.96, area: 0.94, rooms: 0.93, city: 0.9 }, imageAssessments: [], usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0, reasoningTokens: 0, model: "gpt-4o-mini", requestId: "req_test", estimatedCostUsd: 0.000027, pricingSourceModel: "gpt-4o-mini", pricingVersion: "2026-08-23", dataQuality: "EXACT", diagnosticsReason: null } };
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
  assert.equal(input.overrides?.price, undefined);
  assert.equal(input.overrides?.area, 45);
  assert.equal(input.overrides?.rooms, 2);
  assert.equal(input.analysisFieldConfidence?.area, 0.94);
  assert.deepEqual(input.analysisFlags, ["vision_post_region"]);
});

test("authoritative price per m2 overrides a phone-like Vision price", () => {
  const text = "Sprzedam 3 pokoje na Retkini‼️\n64 m2\n9200 zł/m2\n881 291 778";
  const item = { ...post({ ...vision(true), price: 1778, area: 64, visibleText: text }), authoritativePostText: text };
  const input = facebookVisionToListingInput(item, "Group");
  assert.equal(input.overrides?.price, 588800);
  assert.equal(input.overrides?.area, 64);
});

test("Vision visibleText price cannot override authoritative post price", () => {
  const authoritativeText = "Sprzedam 3 pokoje na Retkini\n64 m2\n9200 zł/m2\n881 291 778";
  const item = { ...post({ ...vision(true), price: 1778, area: 64, visibleText: "Cena 1778 zł" }), authoritativePostText: authoritativeText };
  const input = facebookVisionToListingInput(item, "Group");
  assert.equal(input.overrides?.price, 588800);
  assert.equal(input.priceProvenance, "AUTHORITATIVE_TEXT");
});

test("Vision cannot turn an unlabelled phone fragment into a price", () => {
  const text = "Sprzedam mieszkanie 64 m2, kontakt 881 291 778";
  const item = { ...post({ ...vision(true), price: 1778, area: 64, visibleText: text }), authoritativePostText: text };
  const input = facebookVisionToListingInput(item, "Group");
  assert.equal(input.overrides?.price, undefined);
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

test("outer BUY text gates persistence even when embedded shared content and Vision say sale", async () => {
  const outerBuy = { ...post(vision(true)), authoritativePostText: "Kupię za gotówkę mieszkanie 1-2 pokoje w Łodzi", authoritativePostTextSource: "POST_PAGE_METADATA" as const };
  let persistenceCalls = 0;
  const result = await persistEligibleFacebookPost(outerBuy, async () => { persistenceCalls += 1; return persisted(); });
  assert.equal(persistenceCalls, 0);
  assert.equal(result.status, "skipped");
  assert.equal(result.notProperty?.reasonCode, "FACEBOOK_BUY_REQUEST");
  assert.equal(result.imagesMirrored, 0);
  assert.equal(result.priceDrops, 0);
});

test("ambiguous composite blocks Vision sale fallback before persistence", async () => {
  let calls = 0;
  const item = { ...post(vision(true)), authoritativePostText: "", authoritativePostTextSource: "NONE" as const, authoritativePostTextProvenance: "AMBIGUOUS_COMPOSITE" as const };
  const result = await persistEligibleFacebookPost(item, async () => { calls += 1; return persisted(); });
  assert.equal(calls, 0);
  assert.equal(result.status, "skipped");
  assert.equal(result.listingUpdated, false);
  assert.equal(result.imagesMirrored, 0);
  assert.equal(result.priceDrops, 0);
});

test("unrelated portraits, group, quote and lifestyle images are not accepted", () => {
  const urls = ["portrait", "group", "quote", "lifestyle"];
  const assessments = urls.map((_, imageIndex) => ({ imageIndex, relevance: "NON_PROPERTY_IMAGE" as const, confidence: 0.99 }));
  assert.deepEqual(acceptedFacebookPropertyImages(urls, assessments), []);
});

test("sale passes gate and only confirmed interior images reach persistence", async () => {
  const sale = { ...vision(true), imageAssessments: [{ imageIndex: 0, relevance: "PROPERTY_IMAGE" as const, confidence: 0.97 }, { imageIndex: 1, relevance: "NON_PROPERTY_IMAGE" as const, confidence: 0.99 }] };
  const item = { ...post(sale), imageUrls: ["interior", "profile"], mediaCandidates: [
    { url: "interior", expectedPostId: "99", storyRootPostId: "99", boundPostId: "99", bindingConfidence: 1, bindingProvenance: "EXACT_ROOT_STORY" as const, rootStoryUnique: true, foreignPostIdsDetected: [], classification: "UNKNOWN" as const, classificationConfidence: null },
    { url: "profile", expectedPostId: "99", storyRootPostId: "99", boundPostId: "99", bindingConfidence: 1, bindingProvenance: "EXACT_ROOT_STORY" as const, rootStoryUnique: true, foreignPostIdsDetected: [], classification: "UNKNOWN" as const, classificationConfidence: null },
  ] };
  let receivedImages: string[] = [];
  const result = await persistEligibleFacebookPost(item, async (eligible) => { receivedImages = facebookVisionToListingInput(eligible, "Group").images ?? []; return persisted(); });
  assert.equal(result.status, "created");
  assert.deepEqual(receivedImages, ["interior"]);
});

test("PROPERTY_IMAGE cannot override missing exact story provenance", () => {
  const hotel = { url: "hotel", expectedPostId: "1575270320957778", storyRootPostId: null, boundPostId: "1575270320957778", bindingConfidence: 0.95, bindingProvenance: "DEDICATED_POST_VIEWER" as const, rootStoryUnique: true, foreignPostIdsDetected: [], classification: "PROPERTY_IMAGE" as const, classificationConfidence: 1 };
  assert.equal(isMirrorableFacebookMedia(hotel), false);
});

test("full authoritative post text is not replaced by a short Vision summary", () => {
  const full = "Sprzedam mieszkanie 59,45 m2 przy ul. Sporna 72. Czynsz ok. 700 zł. Łazienka po remoncie, własna piwnica i suszarnia.";
  const item = { ...post({ ...vision(true), description: "Mieszkanie 2 pokoje w Łodzi" }), authoritativePostText: full, authoritativePostTextSource: "POST_PAGE_METADATA" as const };
  const input = facebookVisionToListingInput(item, "Group");
  assert.equal(input.postText, full);
  assert.equal(input.overrides?.description, full);
  assert.equal(input.analysisFieldConfidence?.description, 1);
});
