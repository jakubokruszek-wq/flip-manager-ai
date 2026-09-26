import assert from "node:assert/strict";
import test from "node:test";
import { planFilterMatchRecalculation, type RecalculationListing, type RecalculationMatch } from "@/features/flip-finder/filter-match-recalculation-plan";
import type { SearchFilter } from "@/features/flip-finder";

const now = new Date().toISOString();

function baseFilter(overrides: Partial<SearchFilter> = {}): SearchFilter {
  return {
    id: "filter-1", name: "Test filter", sources: ["facebook", "otodom"], city: null, districts: [],
    priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
    excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
    privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
    minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
    lastScannedAt: null, createdAt: now, updatedAt: now, ...overrides,
  };
}

function listing(overrides: Partial<RecalculationListing> & { id: string; source: RecalculationListing["source"] }): RecalculationListing {
  return {
    price: 400_000, area: 50, pricePerSqm: 8_000, rooms: 2, floor: "1", city: "Łódź", district: "Widzew",
    title: "Test listing", description: null, locationText: "Widzew, Łódź", buildingType: null, originalUrl: `https://example.com/${overrides.id}`,
    manualDecision: null, lifecycleStatus: "ACTIVE", ...overrides,
  };
}

// Finder/Watcher contract mission: reconcileFacebookFromCanonicalListings
// (features/flip-finder/server/manual-scan.ts) calls recalculateFilterMatches
// with sourcesOverride: ["facebook"]. That function fetches ONLY facebook
// listings via the primary (paginated, source-scoped) query, but still
// fetches any listing the filter already has a match for by id, regardless
// of source (see filter-match-recalculation.ts's own comment on why). This
// proves the plan-level consequence of that design directly, with no
// Supabase mocking required: an existing match for a source OUTSIDE the
// override must stay "unchanged", never fall into "removed" just because a
// facebook-scoped reconciliation pass didn't re-fetch it via the primary query.
test("scoping the primary listings fetch to facebook must not drop an existing Otodom match, as long as that match is still supplied via the id-based fallback fetch", () => {
  const filter = baseFilter();
  const facebookListing = listing({ id: "fb-1", source: "facebook" });
  const otodomListingStillMatched = listing({ id: "ot-1", source: "otodom" });
  const matches: RecalculationMatch[] = [
    { listingId: "fb-1", isCurrentMatch: false, matchReasons: [] }, // not yet matched, should become MATCHED
    { listingId: "ot-1", isCurrentMatch: true, matchReasons: [] }, // already matched by a real Otodom scan, must stay that way
  ];

  // This mirrors exactly what recalculateFilterMatches assembles when called
  // with sourcesOverride: ["facebook"]: `listings` from the scoped primary
  // fetch, plus `missingMatchedListings` fetched unscoped by id for anything
  // in `matches` that the scoped fetch didn't return (here: ot-1).
  const combinedListings = [facebookListing, otodomListingStillMatched];
  const plan = planFilterMatchRecalculation(filter, combinedListings, matches);

  assert.ok(plan.addedListingIds.includes("fb-1"), "the new facebook listing must be added as a match");
  assert.ok(plan.unchangedListingIds.includes("ot-1"), "the pre-existing Otodom match must remain unchanged");
  assert.ok(!plan.removedListingIds.includes("ot-1"), "the pre-existing Otodom match must never be reported as removed by a facebook-scoped reconciliation pass");
});

// The failure mode this guards against: if the id-based fallback fetch were
// ever skipped or itself scoped to facebook only (a plausible but wrong
// simplification of the fix), the Otodom match would vanish from the
// combined listings array entirely, and the plan's own "existing match with
// no matching listing" fallback would incorrectly report it as removed.
test("(documents the bug this design avoids) omitting the still-matched Otodom listing from the combined array does mark it removed", () => {
  const filter = baseFilter();
  const facebookListing = listing({ id: "fb-1", source: "facebook" });
  const matches: RecalculationMatch[] = [
    { listingId: "fb-1", isCurrentMatch: false, matchReasons: [] },
    { listingId: "ot-1", isCurrentMatch: true, matchReasons: [] },
  ];

  const plan = planFilterMatchRecalculation(filter, [facebookListing], matches);

  assert.ok(plan.removedListingIds.includes("ot-1"), "omitting the still-matched listing from the combined array is exactly the bug the id-based fallback fetch exists to prevent");
});

test("a facebook listing that no longer matches the filter's criteria is correctly rejected, not silently kept", () => {
  const filter = baseFilter({ maxPricePerSqm: 7_000 });
  const overpriced = listing({ id: "fb-2", source: "facebook", price: 500_000, area: 50, pricePerSqm: 10_000 });
  const matches: RecalculationMatch[] = [{ listingId: "fb-2", isCurrentMatch: true, matchReasons: [] }];

  const plan = planFilterMatchRecalculation(filter, [overpriced], matches);

  assert.ok(plan.removedListingIds.includes("fb-2"));
  assert.ok(plan.rejectedByPricePerSqm >= 1);
});
