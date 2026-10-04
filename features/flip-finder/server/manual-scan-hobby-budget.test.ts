import assert from "node:assert/strict";
import test, { mock } from "node:test";

mock.module("server-only", { defaultExport: {} });

const sourceFetches: string[] = [];
const sourceIds = ["official_cooperative", "official_uml", "official_auction", "gratka"];
const sources = sourceIds.map((id) => ({
  id,
  label: id,
  fetch: async () => {
    sourceFetches.push(id);
    fakeNow += 10_000;
    return { listings: [], warnings: [], fetched: 0 };
  },
}));

let fakeNow = 0;
const sourceRows = sourceIds.map((source, index) => ({
  id: `source-${index + 1}`,
  source,
  status: "pending",
  started_at: "2026-10-04T00:00:00.000Z",
  scan_run_id: "run-fixed",
  continuation_lease_token: null,
  error_message: null,
  continuation_next_at: null,
}));

const filter = {
  id: "filter-fixed",
  name: "bounded",
  sources: sourceIds,
  city: "Łódź",
  districts: [], priceMin: null, priceMax: null, areaMin: null, areaMax: null,
  rooms: [], floorMin: null, floorMax: null, excludeGroundFloor: false,
  excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
  privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [],
  minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60, isActive: true, lastScannedAt: null,
  createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z",
};

mock.module("@/features/flip-finder/server/search-source-registry", { namedExports: { activeSources: () => sources } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getSearchFilter: async () => filter } });
mock.module("@/features/flip-finder/filter-evaluation", { namedExports: { evaluateListingAgainstFilter: () => ({ matches: false, unknownFields: [], reasons: [] }) } });
mock.module("@/features/flip-finder/scan-counters", { namedExports: { addScanItemCounts: (counts: unknown) => counts } });
mock.module("@/features/flip-finder/match-diagnostics", { namedExports: {
  addMatchDiagnostic: () => undefined,
  createMatchDiagnostic: () => ({ listingId: "none" }),
  emptyMatchDiagnosticSummary: () => ({ total: 0, matched: 0, rejected: 0, unknown: 0, byReason: {} }),
  mergeMatchDiagnosticSummaries: () => ({ total: 0, matched: 0, rejected: 0, unknown: 0, byReason: {} }),
} });
mock.module("@/features/flip-finder/server/olx-jobs", {
  namedExports: {
    enqueueOlxJob: async () => undefined,
    existingOlxScanResult: async () => null,
    resumableOlxRunId: async () => null,
  },
});
mock.module("@/features/flip-finder/server/persist-listing", { namedExports: { persistListing: async () => ({ listingId: "none", listingCreated: false, matchCreated: false, updated: 0, priceDrop: 0 }) } });
mock.module("@/features/flip-finder/server/filter-match-recalculation", { namedExports: { recalculateFilterMatches: async () => null } });

function matches(row: Record<string, unknown>, filters: Array<{ column: string; value: unknown; operator?: "eq" | "gt" }>): boolean {
  return filters.every(({ column, value, operator = "eq" }) => {
    if (operator === "gt") {
      // This fixture uses a fake clock for the worker budget. Treat a lease
      // written by the claim as live; expiry behavior is covered by the
      // dedicated continuation-lease tests with explicit timestamps.
      return column === "continuation_lease_until"
        ? typeof row[column] === "string"
        : String(row[column] ?? "") > String(value);
    }
    return row[column] === value;
  });
}

function builder(table: string) {
  let mode: "select" | "update" = "select";
  let patch: Record<string, unknown> = {};
  const filters: Array<{ column: string; value: unknown; operator?: "eq" | "gt" }> = [];
  const chain: Record<string, unknown> = {
    select: () => chain,
    update: (value: Record<string, unknown>) => { mode = "update"; patch = value; return chain; },
    eq: (column: string, value: unknown) => { filters.push({ column, value }); return chain; },
    gt: (column: string, value: unknown) => { filters.push({ column, value, operator: "gt" }); return chain; },
    in: () => chain,
    abortSignal: () => chain,
    maybeSingle: async () => ({ data: sourceRows.find((row) => matches(row, filters)) ?? null, error: null }),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve().then(() => {
      if (table === "search_filters") return { data: null, error: null };
      const selected = sourceRows.filter((row) => matches(row, filters));
      if (mode === "update") {
        selected.forEach((row) => Object.assign(row, patch));
        // CAS claim uses select() and expects an array; progress/finalization
        // updates only inspect the error property.
        if (Object.prototype.hasOwnProperty.call(patch, "status") && patch.status === "running") {
          return { data: selected.map((row) => ({ id: row.id, started_at: row.started_at, continuation_lease_token: row.continuation_lease_token })), error: null };
        }
      }
      return { data: mode === "select" ? selected : null, error: null };
    }).then(resolve, reject),
  };
  return chain;
}

mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => ({ from: (table: string) => builder(table) }) } });

const { runManualOtodomScan } = await import("./manual-scan.ts");

test("bounded initial scan leaves the fourth source pending in the same run for continuation", async () => {
  sourceFetches.length = 0;
  sourceRows.forEach((row) => { row.status = "pending"; row.scan_run_id = "run-fixed"; row.error_message = null; row.continuation_next_at = null; });
  const originalNow = Date.now;
  Date.now = () => fakeNow;
  fakeNow = originalNow();
  try {
    const summary = await runManualOtodomScan(filter.id, { runId: "run-fixed", usePreparedRows: true, skipLock: true });
    assert.deepEqual(sourceFetches, sourceIds.slice(0, 3));
    assert.equal(summary.status, "running");
    assert.equal(summary.sourceResults.at(-1)?.status, "pending");
    assert.equal(summary.sourceResults.at(-1)?.errorCode, "SOURCE_BUDGET_EXHAUSTED");
    assert.equal(sourceRows[3].status, "pending");
    assert.equal(sourceRows[3].scan_run_id, "run-fixed");
    assert.match(String(sourceRows[3].error_message), /^SOURCE_TIMEOUT:/);
    assert.equal(typeof sourceRows[3].continuation_next_at, "string");
  } finally {
    Date.now = originalNow;
  }
});

test("a retry of the same run skips completed and terminal source rows", async () => {
  sourceFetches.length = 0;
  sourceRows.forEach((row) => { row.status = "pending"; row.scan_run_id = "run-fixed"; row.error_message = null; row.continuation_next_at = null; });
  sourceRows[0].status = "completed";
  sourceRows[1].status = "failed";
  const originalNow = Date.now;
  Date.now = () => fakeNow;
  fakeNow = originalNow();
  try {
    await runManualOtodomScan(filter.id, { runId: "run-fixed", usePreparedRows: true, skipLock: true });
    assert.deepEqual(sourceFetches, sourceIds.slice(2), "only pending sources may be fetched on a same-run retry");
  } finally {
    Date.now = originalNow;
  }
});

test("a duplicate callback with no pending work is a no-op", async () => {
  sourceFetches.length = 0;
  sourceRows.forEach((row) => { row.status = "completed"; row.scan_run_id = "run-fixed"; row.error_message = null; row.continuation_next_at = null; });
  const originalNow = Date.now;
  Date.now = () => 0;
  try {
    const summary = await runManualOtodomScan(filter.id, { runId: "run-fixed", usePreparedRows: true, skipLock: true });
    assert.equal(summary.status, "completed");
    assert.deepEqual(sourceFetches, []);
  } finally {
    Date.now = originalNow;
  }
});
