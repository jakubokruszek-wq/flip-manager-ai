import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Real-execution proof for the Finder/Watcher contract, not just a source-
 * text check: this actually calls runManualOtodomScan() (the exact function
 * the "Skanuj" button's route handler calls) with a facebook-only filter,
 * and proves at runtime -- via a spy, not a regex over the file -- that it
 * never touches facebook_scan_jobs and calls recalculateFilterMatches
 * exactly once, scoped to facebook, instead.
 */
const recalculateCalls: Array<{ filterId: string; options: unknown }> = [];
let recalculateResult: unknown = { evaluated: 3, matchesAfter: 2, addedMatches: 1, rejectedByPricePerSqm: 0, rejectedByOtherCriteria: 1 };

mock.module("@/features/flip-finder/server/filter-match-recalculation", {
  namedExports: {
    recalculateFilterMatches: async (filterId: string, options: unknown) => {
      recalculateCalls.push({ filterId, options });
      return recalculateResult;
    },
  },
});

const testFilter = {
  id: "filter-1", name: "Facebook only", sources: ["facebook"], city: "Łódź", districts: [],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
  privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

mock.module("@/features/flip-finder/server/search-filters", {
  namedExports: {
    getSearchFilter: async (id: string) => (id === testFilter.id ? testFilter : null),
  },
});

// Records every table this run touches on the admin (service-role) client,
// so "zero facebook_scan_jobs interaction" is a real, checkable fact, not an
// assumption -- and every query resolves as a real Supabase client's would
// (thenable, chainable through .select/.eq/.in/.limit/.abortSignal/...).
const touchedTables: string[] = [];
function chainable(result: unknown) {
  const builder: Record<string, unknown> = {
    select: () => builder, eq: () => builder, in: () => builder, lt: () => builder,
    limit: () => builder, order: () => builder, abortSignal: () => builder, update: () => builder,
    single: async () => result, maybeSingle: async () => result,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}
mock.module("@/lib/supabase/admin", {
  namedExports: {
    createAdminClient: () => ({
      from: (table: string) => {
        touchedTables.push(table);
        if (table === "source_scans") return chainable({ data: [], error: null });
        if (table === "search_filters") return chainable({ data: null, error: null });
        throw new Error(`unexpected table touched by a Finder scan: ${table}`);
      },
    }),
  },
});

const { runManualOtodomScan } = await import("./manual-scan.ts");

test("a Finder scan of a facebook-only filter never touches facebook_scan_jobs and reconciles via recalculateFilterMatches, scoped to facebook, exactly once", async () => {
  recalculateCalls.length = 0;
  touchedTables.length = 0;
  const summary = await runManualOtodomScan(testFilter.id);

  assert.equal(touchedTables.includes("facebook_scan_jobs"), false, "no facebook_scan_jobs row may be read or written by a Finder-triggered scan");
  assert.deepEqual(new Set(touchedTables), new Set(["source_scans", "search_filters"]), "a facebook-only Finder scan must touch only source_scans (its own lock bookkeeping) and search_filters (last_scanned_at)");

  assert.equal(recalculateCalls.length, 1, "recalculateFilterMatches must be called exactly once for a facebook-only filter");
  assert.equal(recalculateCalls[0].filterId, testFilter.id);
  assert.deepEqual(recalculateCalls[0].options, { allowWithoutScan: true, scanRunId: summary.runId, sourcesOverride: ["facebook"] });

  const facebookResult = summary.sourceResults.find((result) => result.source === "facebook");
  assert.ok(facebookResult, "the summary must include a facebook source result");
  assert.equal(facebookResult?.status, "completed");
  // The recalculation's own numbers must reach the summary verbatim -- never
  // fabricated, never re-derived from something else.
  assert.equal(facebookResult?.fetched, 3);
  assert.equal(facebookResult?.matched, 2);
  assert.equal(facebookResult?.newMatches, 1);
});

test("a listing the Watcher already saved becomes a new match once Finder recalculates, with no Facebook acquisition involved", async () => {
  recalculateCalls.length = 0;
  touchedTables.length = 0;
  recalculateResult = { evaluated: 1, matchesAfter: 1, addedMatches: 1, rejectedByPricePerSqm: 0, rejectedByOtherCriteria: 0 };
  const summary = await runManualOtodomScan(testFilter.id);
  const facebookResult = summary.sourceResults.find((result) => result.source === "facebook");
  assert.equal(facebookResult?.newMatches, 1, "a listing already persisted by the Watcher must surface as a new match purely from recalculation, with zero facebook_scan_jobs activity");
  assert.equal(touchedTables.includes("facebook_scan_jobs"), false);
});
