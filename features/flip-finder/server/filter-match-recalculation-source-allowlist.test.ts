import assert from "node:assert/strict";
import test from "node:test";

import { toListing } from "./filter-match-recalculation.ts";
import { planFilterMatchRecalculation, type RecalculationListing, type RecalculationMatch } from "@/features/flip-finder/filter-match-recalculation-plan";
import { LISTING_SOURCES } from "@/features/flip-finder/types/index.ts";
import type { SearchFilter } from "@/features/flip-finder";

/**
 * Confirmed Production bug: filter-match-recalculation.ts's own
 * isListingSource had drifted to a hand-maintained allowlist of only
 * otodom/olx/morizon/facebook -- 4 of the 17 real registered sources. The
 * exact same bug class, in the sibling file filter-results.ts, was already
 * found and fixed (see filter-results-listing-source-allowlist.test.ts);
 * this file was missed. toListing() returning null for a listing from any
 * of the other 13 sources (gratka, nieruchomosci_online, domiporta,
 * sprzedajemy, adresowo, oferty_net, szybko, bezposrednio, domy,
 * allegro_lokalnie, official_cooperative, official_uml, official_auction)
 * made that listing invisible to recalculateFilterMatches, so
 * planFilterMatchRecalculation (which compares "listings visible now"
 * against "matches that currently exist") reported it removed with reason
 * "listing_missing" even though the listing itself was untouched -- a
 * sampled slice of Production showed 81 such records.
 */

function listingRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "listing-1",
    original_url: "https://domiporta.pl/oferta/mieszkanie-1",
    source: "domiporta",
    title: "Mieszkanie",
    price: 400_000,
    area: 50,
    price_per_sqm: 8_000,
    rooms: 2,
    floor: "1",
    city: "Łódź",
    district: "Widzew",
    address: "Widzew, Łódź",
    description: null,
    building_type: null,
    ownership: null,
    manual_decision: null,
    lifecycle_status: "ACTIVE",
    ...overrides,
  };
}

test("every currently registered listing source is accepted by toListing -- none are silently dropped from recalculation", () => {
  for (const source of LISTING_SOURCES) {
    const listing = toListing(listingRow({ source }));
    assert.ok(listing, `a real active listing from "${source}" must reach the recalculation pass, not be silently dropped`);
    assert.equal(listing?.source, source);
  }
});

test("the exact regression: a real Domiporta listing is no longer dropped", () => {
  const listing = toListing(listingRow({ source: "domiporta" }));
  assert.ok(listing, "a Domiporta listing must be visible to recalculateFilterMatches");
  assert.equal(listing?.id, "listing-1");
  assert.equal(listing?.source, "domiporta");
});

test("an unknown/invalid source is still correctly rejected, proving this is an allowlist fix, not a bypass of validation", () => {
  const listing = toListing(listingRow({ source: "not-a-real-source" }));
  assert.equal(listing, null);
});

// buildingType/ownership trace: confirmed data must pass through unchanged,
// and missing data must stay null (never fabricated into a guessed value).
test("toListing passes through confirmed buildingType/ownership and leaves missing data as null, never fabricating a value", () => {
  const withData = toListing(listingRow({ source: "domiporta", building_type: "blok", ownership: "pelna_wlasnosc" }));
  assert.equal(withData?.buildingType, "blok");
  assert.equal(withData?.ownership, "pelna_wlasnosc");

  const withoutData = toListing(listingRow({ source: "domiporta", building_type: null, ownership: null }));
  assert.equal(withoutData?.buildingType, null);
  assert.equal(withoutData?.ownership, null);
});

const now = new Date().toISOString();
function baseFilter(overrides: Partial<SearchFilter> = {}): SearchFilter {
  return {
    id: "filter-1", name: "Test filter", sources: ["domiporta", "otodom"], city: null, districts: [],
    priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
    excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
    privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
    minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
    lastScannedAt: null, createdAt: now, updatedAt: now, ...overrides,
  };
}

function planListing(overrides: Partial<RecalculationListing> & { id: string; source: RecalculationListing["source"] }): RecalculationListing {
  return {
    price: 400_000, area: 50, pricePerSqm: 8_000, rooms: 2, floor: "1", city: "Łódź", district: "Widzew",
    title: "Test listing", description: null, locationText: "Widzew, Łódź", buildingType: null, ownership: null,
    originalUrl: `https://domiporta.pl/${overrides.id}`, manualDecision: null, lifecycleStatus: "ACTIVE", ...overrides,
  };
}

// Documents the bug at the plan level, independent of toListing: this is
// exactly what happened on every real recalculation pass before the fix --
// a previously-matched Domiporta listing that toListing() silently excluded
// never reached the `listings` array planFilterMatchRecalculation compares
// against, so its existing match had nothing to confirm it by and was
// reported removed with reason "listing_missing".
test("(documents the bug) a previously-matched listing missing from the listings array is wrongly removed as listing_missing", () => {
  const filter = baseFilter();
  const matches: RecalculationMatch[] = [{ listingId: "dom-1", isCurrentMatch: true, matchReasons: [] }];

  const plan = planFilterMatchRecalculation(filter, [], matches);

  assert.ok(plan.removedListingIds.includes("dom-1"));
  const decision = plan.removedListingDecisions.find((d) => d.listingId === "dom-1");
  assert.equal(decision?.bucket, "REJECTED");
  assert.deepEqual(decision?.reasons, ["listing_missing"]);
});

test("the fix: once toListing correctly includes the Domiporta listing, the same previously-matched listing is recovered, not removed", () => {
  const filter = baseFilter();
  const domiportaListing = planListing({ id: "dom-1", source: "domiporta" });
  const matches: RecalculationMatch[] = [{ listingId: "dom-1", isCurrentMatch: true, matchReasons: [] }];

  const plan = planFilterMatchRecalculation(filter, [domiportaListing], matches);

  assert.ok(!plan.removedListingIds.includes("dom-1"), "a real, still-matching listing must never be reported removed just because it is now visible again");
  assert.ok(plan.unchangedListingIds.includes("dom-1"), "the recovered match must be reported unchanged, proving it was correctly re-evaluated, not just defaulted back in");
});

// The critical safety check the user asked for by name: the allowlist fix
// must never also "recover" a listing an operator deliberately rejected by
// hand. manualDecision "REJECTED" must stay permanently excluded regardless
// of source or filter criteria, exactly as it already does for the 4
// original sources.
test("a genuine manual rejection on a newer-source listing stays rejected even though the listing is now visible to the recalculation pass", () => {
  const filter = baseFilter();
  const manuallyRejected = planListing({ id: "dom-2", source: "domiporta", manualDecision: "REJECTED" });
  const matches: RecalculationMatch[] = [{ listingId: "dom-2", isCurrentMatch: true, matchReasons: [] }];

  const plan = planFilterMatchRecalculation(filter, [manuallyRejected], matches);

  assert.ok(plan.removedListingIds.includes("dom-2"), "a manually rejected listing must stay excluded from matches");
  const decision = plan.removedListingDecisions.find((d) => d.listingId === "dom-2");
  assert.equal(decision?.bucket, "REJECTED");
  assert.deepEqual(decision?.reasons, ["manual_rejected"], "the real reason must be the operator's own decision, never conflated with listing_missing or any filter-criteria rejection");
});

test("a newer-source listing that genuinely no longer matches the filter's criteria is correctly rejected, not silently kept", () => {
  const filter = baseFilter({ maxPricePerSqm: 7_000 });
  const overpriced = planListing({ id: "dom-3", source: "domiporta", price: 500_000, area: 50, pricePerSqm: 10_000 });
  const matches: RecalculationMatch[] = [{ listingId: "dom-3", isCurrentMatch: true, matchReasons: [] }];

  const plan = planFilterMatchRecalculation(filter, [overpriced], matches);

  assert.ok(plan.removedListingIds.includes("dom-3"));
  assert.ok(plan.rejectedByPricePerSqm >= 1);
});
