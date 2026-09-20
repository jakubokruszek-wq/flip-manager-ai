import assert from "node:assert/strict";
import test from "node:test";
import { canonicalVisibilityDebug, summarizeCanonicalVisibility } from "./canonical-visibility.ts";
import { evaluateCanonicalListingDecision, type FilterCandidate } from "./filter-evaluation.ts";
import { canonicalProjection } from "./canonical-projection.ts";
import type { SearchFilter } from "./index.ts";

const filter = {
  id: "consistency-filter",
  name: "Facebook consistency fixture",
  sources: ["facebook"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: 700_000,
  areaMin: 32,
  areaMax: 58,
  rooms: [1, 2, 3, 4],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: true,
  buildingTypes: [],
  ownershipTypes: [],
  marketType: null,
  privateOnly: false,
  maxPricePerSqm: 7_000,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60,
  isActive: true,
  lastScannedAt: null,
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-20T00:00:00Z",
} satisfies SearchFilter;

const base: FilterCandidate = {
  price: 305_000,
  area: 44.93,
  pricePerSqm: 6_788,
  rooms: 2,
  floor: "2",
  city: "Łódź",
  district: "Widzew",
  title: "Mieszkanie",
  locationText: "Widzew, Łódź",
  buildingType: "blok",
};
const matchedFilter = { ...filter, excludeTopFloor: false } satisfies SearchFilter;

test("mixed consistency fixture keeps ten rows in each canonical operational category", () => {
  const matched = Array.from({ length: 10 }, (_, index) => evaluateCanonicalListingDecision({ ...base, title: `matched-${index}` }, matchedFilter));
  const review = Array.from({ length: 10 }, (_, index) => evaluateCanonicalListingDecision({ ...base, floor: null, title: `review-${index}` }, filter));
  const rejected = Array.from({ length: 10 }, (_, index) => evaluateCanonicalListingDecision({ ...base, price: 900_000, pricePerSqm: 20_000, title: `rejected-${index}` }, filter));
  const historical = Array.from({ length: 10 }, (_, index) => canonicalVisibilityDebug({
    listingId: `historical-${index}`,
    canonicalBucket: evaluateCanonicalListingDecision({ ...base, title: `historical-${index}` }, matchedFilter).bucket,
    lifecycleStatus: "ARCHIVED",
    isCurrentMatch: true,
    matchReasons: [],
    visibilityInFinder: false,
    visibilityInWatcher: true,
    reason: "archived_operational_state",
  }));

  assert.equal(matched.filter((decision) => decision.bucket === "MATCHED").length, 10);
  assert.equal(review.filter((decision) => decision.bucket === "REVIEW").length, 10);
  assert.equal(rejected.filter((decision) => decision.bucket === "REJECTED").length, 10);
  assert.equal(rejected.every((decision) => decision.hardRejectReasons.length > 0), true);
  assert.deepEqual(summarizeCanonicalVisibility(historical), { totalWatcher: 10, matched: 0, review: 0, rejected: 0, historical: 10 });
});

test("a cleared listing is eligible for fresh rediscovery when its current facts match", () => {
  const fresh = evaluateCanonicalListingDecision(base, matchedFilter);
  const restored = canonicalVisibilityDebug({
    listingId: "cleared-then-rediscovered",
    canonicalBucket: fresh.bucket,
    lifecycleStatus: "ACTIVE",
    isCurrentMatch: fresh.bucket === "MATCHED",
    matchReasons: fresh.reasons,
    visibilityInFinder: fresh.bucket === "MATCHED",
    visibilityInWatcher: true,
    reason: "fresh_scan_reconciliation",
  });
  assert.equal(fresh.bucket, "MATCHED");
  assert.equal(restored.finderStatus, "MATCHED");
  assert.equal(restored.visibilityInFinder, true);
});

test("consistency matrix keeps persisted state, Finder visibility, and Watcher state aligned", () => {
  const rows = [
    { name: "complete valid", decision: evaluateCanonicalListingDecision(base, matchedFilter), lifecycle: "ACTIVE" as const, visible: true, watcher: "MATCHED" as const },
    { name: "incomplete valid", decision: evaluateCanonicalListingDecision({ ...base, floor: null }, filter), lifecycle: "REVIEW" as const, visible: true, watcher: "REVIEW" as const },
    { name: "hard reject", decision: evaluateCanonicalListingDecision({ ...base, price: 900_000, pricePerSqm: 20_000 }, filter), lifecycle: "REJECTED" as const, visible: false, watcher: "REJECTED" as const },
    { name: "archived valid rediscovered", decision: evaluateCanonicalListingDecision(base, matchedFilter), lifecycle: "ACTIVE" as const, visible: true, watcher: "MATCHED" as const },
    { name: "stale valid rediscovered", decision: evaluateCanonicalListingDecision(base, matchedFilter), lifecycle: "ACTIVE" as const, visible: true, watcher: "MATCHED" as const },
    { name: "cleared valid rediscovered", decision: evaluateCanonicalListingDecision(base, matchedFilter), lifecycle: "ACTIVE" as const, visible: true, watcher: "MATCHED" as const },
  ];
  for (const row of rows) {
    const projection = canonicalProjection(row.decision);
    assert.equal(projection.lifecycleStatus, row.lifecycle, row.name);
    assert.equal(projection.isCurrentMatch, row.decision.bucket === "MATCHED", row.name);
    assert.deepEqual(projection.matchReasons, row.decision.bucket === "REVIEW" ? ["review", ...row.decision.reasons, ...row.decision.missingFields.map((field) => `unknown_${field}`)] : row.decision.bucket === "REJECTED" ? row.decision.hardRejectReasons : row.decision.reasons, row.name);
    assert.equal(projection.bucket === "MATCHED" || projection.bucket === "REVIEW" ? row.visible : false, row.visible, row.name);
    assert.equal(projection.bucket, row.watcher, row.name);
  }
});
