import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Real-execution proof for the mission's exact numeric scenario: saving a
 * filter must immediately recalculate against public.listings (never
 * Facebook/OLX/Otodom/Morizon), and changing a threshold must re-match an
 * already-saved listing without any acquisition activity. This calls the
 * real recalculateFilterMatches() -- the same function both the create
 * (POST) and edit (PATCH) search-filters routes call -- and mocks only its
 * true I/O boundaries (getSearchFilter, the admin Supabase client).
 */
const FILTER_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const LISTING_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PRICE = 299_000;
const AREA = 45.13;
const PRICE_PER_SQM = PRICE / AREA; // ~6625.30

let currentFilter = {
  id: FILTER_ID, name: "Regression filter", sources: ["otodom"] as const, city: "Łódź", districts: [] as string[],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [] as number[], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [] as string[], ownershipTypes: [] as string[], marketType: null,
  privateOnly: false, maxPricePerSqm: 6_200 as number | null, requiredKeywords: [] as string[], excludedKeywords: [] as string[], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

mock.module("@/features/flip-finder/server/search-filters", {
  namedExports: {
    getSearchFilter: async (id: string) => (id === FILTER_ID ? currentFilter : null),
  },
});

const listingsTable = [
  {
    id: LISTING_ID, source: "otodom", original_url: "https://otodom.pl/pl/oferta/mieszkanie-testowe-ID9Z8Y7",
    title: "Mieszkanie testowe, Łódź", description: null, price: PRICE, area: AREA, price_per_sqm: PRICE_PER_SQM,
    rooms: null, floor: null, city: "Łódź", district: null, address: "Łódź", building_type: null, ownership: null,
    manual_decision: null, lifecycle_status: "REVIEW",
  },
];

type MatchRow = { isCurrentMatch: boolean; matchReasons: string[] };
const matchesTable = new Map<string, MatchRow>();
const auditRows: Record<string, unknown>[] = [];
const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
const touchedTables: string[] = [];

function chainableRows(rows: unknown[]) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    range: async () => ({ data: rows, error: null }),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve, reject),
  };
  return builder;
}

function fakeAdminClient() {
  return {
    from: (table: string) => {
      touchedTables.push(table);
      if (table === "listings") return chainableRows(listingsTable);
      if (table === "listing_filter_matches") {
        return chainableRows(
          [...matchesTable.entries()].map(([listingId, match]) => ({
            listing_id: listingId,
            is_current_match: match.isCurrentMatch,
            match_reasons: match.matchReasons,
          })),
        );
      }
      if (table === "listing_filter_match_audit") {
        return { insert: async (rows: Record<string, unknown>[]) => { auditRows.push(...rows); return { error: null }; } };
      }
      throw new Error(`unexpected table touched by filter-save recalculation: ${table}`);
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      const isCurrentMatch = params.p_bucket === "MATCHED";
      const matchReasons = Array.isArray(params.p_reasons) ? (params.p_reasons as string[]) : [];
      matchesTable.set(params.p_listing_id as string, { isCurrentMatch, matchReasons });
      return {
        data: [{
          listing_id: params.p_listing_id,
          search_filter_id: params.p_filter_id,
          bucket: params.p_bucket,
          lifecycle_status: params.p_lifecycle_status,
          is_current_match: isCurrentMatch,
          match_reasons: matchReasons,
        }],
        error: null,
      };
    },
  };
}

mock.module("@/lib/supabase/admin", {
  namedExports: { createAdminClient: fakeAdminClient },
});

const { recalculateFilterMatches } = await import("./filter-match-recalculation.ts");

function reset() {
  matchesTable.clear();
  auditRows.length = 0;
  rpcCalls.length = 0;
  touchedTables.length = 0;
  currentFilter = { ...currentFilter, maxPricePerSqm: 6_200 };
}

test("saving a new filter with max_price_per_sqm=6200 immediately rejects a 299000/45.13m² listing (~6625.30 zł/m²) without any Facebook activity", async () => {
  reset();
  const result = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });

  assert.ok(result);
  assert.equal(result?.matchesAfter, 0, "the listing must not match at a 6200 zł/m² cap");
  assert.equal(result?.rejectedByPricePerSqm, 1);
  assert.equal(matchesTable.has(LISTING_ID), false, "no match row may exist for a rejected listing");
  assert.equal(touchedTables.includes("facebook_scan_jobs"), false, "creating a filter must never touch facebook_scan_jobs");
  assert.deepEqual(new Set(touchedTables), new Set(["listings", "listing_filter_matches"]), "recalculation on save must only read public.listings and listing_filter_matches — no scan/job table");
  assert.equal(rpcCalls.length, 0, "no canonical write is needed for a listing that stays rejected");
});

test("changing that filter's max_price_per_sqm from 6200 to 7000 automatically re-matches the same listing — no rescan, no extension, no new facebook_scan_jobs", async () => {
  reset();
  await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });
  assert.equal(matchesTable.has(LISTING_ID), false, "sanity check: still rejected at 6200");

  touchedTables.length = 0;
  currentFilter = { ...currentFilter, maxPricePerSqm: 7_000 };
  const result = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });

  assert.equal(result?.addedMatches, 1, "the listing must be newly matched once the cap rises to 7000");
  assert.equal(result?.matchesAfter, 1);
  assert.equal(result?.rejectedByPricePerSqm, 0);

  const match = matchesTable.get(LISTING_ID);
  assert.ok(match, "a match row must now exist for this listing");
  assert.equal(match?.isCurrentMatch, true, "is_current_match must be true after the threshold widens");
  assert.ok(match?.matchReasons.length, "match_reasons must be populated, not empty");
  assert.deepEqual(match?.matchReasons, ["filter_recalculation"]);

  assert.equal(touchedTables.includes("facebook_scan_jobs"), false, "editing a filter must never touch facebook_scan_jobs");
  assert.deepEqual(new Set(touchedTables), new Set(["listings", "listing_filter_matches", "listing_filter_match_audit"]));
  assert.equal(rpcCalls.length, 1, "exactly one canonical reconciliation write for the newly matched listing");
  assert.equal(rpcCalls[0]?.name, "reconcile_canonical_listing_decision");
  assert.equal(rpcCalls[0]?.params.p_bucket, "MATCHED");
  assert.equal(rpcCalls[0]?.params.p_lifecycle_status, "ACTIVE");
});

test("re-saving the same filter twice in a row (a double click) is idempotent — the second recalculation changes nothing further", async () => {
  reset();
  currentFilter = { ...currentFilter, maxPricePerSqm: 7_000 };
  const first = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });
  assert.equal(first?.addedMatches, 1);

  rpcCalls.length = 0;
  const second = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });
  assert.equal(second?.addedMatches, 0, "an already-matched listing must not be re-added");
  assert.equal(second?.removedMatches, 0);
  assert.equal(second?.matchesAfter, 1);
  assert.equal(rpcCalls.length, 0, "an unchanged membership must not trigger another canonical write");
  assert.equal(touchedTables.includes("facebook_scan_jobs"), false);
});
