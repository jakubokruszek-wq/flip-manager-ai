import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;
const fixedJobUntil = "2032-02-03T04:05:06.000Z";
const fixedRadarUntil = "2032-02-03T04:05:07.000Z";
let tables: Record<string, Row[]>;
let rpcCalls: string[];

function fakeAdmin() {
  return {
    async rpc(name: string, args: Row) {
      rpcCalls.push(name);
      if (name === "heartbeat_price_radar_olx_job") {
        const job = tables.olx_scan_jobs.find((row) => row.id === args.p_job_id && row.lease_token === args.p_job_lease_token && row.radar_lease_token === args.p_radar_lease_token && row.status === "running");
        const run = tables.price_radar_runs.find((row) => row.id === job?.radar_run_id && row.owner_id === job?.radar_owner_id && row.lease_token === args.p_radar_lease_token && row.status === "running");
        if (!job || !run) return { data: false, error: null };
        job.leased_until = fixedJobUntil;
        run.lease_until = fixedRadarUntil;
        return { data: true, error: null };
      }
      if (name === "claim_olx_scan_job") return { data: [{ ...tables.olx_scan_jobs[0], leased_until: fixedJobUntil }], error: null };
      throw new Error(`unexpected RPC ${name}`);
    },
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: Array<[string, unknown]> = [];
      let operation: "select" | "update" = "select";
      let patch: Row = {};
      const builder: Row = {
        select: () => builder,
        update: (value: Row) => { operation = "update"; patch = value; return builder; },
        eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
        maybeSingle: async () => {
          const row = rows.find((candidate) => filters.every(([key, value]) => candidate[key] === value)) ?? null;
          if (row && operation === "update") Object.assign(row, patch);
          return { data: row, error: null };
        },
      };
      return builder;
    },
  };
}

mock.module("server-only", { defaultExport: {} });
mock.module("@/features/facebook-worker/multi-group", { namedExports: { aggregateFacebookJobStatus: () => "completed" } });
mock.module("@/features/flip-finder/filter-evaluation", { namedExports: { evaluateListingAgainstFilter: () => ({ matches: false, unknownFields: [], reasons: [] }) } });
mock.module("@/features/flip-finder/match-diagnostics", { namedExports: { addMatchDiagnostic: () => undefined, createMatchDiagnostic: () => ({}), emptyMatchDiagnosticSummary: () => ({}) } });
mock.module("@/features/flip-finder/olx-parser", { namedExports: { assertAllowedOlxUrl: (url: string) => new URL(url) } });
mock.module("@/features/flip-finder/scan-counters", { namedExports: { addScanItemCounts: () => ({ listingsCreatedCount: 0, newMatchesCount: 0 }) } });
mock.module("@/features/flip-finder/server/persist-listing", { namedExports: { persistListing: async () => ({ listingId: "listing-1", listingCreated: false, matchCreated: false, updated: 0, priceDrop: 0 }) } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getSearchFilter: async () => null } });
mock.module("@/features/flip-finder/server/listing-attribute-reuse", { namedExports: { reuseExistingListingAttributes: async (_db: unknown, rows: unknown[]) => rows } });
mock.module("@/features/flip-finder/server/search-source-registry", { namedExports: { slugifyCity: () => "lodz" } });
mock.module("@/features/price-radar/server/radar-olx-worker", { namedExports: { finishRadarOlxJob: async () => ({ source: "olx", status: "completed", fetched: 0, qualified: 0 }) } });
mock.module("@/features/flip-finder/server/olx-worker-admin", { namedExports: { createOlxWorkerAdminClient: () => fakeAdmin() } });

const { claimOlxJob, heartbeatOlxJob } = await import("./olx-jobs.ts");

function reset(contextType: "finder" | "price_radar") {
  rpcCalls = [];
  tables = {
    olx_scan_jobs: [{
      id: "job-1", scan_run_id: "run-1", source_scan_id: "scan-1", search_filter_id: "filter-1", context_type: contextType,
      radar_owner_id: contextType === "price_radar" ? "owner-1" : null, radar_run_id: contextType === "price_radar" ? "run-1" : null,
      radar_lease_token: contextType === "price_radar" ? "radar-token" : null, request_url: "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/",
      lease_token: "job-token", worker_id: "worker-1", leased_until: "2030-01-01T00:00:00.000Z", status: "running", attempts: 1,
    }],
    price_radar_runs: [{ id: "run-1", owner_id: "owner-1", lease_token: "radar-token", lease_until: "2030-01-01T00:00:01.000Z", status: "running" }],
  };
}

test("Radar claim returns the actual run lease separately from the OLX job lease", async () => {
  reset("price_radar");
  const job = await claimOlxJob("worker-1");
  assert.equal(job?.leasedUntil, fixedJobUntil);
  assert.equal(job?.radarLeaseUntil, tables.price_radar_runs[0]?.lease_until);
  assert.equal(job?.radarLeaseUntil, "2030-01-01T00:00:01.000Z");
});

test("Radar heartbeat returns both database lease timestamps, not an app-clock estimate", async () => {
  reset("price_radar");
  const leases = await heartbeatOlxJob({ jobId: "job-1", leaseToken: "job-token", workerId: "worker-1", radarLeaseToken: "radar-token" });
  assert.deepEqual(leases, { jobLeasedUntil: fixedJobUntil, radarLeaseUntil: fixedRadarUntil });
  assert.equal(tables.olx_scan_jobs[0]?.leased_until, fixedJobUntil);
  assert.equal(tables.price_radar_runs[0]?.lease_until, fixedRadarUntil);
  assert.deepEqual(rpcCalls, ["heartbeat_price_radar_olx_job"]);
});

test("Finder heartbeat returns only its actual OLX queue lease and does not touch a Radar run", async () => {
  reset("finder");
  const leases = await heartbeatOlxJob({ jobId: "job-1", leaseToken: "job-token", workerId: "worker-1" });
  assert.equal(leases.jobLeasedUntil > new Date().toISOString(), true);
  assert.equal(leases.radarLeaseUntil, null);
  assert.deepEqual(rpcCalls, []);
});

test("a mismatched Radar token never calls the heartbeat RPC", async () => {
  reset("price_radar");
  await assert.rejects(heartbeatOlxJob({ jobId: "job-1", leaseToken: "job-token", workerId: "worker-1", radarLeaseToken: "stale-token" }), /RADAR_LEASE_LOST/);
  assert.deepEqual(rpcCalls, []);
});
