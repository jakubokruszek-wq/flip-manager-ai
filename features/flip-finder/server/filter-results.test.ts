import assert from "node:assert/strict";
import test from "node:test";
import { parseFacebookPriceReliability as parsePriceReliability } from "../../facebook-watcher/price-quality.ts";
import { calculateOpportunityAssessment } from "../opportunity-score.ts";
import type { SearchFilter } from "../index.ts";
import type { ResaleCompRecord } from "../../market-intelligence/resale-comps.ts";

// -----------------------------------------------------------------------------
// parsePriceReliability: the exact function filter-results.ts uses to turn a
// `listing_source_metadata.metadata` JSONB blob into the generic
// OpportunityListingInput.priceReliability field.
// -----------------------------------------------------------------------------
test("parsePriceReliability reads a valid Facebook priceQuality.status", () => {
  assert.equal(parsePriceReliability({ priceQuality: { status: "SUSPECT" } }), "SUSPECT");
  assert.equal(parsePriceReliability({ priceQuality: { status: "MISSING" } }), "MISSING");
  assert.equal(parsePriceReliability({ priceQuality: { status: "VERIFIED" } }), "VERIFIED");
  assert.equal(parsePriceReliability({ priceQuality: { status: "LIKELY" } }), "LIKELY");
});
test("parsePriceReliability never fabricates a status for missing/malformed/unrecognized metadata", () => {
  assert.equal(parsePriceReliability(null), undefined);
  assert.equal(parsePriceReliability({}), undefined);
  assert.equal(parsePriceReliability({ priceQuality: null }), undefined);
  assert.equal(parsePriceReliability({ priceQuality: {} }), undefined);
  assert.equal(parsePriceReliability({ priceQuality: { status: "MADE_UP" } }), undefined);
  assert.equal(parsePriceReliability({ other: "field" }), undefined);
  // OLX/Otodom never write a priceQuality field at all — this is the exact shape
  // their metadata (if any) takes, and it must resolve to "no signal", not SUSPECT.
  assert.equal(parsePriceReliability({ source: "olx", confidence: 0.9 }), undefined);
});

// -----------------------------------------------------------------------------
// End-to-end wiring simulation: real metadata row shape -> parsePriceReliability
// -> calculateOpportunityAssessment (the real, unmodified engine). This proves
// the actual production code path without requiring a live Supabase connection.
// -----------------------------------------------------------------------------
const filter: SearchFilter = {
  id: "filter-1", name: "Łódź mieszkania", sources: ["facebook", "olx", "otodom"], city: "Łódź", districts: [],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [1, 2, 3, 4], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: "secondary",
  privateOnly: false, maxPricePerSqm: 12_000, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true, lastScannedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
};
function comp(pricePerM2: number): ResaleCompRecord {
  return {
    id: `comp-${pricePerM2}`, source: "otodom", externalListingId: `external-${pricePerM2}`, canonicalUrl: `https://example.test/${pricePerM2}`,
    title: "Mieszkanie po generalnym remoncie", description: "Nowe instalacje, gotowe do zamieszkania", city: "Łódź", district: "Bałuty",
    street: "ul. Testowa", address: "ul. Testowa 10", price: pricePerM2 * 38, areaM2: 38, pricePerM2, rooms: 2, floor: "2", floors: "4",
    buildingType: "blok", listingCreatedAt: "2026-09-01T00:00:00.000Z", firstSeenAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-09-05T00:00:00.000Z",
    active: true, sellerType: null, fingerprint: null,
    classification: { isCandidate: true, renovationStatus: "RENOVATED", renovationConfidence: "HIGH", finishLevel: "GENERAL_RENOVATION", evidence: ["generalny remont"], outlierReason: null, exclusionReason: null },
  };
}
function listingInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "listing-1", source: "facebook", lifecycleStatus: "REVIEW" as const, decisionBucket: "REVIEW" as const,
    price: 666, area: 38, rooms: 2, pricePerSqm: 666 / 38, city: "Łódź", district: "Bałuty", address: "ul. Testowa 10",
    buildingType: null, floor: null, title: "Mieszkanie", description: "Mieszkanie na sprzedaż",
    missingFields: [], lastSeenAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

test("REAL 666 SAFETY CASE: a Facebook listing_source_metadata row with priceQuality SUSPECT blocks price-driven upside end to end", () => {
  const metadataRow = { listing_id: "listing-1", metadata: { source: "facebook_watcher", priceQuality: { status: "SUSPECT", category: "OTHER_AMOUNT", reasonCodes: ["PRICE_BELOW_PLAUSIBLE_FLOOR"] } } };
  const priceReliability = parsePriceReliability(metadataRow.metadata);
  assert.equal(priceReliability, "SUSPECT");
  const assessment = calculateOpportunityAssessment({ ...listingInput(), priceReliability }, filter, [comp(18_000), comp(19_000)], Date.parse("2026-09-06T00:00:00.000Z"));
  assert.ok(assessment);
  assert.equal(assessment.estimatedProfit, null);
  assert.equal(assessment.estimatedRoi, null);
  assert.equal(assessment.marketDiscountPct, null);
  assert.notEqual(assessment.priority, "TOP");
  assert.notEqual(assessment.priority, "HIGH");
});

test("FACEBOOK VERIFIED PRICE: a 399000 listing with priceQuality VERIFIED scores identically with or without the wiring", () => {
  const verifiedInput = listingInput({ price: 399_000, pricePerSqm: 399_000 / 38 });
  const metadataRow = { metadata: { priceQuality: { status: "VERIFIED" } } };
  const priceReliability = parsePriceReliability(metadataRow.metadata);
  assert.equal(priceReliability, "VERIFIED");
  const withWiring = calculateOpportunityAssessment({ ...verifiedInput, priceReliability }, filter, [comp(8_500), comp(8_800)], Date.parse("2026-09-06T00:00:00.000Z"));
  const withoutWiring = calculateOpportunityAssessment(verifiedInput, filter, [comp(8_500), comp(8_800)], Date.parse("2026-09-06T00:00:00.000Z"));
  assert.ok(withWiring && withoutWiring);
  assert.equal(withWiring.score, withoutWiring.score);
  assert.equal(withWiring.estimatedProfit, withoutWiring.estimatedProfit);
  assert.equal(withWiring.marketDiscountPct, withoutWiring.marketDiscountPct);
});

test("OLX SCORING UNCHANGED: an OLX listing has no listing_source_metadata row for price quality, so priceReliability stays undefined and scoring is untouched", () => {
  const olxInput = listingInput({ id: "olx-1", source: "olx", price: 350_000, pricePerSqm: 350_000 / 38 });
  // OLX never writes to listing_source_metadata.metadata.priceQuality — parsePriceReliability
  // correctly yields undefined for its (absent) metadata, exactly like before this wiring existed.
  const priceReliability = parsePriceReliability(undefined);
  assert.equal(priceReliability, undefined);
  const withField = calculateOpportunityAssessment({ ...olxInput, priceReliability }, filter, [comp(8_500), comp(8_800)], Date.parse("2026-09-06T00:00:00.000Z"));
  const withoutField = calculateOpportunityAssessment(olxInput, filter, [comp(8_500), comp(8_800)], Date.parse("2026-09-06T00:00:00.000Z"));
  assert.ok(withField && withoutField);
  assert.deepEqual(withField, withoutField);
});

test("OTODOM SCORING UNCHANGED: same backward-compatible behavior for Otodom", () => {
  const otodomInput = listingInput({ id: "otodom-1", source: "otodom", price: 420_000, pricePerSqm: 420_000 / 38 });
  const priceReliability = parsePriceReliability(undefined);
  const withField = calculateOpportunityAssessment({ ...otodomInput, priceReliability }, filter, [comp(8_500), comp(8_800)], Date.parse("2026-09-06T00:00:00.000Z"));
  const withoutField = calculateOpportunityAssessment(otodomInput, filter, [comp(8_500), comp(8_800)], Date.parse("2026-09-06T00:00:00.000Z"));
  assert.ok(withField && withoutField);
  assert.deepEqual(withField, withoutField);
});

test("NO-METADATA BACKWARD COMPATIBILITY: a Facebook listing predating this feature (no priceQuality in its metadata yet) scores exactly as before", () => {
  const legacyMetadata = { source: "facebook_worker", confidence: 0.8 }; // no priceQuality key at all
  const priceReliability = parsePriceReliability(legacyMetadata);
  assert.equal(priceReliability, undefined);
  const withField = calculateOpportunityAssessment({ ...listingInput({ price: 399_000, pricePerSqm: 399_000 / 38 }), priceReliability }, filter, [comp(8_500), comp(8_800)], Date.parse("2026-09-06T00:00:00.000Z"));
  const withoutField = calculateOpportunityAssessment(listingInput({ price: 399_000, pricePerSqm: 399_000 / 38 }), filter, [comp(8_500), comp(8_800)], Date.parse("2026-09-06T00:00:00.000Z"));
  assert.ok(withField && withoutField);
  assert.deepEqual(withField, withoutField);
});
