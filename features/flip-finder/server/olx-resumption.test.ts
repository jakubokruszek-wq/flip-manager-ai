import assert from "node:assert/strict";
import test, { mock } from "node:test";

mock.module("server-only", { defaultExport: {} });
mock.module("@/features/facebook-worker/multi-group", { namedExports: { aggregateFacebookJobStatus: () => "completed" } });
mock.module("@/features/flip-finder/filter-evaluation", { namedExports: { evaluateListingAgainstFilter: () => ({ matches: false, unknownFields: [], reasons: [] }) } });
mock.module("@/features/flip-finder/match-diagnostics", { namedExports: { addMatchDiagnostic: () => undefined, createMatchDiagnostic: () => ({}), emptyMatchDiagnosticSummary: () => ({}) } });
mock.module("@/features/flip-finder/scan-counters", { namedExports: { addScanItemCounts: (counts: unknown) => counts } });
mock.module("@/features/flip-finder/olx-parser", { namedExports: { assertAllowedOlxUrl: (url: string) => new URL(url) } });
mock.module("@/features/flip-finder/server/persist-listing", { namedExports: { persistListing: async () => ({}) } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getSearchFilter: async () => null } });
mock.module("@/features/flip-finder/server/search-source-registry", { namedExports: { slugifyCity: (value: string | null) => value ?? "lodz" } });

type Row = Record<string, unknown>;
let jobs: Row[] = [];
let scans: Row[] = [];

function client() {
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

const { existingOlxScanResult, resumableOlxRunId } = await import("./olx-jobs.ts");

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
