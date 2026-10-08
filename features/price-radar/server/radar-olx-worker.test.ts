import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;
const ownerId = "owner-radar-olx";
const runId = "run-olx-1";
const radarLeaseToken = "radar-lease-current";
const checkpoint = { sourceQueue: ["olx"], currentSourceIndex: 0, perSourceCursor: {}, sourceStatuses: { olx: "running" }, sourceErrors: {}, buffer: [], bufferOffset: 0 };
let persisted: Row[] = [];
let finalized: Row[] = [];
let currentRunToken = radarLeaseToken;

function fakeDb() {
  return {
    from(table: string) {
      assert.equal(table, "price_radar_runs", "the Radar OLX worker reads only its owned run checkpoint");
      const filters: Array<(row: Row) => boolean> = [];
      const builder: Row = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        maybeSingle: async () => ({ data: { id: runId, owner_id: ownerId, checkpoint: structuredClone(checkpoint), source_statuses: structuredClone(checkpoint.sourceStatuses), scanned_count: 2, qualified_count: 1, status: "running", lease_token: currentRunToken, lease_until: new Date(Date.now() + 60_000).toISOString() }, error: null }),
      };
      return builder;
    },
    async rpc(name: string, args: Row) {
      assert.equal(name, "finalize_price_radar_olx_job");
      finalized.push(args);
      return { data: true, error: null };
    },
  };
}

mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { throw new Error("worker tests inject a fake DB"); } } });
mock.module("@/features/price-radar/server/persist-radar-listing", { namedExports: { persistRadarListing: async (_client: unknown, listing: Row, lease: Row) => { persisted.push({ listing, lease }); } } });
const { finishRadarOlxJob } = await import("./radar-olx-worker.ts");

function candidate() {
  return {
    source: "olx", externalListingId: "olx-unit-1", originalUrl: "https://www.olx.pl/oferta/unit-1", normalizedUrl: "https://www.olx.pl/oferta/unit-1",
    title: "Mieszkanie w bloku, Łódź Bałuty", description: "Świeżo po generalnym remoncie w 2025, nowe instalacje, gotowe do zamieszkania. Rynek wtórny.",
    price: 450_000, area: 50, pricePerSqm: 9_000, rooms: 2, floor: null, city: "Łódź", district: "Bałuty", buildingType: "blok",
    locationText: "Bałuty, Łódź", thumbnailUrl: null, images: [], publishedAt: null, rawPayload: {}, contentHash: "olx-hash-1",
  };
}

test("OLX worker persists only qualified Radar rows and finalizes through the Radar lease RPC", async () => {
  persisted = [];
  finalized = [];
  currentRunToken = radarLeaseToken;
  const result = await finishRadarOlxJob({ jobId: "job-1", jobLeaseToken: "job-lease-1", workerId: "worker-1", ownerId, runId, radarLeaseToken }, {
    fetched: 1, listings: [candidate() as never], warnings: [], durationMs: 1200,
  }, fakeDb() as never);
  assert.deepEqual(result, { source: "olx", status: "completed", fetched: 1, qualified: 1 });
  assert.equal(persisted.length, 1);
  assert.equal((persisted[0].listing as Row).source, "olx");
  assert.equal((persisted[0].lease as Row).ownerId, ownerId);
  assert.equal((persisted[0].lease as Row).runId, runId);
  assert.equal((persisted[0].lease as Row).leaseToken, radarLeaseToken);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].p_job_status, "completed");
  assert.equal(finalized[0].p_run_status, "completed");
  assert.equal(finalized[0].p_qualified_count, 2);
  assert.equal(finalized[0].p_scanned_count, 3);
  assert.equal((finalized[0].p_checkpoint as typeof checkpoint).currentSourceIndex, 1);
});

test("a stale Radar lease cannot persist or finalize an OLX worker result", async () => {
  persisted = [];
  finalized = [];
  currentRunToken = "new-owner-token";
  await assert.rejects(
    finishRadarOlxJob({ jobId: "job-1", jobLeaseToken: "old-job-token", workerId: "old-worker", ownerId, runId, radarLeaseToken }, {
      fetched: 1, listings: [candidate() as never], warnings: [], durationMs: 100,
    }, fakeDb() as never),
    /RADAR_LEASE_LOST/,
  );
  assert.equal(persisted.length, 0);
  assert.equal(finalized.length, 0);
});

test("a worker-reported terminal 403 fails the OLX source without retrying or persisting listings", async () => {
  persisted = [];
  finalized = [];
  currentRunToken = radarLeaseToken;
  const result = await finishRadarOlxJob({ jobId: "job-1", jobLeaseToken: "job-lease-1", workerId: "worker-1", ownerId, runId, radarLeaseToken }, {
    errorCode: "HTTP_403", errorMessage: "Forbidden",
  }, fakeDb() as never);
  assert.deepEqual(result, { source: "olx", status: "failed", fetched: 0, qualified: 0 });
  assert.equal(persisted.length, 0);
  assert.equal(finalized[0].p_job_status, "failed");
  assert.equal((finalized[0].p_source_statuses as Record<string, unknown>).olx, "failed");
  assert.equal((finalized[0].p_checkpoint as typeof checkpoint).currentSourceIndex, 1);
});
