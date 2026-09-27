import assert from "node:assert/strict";
import test from "node:test";
import { planFilterMatchRecalculation, type RecalculationListing, type RecalculationMatch } from "./filter-match-recalculation-plan.ts";
import type { SearchFilter } from "@/features/flip-finder";

/**
 * Real production bug: Finder filter "Flip" (id 6ebf3a9c-5418-4ae6-a0bf-
 * 1989b6603367), facebook source, city Łódź, area 32-75, rooms 1-4,
 * max_price_per_sqm 7300 -- 154 Facebook listings, 148 stuck REJECTED,
 * 0 is_current_match=true, even for offers that clearly satisfy the current
 * filter (e.g. price 299000 / area 45.13 => ~6625.30 zł/m², well under 7300).
 * Every stuck listing carries match_reasons ["reconciled_out",
 * "complete_scan_filter_mismatch"] -- the exact, only string this codebase
 * produces from filter-match-recalculation.ts's "removed" branch.
 *
 * Root cause found by reading the code, not guessing: once ANY automatic
 * recalculation rejects a listing, filter-match-recalculation.ts's removed-
 * listing path calls reconcileCanonicalListingDecision with bucket
 * "REJECTED" and no explicit lifecycleStatus override, which sets the
 * listing's own (global, not per-filter) public.listings.lifecycle_status to
 * "REJECTED". planFilterMatchRecalculation's permanentlyExcluded check then
 * treats ANY lifecycle_status "REJECTED" the same as a genuine operator
 * manual_decision "REJECTED" -- skipping evaluateListingAgainstFilter
 * entirely on every later pass. That makes an automatic rejection
 * self-perpetuating: once REJECTED, a listing can never be reconsidered by
 * ANY future recalculation, even after the filter's own thresholds are
 * loosened, because it is never even evaluated against them again.
 */
const flipFilter: SearchFilter = {
  id: "6ebf3a9c-5418-4ae6-a0bf-1989b6603367",
  name: "Flip",
  sources: ["facebook"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: 32,
  areaMax: 75,
  rooms: [1, 2, 3, 4],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: false,
  buildingTypes: [],
  ownershipTypes: [],
  marketType: null,
  privateOnly: false,
  maxPricePerSqm: 7_300,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60,
  isActive: true,
  lastScannedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const STUCK_LISTING_ID = "3b122ec9-0d57-4e42-a591-43328361712d";

function stuckListing(overrides: Partial<RecalculationListing> = {}): RecalculationListing {
  return {
    id: STUCK_LISTING_ID,
    source: "facebook",
    originalUrl: "https://www.facebook.com/groups/example/permalink/1234567890/",
    title: "Mieszkanie 2 pokoje, Bałuty",
    description: null,
    price: 299_000,
    area: 45.13,
    pricePerSqm: 299_000 / 45.13,
    rooms: 2,
    floor: "2",
    city: "Łódź",
    district: "Bałuty",
    locationText: "Łódź, Bałuty",
    buildingType: null,
    ownership: null,
    manualDecision: null,
    lifecycleStatus: "REJECTED",
    ...overrides,
  };
}

// The exact persisted state reported from production: a match row with
// is_current_match=false and these two reasons, which the app only ever
// produces from the "removed" branch.
const stuckMatch: RecalculationMatch = {
  listingId: STUCK_LISTING_ID,
  isCurrentMatch: false,
  matchReasons: ["reconciled_out", "complete_scan_filter_mismatch"],
};

test("REPRODUCTION: an automatically (not manually) REJECTED listing that now satisfies the filter is never reconsidered", () => {
  const plan = planFilterMatchRecalculation(flipFilter, [stuckListing()], [stuckMatch]);

  // This is the real bug: the listing genuinely satisfies the current filter
  // (6625.30 zł/m² < 7300, area 45.13 within 32-75, 2 rooms within 1-4, city
  // Łódź) but is never even evaluated, because permanentlyExcluded treats an
  // automatic lifecycle_status="REJECTED" the same as manual_decision
  // "REJECTED".
  assert.equal(plan.addedListingIds.includes(STUCK_LISTING_ID), true, "a listing that satisfies the current filter must be re-matched, even after a prior automatic rejection");
  assert.equal(plan.evaluated, 1, "the listing must actually be evaluated against the current filter, not skipped as permanently excluded");
});

test("a GENUINELY manually rejected listing (manual_decision=REJECTED) stays excluded even if it would otherwise match", () => {
  const plan = planFilterMatchRecalculation(
    flipFilter,
    [stuckListing({ manualDecision: "REJECTED", lifecycleStatus: "REJECTED" })],
    [stuckMatch],
  );

  assert.equal(plan.addedListingIds.includes(STUCK_LISTING_ID), false, "an operator's explicit manual rejection must remain permanent");
});

test("an ARCHIVED listing stays excluded from automatic recalculation", () => {
  const plan = planFilterMatchRecalculation(
    flipFilter,
    [stuckListing({ lifecycleStatus: "ARCHIVED" })],
    [stuckMatch],
  );

  assert.equal(plan.addedListingIds.includes(STUCK_LISTING_ID), false, "an archived listing must not be silently re-activated by recalculation");
});

test("a listing that is automatically REJECTED and still does not satisfy the (now stricter) filter stays rejected, with no spurious write", () => {
  const plan = planFilterMatchRecalculation(
    { ...flipFilter, maxPricePerSqm: 5_000 },
    [stuckListing()],
    [stuckMatch],
  );

  assert.equal(plan.addedListingIds.includes(STUCK_LISTING_ID), false);
  assert.equal(plan.evaluated, 1, "it must still be evaluated, not skipped");
  assert.equal(plan.removedListingIds.includes(STUCK_LISTING_ID), false, "already-absent from the current match set, so there is nothing to remove again");
});

/**
 * Second mission on the same filter: "Flip" now also requires a confirmed
 * building type (blok/apartamentowiec) and ownership (pełna własność/
 * spółdzielcze), at max_price_per_sqm 8200. Root cause found by reading the
 * code, not guessing: filter-match-recalculation.ts's removed-listing branch
 * hard-coded bucket "REJECTED" and the same two generic reasons
 * ("reconciled_out", "complete_scan_filter_mismatch") for EVERY listing that
 * stopped matching, regardless of what evaluateListingAgainstFilter actually
 * found. That threw away two things every removal needs: (1) a listing
 * missing only building type/ownership data must become REVIEW, not
 * REJECTED — decisionBucket() already says so, but the write path ignored
 * it; (2) the real, specific reason (e.g. "max_price_per_sqm") was replaced
 * by a meaningless generic pair, so a later filter change (e.g. raising the
 * cap) left the OLD reason frozen in listing_filter_matches forever, because
 * nothing about it looked like it needed a fresh write.
 */
const flip8200Filter: SearchFilter = {
  ...flipFilter,
  maxPricePerSqm: 8_200,
  buildingTypes: ["blok", "apartamentowiec"],
  ownershipTypes: ["pełna własność", "spółdzielcze"],
};

function flipListing(overrides: Partial<RecalculationListing> = {}): RecalculationListing {
  return {
    id: "00000000-aaaa-4aaa-8aaa-000000000001",
    source: "facebook",
    originalUrl: "https://www.facebook.com/groups/example/permalink/1111111111/",
    title: "Mieszkanie, Łódź",
    description: null,
    price: 265_000,
    area: 38.6,
    pricePerSqm: 265_000 / 38.6,
    rooms: 2,
    floor: "1",
    city: "Łódź",
    district: null,
    locationText: "Łódź",
    buildingType: null,
    ownership: null,
    manualDecision: null,
    lifecycleStatus: "ACTIVE",
    ...overrides,
  };
}

test("265000 zł / 38.6 m² (~6865 zł/m², under the 8200 cap) with no confirmed building type or ownership becomes REVIEW, never REJECTED for price it does not violate", () => {
  const listingId = "00000000-aaaa-4aaa-8aaa-000000000010";
  const listing = flipListing({ id: listingId, price: 265_000, area: 38.6, pricePerSqm: 265_000 / 38.6 });
  // Was previously visible as a plain MATCHED row (e.g. from before building
  // type/ownership were required by this filter).
  const previousMatch: RecalculationMatch = { listingId, isCurrentMatch: true, matchReasons: [] };

  const plan = planFilterMatchRecalculation(flip8200Filter, [listing], [previousMatch]);

  assert.equal(plan.addedListingIds.includes(listingId), false);
  const removed = plan.removedListingDecisions.find((entry) => entry.listingId === listingId);
  assert.ok(removed, "the listing must be reconciled with a fresh decision, not silently left alone");
  assert.equal(removed?.bucket, "REVIEW", "missing data must produce REVIEW, never REJECTED, and never a silent MATCHED accept");
  assert.equal(removed?.reasons.includes("max_price_per_sqm"), false, "265000/38.6m² (~6865 zł/m²) does not violate the 8200 cap and must never be rejected for price");
  assert.ok(removed?.missingFields.includes("buildingType"), "missing building type must be surfaced");
  assert.ok(removed?.missingFields.includes("ownership"), "missing ownership must be surfaced");
});

test("385000 zł / 49.89 m² (~7717 zł/m², under the 8200 cap) is re-matched with a fresh reason, never the stale max_price_per_sqm from an old, stricter cap", () => {
  const listingId = "00000000-aaaa-4aaa-8aaa-000000000011";
  const listing = flipListing({
    id: listingId,
    price: 385_000,
    area: 49.89,
    pricePerSqm: 385_000 / 49.89,
    buildingType: "blok",
    ownership: "pełna własność",
  });
  // Persisted from an old, stricter cap (e.g. 7000): rejected for price,
  // therefore not "visible" (is_current_match=false, no review/unknown_
  // reason) and so not in existingIds -- exactly production's real state.
  const staleMatch: RecalculationMatch = { listingId, isCurrentMatch: false, matchReasons: ["max_price_per_sqm"] };

  const plan = planFilterMatchRecalculation(flip8200Filter, [listing], [staleMatch]);

  assert.equal(plan.addedListingIds.includes(listingId), true, "7717 zł/m² is under the current 8200 cap and must be matched");
  const stillFlaggedStale = plan.removedListingDecisions.some((entry) => entry.listingId === listingId && entry.reasons.includes("max_price_per_sqm"));
  assert.equal(stillFlaggedStale, false, "must never keep reporting the old max_price_per_sqm reason once the listing satisfies the current cap");
});

test("409000 zł / 39 m² (~10487 zł/m², over the 8200 cap) is rejected with the real, current, specific reason", () => {
  const listingId = "00000000-aaaa-4aaa-8aaa-000000000012";
  const listing = flipListing({
    id: listingId,
    price: 409_000,
    area: 39,
    pricePerSqm: 409_000 / 39,
    buildingType: "blok",
    ownership: "pełna własność",
  });
  // Was previously visible/matched (e.g. under a much higher old cap).
  const previousMatch: RecalculationMatch = { listingId, isCurrentMatch: true, matchReasons: [] };

  const plan = planFilterMatchRecalculation(flip8200Filter, [listing], [previousMatch]);

  assert.equal(plan.addedListingIds.includes(listingId), false);
  const removed = plan.removedListingDecisions.find((entry) => entry.listingId === listingId);
  assert.ok(removed, "an actual price violation must produce a real, persisted decision");
  assert.equal(removed?.bucket, "REJECTED", "409000/39m² (~10487 zł/m²) genuinely exceeds the 8200 cap and must be REJECTED, not REVIEW");
  assert.deepEqual(removed?.reasons, ["max_price_per_sqm"], "the specific, real reason must be persisted -- never a generic placeholder");
});

test("a listing whose source no longer belongs to the filter is removed with a specific, non-generic reason", () => {
  const listingId = "00000000-aaaa-4aaa-8aaa-000000000013";
  const listing = flipListing({ id: listingId, source: "olx" as RecalculationListing["source"] });
  const previousMatch: RecalculationMatch = { listingId, isCurrentMatch: true, matchReasons: [] };

  const plan = planFilterMatchRecalculation({ ...flip8200Filter, sources: ["facebook"] }, [listing], [previousMatch]);

  const removed = plan.removedListingDecisions.find((entry) => entry.listingId === listingId);
  assert.ok(removed);
  assert.deepEqual(removed?.reasons, ["source_not_in_filter"]);
});
