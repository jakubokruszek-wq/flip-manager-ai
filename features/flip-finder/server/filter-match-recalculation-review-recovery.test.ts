import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Confirmed Production bug: planFilterMatchRecalculation's main loop only
 * ever updates a listing that is already in `existingIds` (currently
 * MATCHED or REVIEW). A listing stuck in any other persisted state --
 * concretely, is_current_match=false with match_reasons=["listing_missing"]
 * (the exact state the d8c6a86d source-allowlist bug left thousands of
 * records in) -- is excluded from existingIds, so neither the "matches"
 * branch (requires a full match) nor the "removed" branch (requires
 * existingIds.has) ever touches it again. Once a listing lands in this
 * state it stays invisible forever, no matter how many times recalculation
 * runs, even after the bug that put it there is fixed and the listing is
 * genuinely REVIEW-eligible again.
 *
 * This calls the real recalculateFilterMatches() end to end (not a hand-copied
 * reimplementation), mocking only its true I/O boundaries, exactly like
 * filter-save-recalculation-runtime.test.ts.
 */

const FILTER_ID = "bbbbbbbb-0000-4000-8000-000000000099";
const RECOVERABLE_ID = "aaaaaaaa-0000-4000-8000-0000000000a1";
const MANUAL_REJECTED_ID = "aaaaaaaa-0000-4000-8000-0000000000a2";
const ARCHIVED_ID = "aaaaaaaa-0000-4000-8000-0000000000a3";
const NEVER_MATCHED_ID = "aaaaaaaa-0000-4000-8000-0000000000a4";

let currentFilter = {
  id: FILTER_ID, name: "Review recovery filter", sources: ["domiporta"] as const, city: "Łódź", districts: [] as string[],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [] as number[], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false,
  // Non-empty on purpose: the filter must actually care about buildingType/
  // ownership for a listing missing both to evaluate as REVIEW (unknown
  // fields) rather than a trivial full MATCH that never exercises this fix.
  buildingTypes: ["blok"] as string[], ownershipTypes: ["pełna własność"] as string[], marketType: null,
  privateOnly: false, maxPricePerSqm: null as number | null, requiredKeywords: [] as string[], excludedKeywords: [] as string[], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

mock.module("@/features/flip-finder/server/search-filters", {
  namedExports: { getSearchFilter: async (id: string) => (id === FILTER_ID ? currentFilter : null) },
});

function listingRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: RECOVERABLE_ID, source: "domiporta", original_url: "https://domiporta.pl/oferta/mieszkanie-1",
    title: "Mieszkanie", description: null, price: 400_000, area: 50, price_per_sqm: 8_000,
    rooms: 2, floor: "1", city: "Łódź", district: "Widzew", address: "Widzew, Łódź",
    // Missing building_type/ownership -- genuinely REVIEW-eligible (missing
    // required data), never a hard rejection -- the exact shape this
    // recovery path exists for.
    building_type: null, ownership: null, manual_decision: null, lifecycle_status: "REJECTED",
    ...overrides,
  };
}

let listingsTable: Record<string, unknown>[] = [];
type MatchRow = { isCurrentMatch: boolean; matchReasons: string[] };
let matchesTable = new Map<string, MatchRow>();
let auditRows: Record<string, unknown>[] = [];
let rpcCalls: { name: string; params: Record<string, unknown> }[] = [];

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
      throw new Error(`unexpected table touched by review-recovery recalculation: ${table}`);
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      const isCurrentMatch = params.p_bucket === "MATCHED";
      const matchReasons = Array.isArray(params.p_reasons) ? (params.p_reasons as string[]) : [];
      matchesTable.set(params.p_listing_id as string, { isCurrentMatch, matchReasons });
      return {
        data: [{
          listing_id: params.p_listing_id, search_filter_id: params.p_filter_id, bucket: params.p_bucket,
          lifecycle_status: params.p_lifecycle_status, is_current_match: isCurrentMatch, match_reasons: matchReasons,
        }],
        error: null,
      };
    },
  };
}

mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: fakeAdminClient } });

const { recalculateFilterMatches } = await import("./filter-match-recalculation.ts");

function reset() {
  listingsTable = [];
  matchesTable = new Map();
  auditRows = [];
  rpcCalls = [];
  currentFilter = { ...currentFilter, maxPricePerSqm: null };
}

test("REAL BROKEN STATE: a listing wrongly stuck at is_current_match=false, match_reasons=[\"listing_missing\"] is recovered to REVIEW once it is genuinely REVIEW-eligible again", async () => {
  reset();
  listingsTable = [listingRow({})];
  // The exact state d8c6a86d's bug left real Production rows in: a prior
  // match row exists, but it is NOT current and its reasons are the stale
  // "listing_missing" marker -- never ACTIVE/current_match=true.
  matchesTable.set(RECOVERABLE_ID, { isCurrentMatch: false, matchReasons: ["listing_missing"] });

  const result = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });

  assert.ok(result);
  assert.equal(result?.recoveredReviewMatches, 1, "the stuck listing must be counted as a review recovery");
  assert.equal(result?.matchesAfter, 1, "matchesAfter must reflect the recovered REVIEW membership");

  const match = matchesTable.get(RECOVERABLE_ID);
  assert.ok(match, "a match row must exist after recovery");
  assert.equal(match?.isCurrentMatch, false, "REVIEW is never is_current_match=true");
  assert.ok(!match?.matchReasons.includes("listing_missing"), "the stale listing_missing marker must be replaced by the real, fresh reasons");

  assert.equal(rpcCalls.length, 1, "exactly one canonical reconciliation write for the recovered listing");
  assert.equal(rpcCalls[0]?.params.p_bucket, "REVIEW");
  assert.equal(rpcCalls[0]?.params.p_lifecycle_status, "REVIEW");

  const auditRow = auditRows.find((row) => row.listing_id === RECOVERABLE_ID);
  assert.ok(auditRow, "a membership audit row must record this recovery");
  assert.equal(auditRow?.previous_state, "INACTIVE");
  assert.equal(auditRow?.new_state, "REVIEW");
});

test("a manual_decision=REJECTED listing stuck in the same broken prior state stays excluded — manual rejections are never recovered", async () => {
  reset();
  listingsTable = [listingRow({ id: MANUAL_REJECTED_ID, manual_decision: "REJECTED" })];
  matchesTable.set(MANUAL_REJECTED_ID, { isCurrentMatch: false, matchReasons: ["listing_missing"] });

  const result = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });

  assert.ok(result);
  assert.equal(result?.recoveredReviewMatches, 0, "a manually rejected listing must never be recovered");
  assert.deepEqual(matchesTable.get(MANUAL_REJECTED_ID), { isCurrentMatch: false, matchReasons: ["listing_missing"] }, "the stale prior row must be left exactly as seeded — no write touched it");
  assert.equal(rpcCalls.length, 0, "no canonical write for a listing that stays manually rejected");
});

test("an ARCHIVED listing stuck in the same broken prior state stays excluded — archived listings are never recovered", async () => {
  reset();
  listingsTable = [listingRow({ id: ARCHIVED_ID, lifecycle_status: "ARCHIVED" })];
  matchesTable.set(ARCHIVED_ID, { isCurrentMatch: false, matchReasons: ["listing_missing"] });

  const result = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });

  assert.ok(result);
  assert.equal(result?.recoveredReviewMatches, 0, "an archived listing must never be recovered");
  assert.deepEqual(matchesTable.get(ARCHIVED_ID), { isCurrentMatch: false, matchReasons: ["listing_missing"] }, "the stale prior row must be left exactly as seeded — no write touched it");
  assert.equal(rpcCalls.length, 0);
});

test("a listing with NO prior match row at all is never fabricated into a REVIEW recovery — discovering brand-new REVIEW candidates stays the live scan's job", async () => {
  reset();
  listingsTable = [listingRow({ id: NEVER_MATCHED_ID })];
  // Deliberately no matchesTable.set() call for this id -- no prior row.

  const result = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });

  assert.ok(result);
  assert.equal(result?.recoveredReviewMatches, 0, "a listing never previously matched must not be newly created as REVIEW by recalculation");
  assert.equal(matchesTable.has(NEVER_MATCHED_ID), false);
  assert.equal(rpcCalls.length, 0);
});

test("re-running recalculation after a successful recovery is idempotent — the second pass changes nothing further", async () => {
  reset();
  listingsTable = [listingRow({})];
  matchesTable.set(RECOVERABLE_ID, { isCurrentMatch: false, matchReasons: ["listing_missing"] });

  const first = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });
  assert.equal(first?.recoveredReviewMatches, 1);

  rpcCalls.length = 0;
  auditRows.length = 0;
  const second = await recalculateFilterMatches(FILTER_ID, { allowWithoutScan: true });
  assert.equal(second?.recoveredReviewMatches, 0, "an already-recovered REVIEW membership must never be reported as a fresh recovery again");
  assert.equal(second?.addedMatches, 0);
  // A continuing REVIEW listing is never "unchanged" at the plan level (only
  // a full MATCH can be) -- see filter-match-recalculation.ts's own comment
  // on why REVIEW listings always appear in removedListingIds every pass.
  // The real idempotency guarantee is the write itself being skipped, which
  // the rpcCalls assertion below proves.
  assert.equal(second?.removedMatches, 1);
  assert.equal(rpcCalls.length, 0, "no further canonical write once the membership already reflects the correct REVIEW state — the already-correct check must skip the redundant write");
});
