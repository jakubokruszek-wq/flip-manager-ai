import assert from "node:assert/strict";
import test from "node:test";

import { calculateOpportunityAssessment, priorityForBusiness } from "./opportunity-score.ts";
import type { SearchFilter } from "./index.ts";
import type { ResaleCompRecord } from "../market-intelligence/resale-comps.ts";

const filter: SearchFilter = {
  id: "filter-1",
  name: "Łódź mieszkania",
  sources: ["facebook"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: null,
  areaMax: null,
  rooms: [1, 2, 3, 4],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: false,
  buildingTypes: [],
  ownershipTypes: [],
  marketType: "secondary",
  privateOnly: false,
  maxPricePerSqm: 12_000,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60,
  isActive: true,
  lastScannedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

test("scores a review listing with missing secondary fields without accepting it", () => {
  const assessment = calculateOpportunityAssessment({
    id: "review-1",
    source: "facebook",
    lifecycleStatus: "REVIEW",
    decisionBucket: "REVIEW",
    price: 249_000,
    area: 38,
    rooms: 2,
    pricePerSqm: 6_552.63,
    city: "Łódź",
    district: "Chojny",
    address: "ul. Ogniskowa 8",
    buildingType: null,
    floor: null,
    title: "Mieszkanie po remoncie",
    description: "Mieszkanie po generalnym remoncie",
    missingFields: ["ownership", "topFloor"],
    lastSeenAt: "2026-09-05T00:00:00.000Z",
  }, filter, [comp(8_500), comp(8_800)], Date.parse("2026-09-06T00:00:00.000Z"));

  assert.ok(assessment);
  assert.equal(assessment.compCount, 2);
  assert.equal(assessment.dataConfidence, "HIGH");
  assert.ok(Number.isFinite(assessment.score));
  assert.ok(assessment.missingFields.includes("buildingType"));
});

test("manual reject and terminal lifecycle never receive an opportunity score", () => {
  const base = {
    id: "rejected-1",
    source: "facebook",
    decisionBucket: "REJECTED" as const,
    price: 100_000,
    area: 30,
    rooms: 1,
    pricePerSqm: 3_333,
    city: "Łódź",
    district: null,
    address: null,
    buildingType: null,
    floor: null,
    title: "Oferta",
    description: null,
    missingFields: [],
    lastSeenAt: "2026-09-05T00:00:00.000Z",
  };
  assert.equal(calculateOpportunityAssessment({ ...base, lifecycleStatus: "REJECTED" }, filter), null);
  assert.equal(calculateOpportunityAssessment({ ...base, lifecycleStatus: "ACTIVE", manualDecision: "REJECTED" }, filter), null);
  assert.equal(calculateOpportunityAssessment({ ...base, lifecycleStatus: "ARCHIVED", decisionBucket: "MATCHED" }, filter), null);
});

test("unset area filter does not turn a listing into a hard rejection", () => {
  const assessment = calculateOpportunityAssessment({
    id: "large-1",
    source: "facebook",
    lifecycleStatus: "REVIEW",
    decisionBucket: "REVIEW",
    price: 500_000,
    area: 100,
    rooms: null,
    pricePerSqm: 5_000,
    city: "Łódź",
    district: null,
    address: null,
    buildingType: null,
    floor: null,
    title: "Mieszkanie",
    description: null,
    missingFields: ["rooms"],
    lastSeenAt: "2026-09-05T00:00:00.000Z",
  }, filter);
  assert.ok(assessment);
});

test("known hard filter violations cannot be promoted by a strong ARV", () => {
  const assessment = calculateOpportunityAssessment({
    id: "over-limit",
    source: "facebook",
    lifecycleStatus: "REVIEW",
    decisionBucket: "REVIEW",
    price: 600_000,
    area: 40,
    rooms: 2,
    pricePerSqm: 15_000,
    city: "Łódź",
    district: "Chojny",
    address: "ul. Ogniskowa 8",
    buildingType: null,
    floor: null,
    title: "Mieszkanie po remoncie",
    description: "Gotowe do zamieszkania",
    missingFields: [],
    lastSeenAt: "2026-09-05T00:00:00.000Z",
  }, filter, [comp(18_000), comp(19_000)]);
  assert.equal(assessment, null);
});

test("weak positive economics cannot receive a high priority from relative score alone", () => {
  assert.equal(priorityForBusiness(73, {
    estimatedProfit: 13_856,
    estimatedRoi: 2.9,
    marketDiscountPct: 21.2,
    arvConfidence: "MEDIUM",
  }), "MEDIUM");
});

test("negative economics are low priority without becoming a hard reject", () => {
  assert.equal(priorityForBusiness(81, {
    estimatedProfit: -38_524,
    estimatedRoi: -7.3,
    marketDiscountPct: 21.8,
    arvConfidence: "HIGH",
  }), "LOW");
});

test("strong economics can remain high priority when secondary ownership data is missing", () => {
  assert.equal(priorityForBusiness(73, {
    estimatedProfit: 65_000,
    estimatedRoi: 18,
    marketDiscountPct: 24,
    arvConfidence: "HIGH",
  }), "HIGH");
});

function comp(pricePerM2: number): ResaleCompRecord {
  return {
    id: `comp-${pricePerM2}`,
    source: "otodom",
    externalListingId: `external-${pricePerM2}`,
    canonicalUrl: `https://example.test/${pricePerM2}`,
    title: "Mieszkanie po generalnym remoncie",
    description: "Nowe instalacje, gotowe do zamieszkania",
    city: "Łódź",
    district: "Chojny",
    street: "ul. Ogniskowa",
    address: "ul. Ogniskowa 10",
    price: pricePerM2 * 38,
    areaM2: 38,
    pricePerM2,
    rooms: 2,
    floor: "2",
    floors: "4",
    buildingType: "blok",
    listingCreatedAt: "2026-09-01T00:00:00.000Z",
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-05T00:00:00.000Z",
    active: true,
    sellerType: null,
    fingerprint: null,
    classification: {
      isCandidate: true,
      renovationStatus: "RENOVATED",
      renovationConfidence: "HIGH",
      finishLevel: "GENERAL_RENOVATION",
      evidence: ["generalny remont"],
      outlierReason: null,
      exclusionReason: null,
    },
  };
}
