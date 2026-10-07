import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "@/features/facebook-watcher/server/facebook-fake-supabase.ts";

mock.module("server-only", { defaultExport: {} });
mock.module("@/features/facebook-worker/multi-group", { namedExports: { aggregateFacebookJobStatus: () => "completed" } });
mock.module("@/features/flip-finder/filter-evaluation", { namedExports: { evaluateListingAgainstFilter: () => ({ matches: false, unknownFields: [], reasons: [] }) } });
mock.module("@/features/flip-finder/match-diagnostics", { namedExports: { addMatchDiagnostic: () => undefined, createMatchDiagnostic: () => ({}), emptyMatchDiagnosticSummary: () => ({}) } });
mock.module("@/features/flip-finder/scan-counters", { namedExports: { addScanItemCounts: (counts: { listingsCreatedCount: number; newMatchesCount: number }, item: { listingCreated: boolean; matchCreated: boolean }) => ({ listingsCreatedCount: counts.listingsCreatedCount + Number(item.listingCreated), newMatchesCount: counts.newMatchesCount + Number(item.matchCreated) }) } });
mock.module("@/features/flip-finder/olx-parser", { namedExports: { assertAllowedOlxUrl: (url: string) => new URL(url) } });
const persistedPrices: unknown[] = [];
mock.module("@/features/flip-finder/server/persist-listing", { namedExports: { persistListing: async (_db: unknown, _filterId: string, listing: { price: unknown }) => { persistedPrices.push(listing.price); return { listingId: `persisted-${persistedPrices.length}`, listingCreated: true, matchCreated: true, updated: 1, priceDrop: 0 }; } } });
const searchFilter = { id: "filter-1", city: "Łódź" } as never;
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getSearchFilter: async () => searchFilter } });
mock.module("@/features/flip-finder/server/listing-attribute-reuse", { namedExports: { reuseExistingListingAttributes: async (_db: unknown, listings: unknown[]) => listings } });
mock.module("@/features/flip-finder/server/search-source-registry", { namedExports: { slugifyCity: (value: string | null) => value ?? "lodz" } });

type Row = Record<string, unknown>;
let jobs: Row[] = [];
let scans: Row[] = [];
let completionDb: FakeFacebookSupabase | null = null;

function client() {
  if (completionDb) return completionDb;
  return {
    from(table: string) {
      const rows = table === "olx_scan_jobs" ? jobs : scans;
      const filters: Array<[string, unknown]> = [];
      let limit = Number.POSITIVE_INFINITY;
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
        in: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
        order: () => builder,
        limit: (value: number) => { limit = value; return builder; },
        maybeSingle: async () => {
          const matched = rows.filter((row) => filters.every(([column, value]) => Array.isArray(value) ? value.includes(row[column]) : row[column] === value));
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          const matched = rows.filter((row) => filters.every(([column, value]) => Array.isArray(value) ? value.includes(row[column]) : row[column] === value)).slice(0, limit);
          return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

mock.module("@/features/flip-finder/server/olx-worker-admin", { namedExports: { createOlxWorkerAdminClient: client } });

const { completeOlxJob, existingOlxScanResult, resumableOlxRunId } = await import("./olx-jobs.ts");

test("OLX resumption selects one unfinished run and refuses mixed unfinished run ids", async () => {
  jobs = [{ search_filter_id: "filter-1", scan_run_id: "run-a", status: "queued" }];
  scans = [];
  assert.equal(await resumableOlxRunId("filter-1"), "run-a");

  jobs = [
    { search_filter_id: "filter-1", scan_run_id: "run-a", status: "queued" },
    { search_filter_id: "filter-1", scan_run_id: "run-b", status: "running" },
  ];
  await assert.rejects(() => resumableOlxRunId("filter-1"), /OLX_MULTIPLE_RUN_IDS/);
});

test("a completed OLX result is returned from the existing job and never treated as a new fetch", async () => {
  jobs = [{ scan_run_id: "run-complete", status: "completed", result_summary: { source: "olx", status: "completed", fetched: 2, normalized: 2, matched: 1, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, durationMs: 5, errorCode: null, errorMessage: null, warnings: [], matchDiagnostics: {} } }];
  scans = [];
  const result = await existingOlxScanResult("run-complete");
  assert.equal(result?.status, "completed");
  assert.equal(result?.fetched, 2);
});

test("OLX completion skips invalid total sale prices before persistence and counts them as rejected", async () => {
  completionDb = new FakeFacebookSupabase()
    .seed("olx_scan_jobs", [{ id: "job-1", status: "running", lease_token: "lease-1", worker_id: "worker-1", source_scan_id: "scan-1", search_filter_id: "filter-1", result_summary: null }])
    .seed("source_scans", [{ id: "scan-1", search_filter_id: "filter-1", source: "olx", status: "running", started_at: "2026-10-07T10:00:00.000Z" }])
    .seed("search_filters", [{ id: "filter-1" }]);
  persistedPrices.length = 0;
  const result = await completeOlxJob({
    jobId: "job-1", leaseToken: "lease-1", workerId: "worker-1", fetched: 2, warnings: [], durationMs: 20,
    listings: [
      { source: "olx", externalListingId: "no-price", price: null },
      { source: "olx", externalListingId: "valid", price: 439_000 },
    ] as never,
  });

  assert.deepEqual(persistedPrices, [439_000], "only the valid sale price may reach persistListing");
  assert.equal(result.normalized, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.listingsCreated, 1);
  assert.ok((result.warnings ?? []).some((warning) => warning.startsWith("INVALID_SALE_PRICE:")));
  assert.equal(completionDb.rows("source_scans")[0]?.status, "completed", "one invalid item does not fail the OLX scan");
  assert.equal(completionDb.rows("olx_scan_jobs")[0]?.status, "completed");
  completionDb = null;
});
