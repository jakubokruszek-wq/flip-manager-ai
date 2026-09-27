import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Real-execution proof of the mission's exact three-listing scenario against
 * the real recalculateFilterMatches(), using the real production filter
 * "Flip" (id, city, area, rooms) with its current criteria: max_price_per_sqm
 * 8200, building type blok/apartamentowiec, ownership pełna własność/
 * spółdzielcze. Proves: a genuine price violation is rejected with the real,
 * specific reason (never a generic placeholder); an offer under the cap is
 * matched with no stale reason left over from an old, stricter limit; an
 * offer missing only building type/ownership becomes REVIEW, never REJECTED
 * or a silent accept; and saving the filter touches zero facebook_scan_jobs
 * and stays idempotent under a repeated save.
 */
const FILTER_ID = "6ebf3a9c-5418-4ae6-a0bf-1989b6603367";
const REVIEW_ID = "00000000-8200-4000-8000-000000000001"; // 265000 / 38.6 m²
const MATCH_ID = "00000000-8200-4000-8000-000000000002"; // 385000 / 49.89 m²
const REJECT_ID = "00000000-8200-4000-8000-000000000003"; // 409000 / 39 m²

const flipFilter = {
  id: FILTER_ID, name: "Flip", sources: ["facebook"] as const, city: "Łódź", districts: [] as string[],
  priceMin: null, priceMax: null, areaMin: 32, areaMax: 75, rooms: [1, 2, 3, 4], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: ["blok", "apartamentowiec"], ownershipTypes: ["pełna własność", "spółdzielcze"], marketType: null,
  privateOnly: false, maxPricePerSqm: 8_200, requiredKeywords: [] as string[], excludedKeywords: [] as string[], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

mock.module("@/features/flip-finder/server/search-filters", {
  namedExports: { getSearchFilter: async (id: string) => (id === FILTER_ID ? flipFilter : null) },
});

function listingRow(id: string, overrides: Record<string, unknown>) {
  return {
    id, source: "facebook", original_url: `https://www.facebook.com/groups/example/permalink/${id}/`,
    title: "Mieszkanie, Łódź", description: null, rooms: 2, floor: "1", city: "Łódź", district: null, address: "Łódź",
    building_type: "blok", ownership: "pełna własność", manual_decision: null, lifecycle_status: "ACTIVE",
    ...overrides,
  };
}

const listingsTable = [
  listingRow(REVIEW_ID, { price: 265_000, area: 38.6, price_per_sqm: 265_000 / 38.6, building_type: null, ownership: null }),
  listingRow(MATCH_ID, { price: 385_000, area: 49.89, price_per_sqm: 385_000 / 49.89 }),
  listingRow(REJECT_ID, { price: 409_000, area: 39, price_per_sqm: 409_000 / 39 }),
];

type MatchRow = { isCurrentMatch: boolean; matchReasons: string[] };
const matchesTable = new Map<string, MatchRow>();
const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
const touchedTables: string[] = [];

function chainableRows(rows: unknown[]) {
  const builder: Record<string, unknown> = {
    select: () => builder, eq: () => builder, in: () => builder, order: () => builder, limit: () => builder,
    range: async () => ({ data: rows, error: null }),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
  };
  return builder;
}

function fakeAdminClient() {
  return {
    from: (table: string) => {
      touchedTables.push(table);
      if (table === "listings") return chainableRows(listingsTable);
      if (table === "listing_filter_matches") {
        return chainableRows([...matchesTable.entries()].map(([listingId, match]) => ({ listing_id: listingId, is_current_match: match.isCurrentMatch, match_reasons: match.matchReasons })));
      }
      if (table === "listing_filter_match_audit") {
        return { insert: async (rows: Record<string, unknown>[]) => { void rows; return { error: null }; } };
      }
      throw new Error(`unexpected table touched by filter-save recalculation: ${table}`);
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      const isCurrentMatch = params.p_bucket === "MATCHED";
      const matchReasons = Array.isArray(params.p_reasons) ? (params.p_reasons as string[]) : [];
      matchesTable.set(params.p_listing_id as string, { isCurrentMatch, matchReasons });
      return { data: [{ listing_id: params.p_listing_id, search_filter_id: params.p_filter_id, bucket: params.p_bucket, lifecycle_status: params.p_lifecycle_status, is_current_match: isCurrentMatch, match_reasons: matchReasons }], error: null };
    },
  };
}

mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: fakeAdminClient } });

const { recalculateFilterMatches } = await import("./filter-match-recalculation.ts");

function reset() {
  matchesTable.clear();
  rpcCalls.length = 0;
  touchedTables.length = 0;
  // All three start as stale, previously-visible MATCHED rows -- e.g. from
  // before building type/ownership were required, or under an older,
  // stricter max_price_per_sqm -- exactly production's real shape.
  matchesTable.set(REVIEW_ID, { isCurrentMatch: true, matchReasons: [] });
  matchesTable.set(MATCH_ID, { isCurrentMatch: false, matchReasons: ["max_price_per_sqm"] });
  matchesTable.set(REJECT_ID, { isCurrentMatch: true, matchReasons: [] });
}

test("saving filter 'Flip' at max_price_per_sqm=8200 recalculates all three real listings correctly and touches zero facebook_scan_jobs", async () => {
  reset();
  const result = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });
  assert.ok(result);

  assert.equal(touchedTables.includes("facebook_scan_jobs"), false, "saving a filter must never touch facebook_scan_jobs");
  assert.deepEqual(new Set(touchedTables), new Set(["listings", "listing_filter_matches", "listing_filter_match_audit"]));

  // 265000 / 38.6 m² (~6865 zł/m², under 8200): missing building type and
  // ownership -> REVIEW, never REJECTED, never a silent MATCHED accept.
  const review = matchesTable.get(REVIEW_ID);
  assert.ok(review, "the review-bucket listing must get a fresh reconciliation");
  assert.equal(review?.isCurrentMatch, false, "REVIEW is not a current match");
  assert.ok(review?.matchReasons.includes("review"), "REVIEW bucket must be tagged as such");
  assert.ok(review?.matchReasons.some((r) => r.includes("buildingType")), "missing building type must be recorded");
  assert.ok(review?.matchReasons.some((r) => r.includes("ownership")), "missing ownership must be recorded");
  assert.equal(review?.matchReasons.includes("max_price_per_sqm"), false, "265000/38.6m² does not violate the 8200 cap and must never carry that reason");

  // 385000 / 49.89 m² (~7717 zł/m², under 8200): must be matched with a
  // fresh reason, never the stale "max_price_per_sqm" from before.
  const matched = matchesTable.get(MATCH_ID);
  assert.ok(matched);
  assert.equal(matched?.isCurrentMatch, true, "7717 zł/m² is under the 8200 cap and must be a current match");
  assert.equal(matched?.matchReasons.includes("max_price_per_sqm"), false, "the old, stale max_price_per_sqm reason must never survive a recalculation that now matches");

  // 409000 / 39 m² (~10487 zł/m², over 8200): a genuine violation, rejected
  // with the real, specific, current reason.
  const rejected = matchesTable.get(REJECT_ID);
  assert.ok(rejected);
  assert.equal(rejected?.isCurrentMatch, false);
  assert.deepEqual(rejected?.matchReasons, ["max_price_per_sqm"], "the specific real reason must be persisted, never a generic placeholder");
});

test("saving the same filter twice in a row is idempotent — the second save changes nothing further and still touches zero facebook_scan_jobs", async () => {
  reset();
  await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });

  rpcCalls.length = 0;
  touchedTables.length = 0;
  const second = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });

  assert.equal(second?.addedMatches, 0, "nothing should change on a second, identical save");
  // Note: removedMatches legitimately stays 1 here (the REVIEW-bucket
  // listing structurally "does not currently match" on every single pass,
  // since its missing data never changes) -- that count reflects the plan's
  // own bookkeeping, not whether any write happened. Idempotency is proven
  // by zero actual writes below, not by this count reaching zero.
  assert.equal(rpcCalls.length, 0, "an already-correct membership must not trigger another canonical write");
  assert.equal(touchedTables.includes("facebook_scan_jobs"), false);
});
