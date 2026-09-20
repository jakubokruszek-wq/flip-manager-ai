import assert from "node:assert/strict";
import test from "node:test";
import { extractFacebookProperty, resolveFacebookPricePerSqm } from "./extract-facebook-property.ts";
import { reconcileFacebookLocation } from "./facebook-location-quality.ts";
import { resolveFacebookBuildingEvidence } from "./facebook-building-evidence.ts";
import { evaluateFacebookApartmentSafety } from "./facebook-apartment-safety.ts";
import { classifyFacebookPostAgeZone } from "./post-age-zone.ts";
import { evaluateCanonicalListingDecision } from "../flip-finder/filter-evaluation.ts";
import { classifyFacebookDecision, classifyFacebookSkip } from "../facebook-worker/scan-accounting.ts";
import { facebookPersistenceFailure } from "./facebook-persistence-contract.ts";
import type { SearchFilter } from "../flip-finder/index.ts";

/**
 * MANDATORY REGRESSION FIXTURE (V1 scan-accounting mission, Part E).
 *
 * Real production post 1597595792058564 by Maja Piotrowska, captured in
 * scan_run eed9d31b-fea6-41fa-8a7b-62f0e115e18a. Confirmed via read-only
 * production audit: the collector captured this exact text with EXACT
 * identity confidence (so it was never filtered as unverified/stale), and a
 * `listings` row was actually created for it with the correct canonical
 * REVIEW decision (missing_fields: topFloor, buildingType, ownership;
 * price_per_sqm: 6276.595744680851) — proving the deterministic pipeline
 * CAN reach the right answer for this text. Yet the batch's own accounting
 * counted this post among 12 anonymous "errors" (FACEBOOK_POST_EXTRACTION_FAILED)
 * with zero corresponding `listing_source_metadata` row, making the listing
 * unreachable from the Watcher. This fixture locks in the deterministic,
 * DB-independent half of that pipeline (extraction through the canonical
 * decision) so it can never silently regress again.
 */
const CHORALNA_TEXT = "2-pokojowe mieszkanie do remontu na sprzedaż - ul Chóralna,\npiętro 11, duży balkon, 47 m2\n295 tys 🔥\n📞795 016 049";

const CHORALNA_FILTER: SearchFilter = {
  id: "test-filter", name: "Łódź flip", sources: ["facebook"], city: "Łódź", districts: [],
  priceMin: null, priceMax: null, areaMin: 32, areaMax: 58, rooms: [1, 2, 3, 4],
  floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: true,
  buildingTypes: ["blok", "apartamentowiec"], ownershipTypes: ["pełna własność", "spółdzielcze"],
  marketType: null, privateOnly: false, maxPricePerSqm: 7000, requiredKeywords: [], excludedKeywords: [],
  minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60, isActive: true, lastScannedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

async function runChoralnaPipeline() {
  const publishedAt = "2026-09-20T14:29:39.000Z";
  assert.notEqual(classifyFacebookPostAgeZone(publishedAt), "OLD", "the fixture's own timestamp must not be stale relative to the 72h rule, or this test would exercise the wrong code path");

  const extracted = await extractFacebookProperty({ postText: CHORALNA_TEXT, groupName: "lodzsprzedazzakupwynajem", url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/1597595792058564/" });
  const locationResolution = reconcileFacebookLocation(extracted, { authoritativeText: CHORALNA_TEXT, groupName: "lodzsprzedazzakupwynajem", groupUrl: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/" });
  const effective = { ...extracted, ...locationResolution.property };
  const buildingEvidence = resolveFacebookBuildingEvidence(CHORALNA_TEXT, effective);
  const apartmentSafety = evaluateFacebookApartmentSafety({ authoritativeText: CHORALNA_TEXT, property: effective, filter: CHORALNA_FILTER, buildingEvidence });
  const pricePerSqm = resolveFacebookPricePerSqm(effective);
  return { extracted, effective, buildingEvidence, apartmentSafety, pricePerSqm };
}

test("Chóralna: extraction produces every expected deterministic fact, with no exception thrown", async () => {
  const { effective, pricePerSqm } = await runChoralnaPipeline();
  assert.equal(effective.listingIntent, "SELL_PROPERTY");
  assert.equal(effective.rooms, 2);
  assert.equal(effective.area, 47);
  assert.equal(effective.price, 295_000);
  assert.equal(effective.floor, 11, "the 'piętro 11' word-first phrasing must resolve to floor 11, not null");
  assert.ok(effective.street?.includes("Chóralna"));
  assert.equal(effective.condition, "renovation");
  assert.ok(Math.abs(pricePerSqm! - 6276.595744680851) < 0.01);
});

test("Chóralna never becomes EXTRACTION_FAILED: apartment safety finds no hard reject", async () => {
  const { apartmentSafety } = await runChoralnaPipeline();
  assert.equal(apartmentSafety.hardReject, false, "an unverified building type and unverified location are soft signals, never a hard reject, for this text");
});

test("Chóralna does not hard-reject on the top-floor rule when total-floor evidence is unknown", async () => {
  const { effective } = await runChoralnaPipeline();
  const decision = evaluateCanonicalListingDecision(
    { price: effective.price, area: effective.area, pricePerSqm: resolveFacebookPricePerSqm(effective), rooms: effective.rooms, floor: effective.floor === null ? null : String(effective.floor), city: effective.city, district: effective.district, title: effective.title, locationText: [effective.street, effective.district, effective.city].filter(Boolean).join(", "), buildingType: null, sellerType: effective.sellerType, marketType: effective.marketType, ownership: null },
    CHORALNA_FILTER,
  );
  assert.equal(decision.hardRejectReasons.includes("floor_max"), false);
  assert.equal(decision.hardRejectReasons.includes("ground_floor"), false);
  assert.ok(decision.missingFields.includes("topFloor"), "excludeTopFloor must mark topFloor as unknown, never a hard reject, whenever total-floor count cannot be established from the text");
});

test("Chóralna reaches REVIEW under the mission's exact active filter, never MATCHED, REJECTED, or a silent disappearance", async () => {
  const { effective } = await runChoralnaPipeline();
  const decision = evaluateCanonicalListingDecision(
    { price: effective.price, area: effective.area, pricePerSqm: resolveFacebookPricePerSqm(effective), rooms: effective.rooms, floor: effective.floor === null ? null : String(effective.floor), city: effective.city, district: effective.district, title: effective.title, locationText: [effective.street, effective.district, effective.city].filter(Boolean).join(", "), buildingType: null, sellerType: effective.sellerType, marketType: effective.marketType, ownership: null },
    CHORALNA_FILTER,
  );
  assert.equal(decision.bucket, "REVIEW");
  assert.deepEqual([...decision.missingFields].sort(), ["buildingType", "ownership", "topFloor"]);

  const outcome = classifyFacebookDecision({ bucket: decision.bucket, reasons: decision.hardRejectReasons, unknownFields: decision.missingFields });
  assert.equal(outcome.primaryOutcome, "REVIEW", "the accounting layer must file this exact fixture under REVIEW, never EXTRACTION_FAILED or any other bucket — it must be impossible for it to silently disappear");
  assert.deepEqual([...outcome.reasonCodes].sort(), ["unknown_buildingType", "unknown_ownership", "unknown_topFloor"]);
});

test("Chóralna orphan state is incomplete before retry and complete after the normal REVIEW projection read-back", () => {
  assert.equal(facebookPersistenceFailure("REVIEW", { metadataId: null, membershipExists: false, isCurrentMatch: undefined, matchReasons: [] }), "FACEBOOK_METADATA_PERSIST_FAILED");
  assert.equal(facebookPersistenceFailure("REVIEW", { metadataId: "metadata-1", membershipExists: false, isCurrentMatch: undefined, matchReasons: [] }), "FACEBOOK_FILTER_RECONCILE_FAILED");
  assert.equal(facebookPersistenceFailure("REVIEW", { metadataId: "metadata-1", membershipExists: true, isCurrentMatch: false, matchReasons: ["unknown_topFloor", "unknown_buildingType", "unknown_ownership"] }), null);
});

// Guard rails: a rental example must never be promoted to a sale outcome, and
// a house example must never become an apartment MATCHED outcome, proven
// against the SAME real classifiers this fixture uses.
test("guard rail: a rental post is never classified as a sale outcome", () => {
  const outcome = classifyFacebookSkip({ reasonCode: "FACEBOOK_RENT_REQUEST", warnings: [] });
  assert.equal(outcome.primaryOutcome, "RENTAL");
  assert.notEqual(outcome.primaryOutcome, "MATCHED");
  assert.notEqual(outcome.primaryOutcome, "REVIEW");
});

test("guard rail: a house post can never reach MATCHED", () => {
  const outcome = classifyFacebookSkip({ reasonCode: "FACEBOOK_NON_APARTMENT_PROPERTY", warnings: [] });
  assert.equal(outcome.primaryOutcome, "UNSUPPORTED_PROPERTY_TYPE");
  assert.notEqual(outcome.primaryOutcome, "MATCHED");
});
