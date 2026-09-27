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
