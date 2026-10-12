import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;
const ownerId = "owner-radar-olx";
const runId = "run-olx-1";
const radarLeaseToken = "radar-lease-current";
const checkpoint = { sourceQueue: ["olx"], currentSourceIndex: 0, perSourceCursor: {}, sourceStatuses: { olx: "running" }, sourceErrors: {}, buffer: [], bufferOffset: 0 };
let persisted: Row[] = [];
let finalized: Row[] = [];
let districtQueueUpserts: Row[] = [];
let districtQueueSchemaUnavailable = false;
let currentRunToken = radarLeaseToken;
let runStopRequestedAt: string | null = null;

function fakeDb() {
  return {
    from(table: string) {
      assert.ok(table === "price_radar_runs" || table === "price_radar_district_queue" || table === "price_radar_verification_queue" || table === "price_radar_listings", "the Radar OLX worker reads only its owned run checkpoint, its own district queue, the verification queue's prior rejections, and the active comparison analysis");
      const filters: Array<(row: Row) => boolean> = [];
      const builder: Row = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        // No test here seeds a pre-rejected candidate or an already-active analysis row, so the ids lookup always comes back empty.
        in: async () => ({ data: [], error: null }),
        maybeSingle: async () => {
          if (table === "price_radar_district_queue") return districtQueueSchemaUnavailable
            ? { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.price_radar_district_queue' in the schema cache" } }
            : { data: null, error: null }; // no existing row -- every candidate here is "new" for caching purposes
          return { data: { id: runId, owner_id: ownerId, checkpoint: structuredClone(checkpoint), source_statuses: structuredClone(checkpoint.sourceStatuses), scanned_count: 2, qualified_count: 1, status: "running", lease_token: currentRunToken, lease_until: new Date(Date.now() + 60_000).toISOString(), stop_requested_at: runStopRequestedAt }, error: null };
        },
      };
      return builder;
    },
    async rpc(name: string, args: Row) {
      if (name === "upsert_price_radar_district_queue_candidate") {
        districtQueueUpserts.push(args);
        return { data: "queue-row-1", error: null };
      }
      assert.equal(name, "finalize_price_radar_olx_job");
      finalized.push(args);
      return { data: true, error: null };
    },
  };
}

mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { throw new Error("worker tests inject a fake DB"); } } });
mock.module("@/features/price-radar/server/persist-radar-listing", { namedExports: {
  persistRadarListing: async (_client: unknown, listing: Row, lease: Row) => { persisted.push({ listing, lease }); },
  // No test here seeds a pre-existing active analysis row, so this always comes back empty.
  activeRadarListingExternalIds: async () => new Set<string>(),
} });
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
  districtQueueUpserts = [];
  currentRunToken = radarLeaseToken;
  runStopRequestedAt = null;
  districtQueueSchemaUnavailable = false;
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

test("OLX worker records strict rejection reasons without persisting an unqualified offer", async () => {
  persisted = [];
  finalized = [];
  districtQueueUpserts = [];
  currentRunToken = radarLeaseToken;
  runStopRequestedAt = null;
  districtQueueSchemaUnavailable = false;
  // A candidate missing a building type AND a district: with no building
  // type, assessRadarDistrictOnlyCandidate must find it ineligible for the
  // district queue, so this stays a genuine, counted rejection.
  const result = await finishRadarOlxJob({ jobId: "job-1", jobLeaseToken: "job-lease-1", workerId: "worker-1", ownerId, runId, radarLeaseToken }, {
    fetched: 1, listings: [{ ...candidate(), district: null, buildingType: null, title: "Mieszkanie", description: "Świeżo po generalnym remoncie w 2025, gotowe do zamieszkania. Rynek wtórny." } as never], warnings: [], durationMs: 1200,
  }, fakeDb() as never);
  assert.deepEqual(result, { source: "olx", status: "completed", fetched: 1, qualified: 0 });
  assert.equal(persisted.length, 0, "rejection diagnostics do not weaken or bypass qualification");
  assert.equal(districtQueueUpserts.length, 0, "an offer missing more than just its district is never queued");
  const savedCheckpoint = finalized[0].p_checkpoint as Row;
  assert.deepEqual(savedCheckpoint.qualificationRejections, { olx: { district_not_confirmed: 1 } });
  assert.deepEqual((finalized[0].p_result_summary as Row).qualificationRejections, savedCheckpoint.qualificationRejections);
  assert.equal((finalized[0].p_qualified_count as number), 1, "the persisted run count remains the preexisting total plus zero new qualifications");
});

test("OLX worker queues (never rejects) a candidate missing ONLY its district -- every other Radar criterion already confirmed", async () => {
  persisted = [];
  finalized = [];
  districtQueueUpserts = [];
  currentRunToken = radarLeaseToken;
  runStopRequestedAt = null;
  districtQueueSchemaUnavailable = false;
  const result = await finishRadarOlxJob({ jobId: "job-1", jobLeaseToken: "job-lease-1", workerId: "worker-1", ownerId, runId, radarLeaseToken }, {
    fetched: 1, listings: [{ ...candidate(), district: null } as never], warnings: [], durationMs: 1200,
  }, fakeDb() as never);
  assert.deepEqual(result, { source: "olx", status: "completed", fetched: 1, qualified: 0 }, "a queued candidate is not yet a qualified Radar listing");
  assert.equal(persisted.length, 0, "a district-only-missing candidate is never written straight to price_radar_listings");
  assert.equal(districtQueueUpserts.length, 1, "it must be upserted into the district-assignment queue instead");
  assert.equal((districtQueueUpserts[0].p_candidate as Row).source, "olx");
  assert.equal((districtQueueUpserts[0].p_candidate as Row).building_type, "blok");
  const savedCheckpoint = finalized[0].p_checkpoint as Row;
  assert.deepEqual(savedCheckpoint.qualificationRejections, {}, "a queued candidate must never also be counted as a dead-end rejection");
});

test("OLX finalizes the job but marks the Radar run partial and records the unapplied district queue schema", async () => {
  persisted = [];
  finalized = [];
  districtQueueUpserts = [];
  currentRunToken = radarLeaseToken;
  runStopRequestedAt = null;
  districtQueueSchemaUnavailable = true;
  const result = await finishRadarOlxJob({ jobId: "job-1", jobLeaseToken: "job-lease-1", workerId: "worker-1", ownerId, runId, radarLeaseToken }, {
    fetched: 1, listings: [{ ...candidate(), district: null } as never], warnings: [], durationMs: 1200,
  }, fakeDb() as never);

  assert.deepEqual(result, { source: "olx", status: "completed", fetched: 1, qualified: 0 }, "the normal OLX task finishes; the Radar run separately reports incomplete queue persistence");
  assert.equal(finalized[0].p_job_status, "completed");
  assert.equal((finalized[0].p_source_statuses as Row).olx, "partial");
  assert.equal(finalized[0].p_run_status, "partial");
  assert.equal((finalized[0].p_checkpoint as Row).sourceWarnings && ((finalized[0].p_checkpoint as Row).sourceWarnings as Row).olx instanceof Array, true);
  assert.match((((finalized[0].p_checkpoint as Row).sourceWarnings as Row).olx as string[]).join(" "), /RADAR_DISTRICT_QUEUE_UNAVAILABLE/u);
  assert.match(((finalized[0].p_result_summary as Row).warnings as string[]).join(" "), /RADAR_DISTRICT_QUEUE_UNAVAILABLE/u);
  assert.equal((finalized[0].p_result_summary as Row).rejected, 0, "a candidate awaiting district assignment is not mislabeled as a rejected offer when persistence is unavailable");
  assert.equal(districtQueueUpserts.length, 0, "an absent table never appears to accept an upsert");
  districtQueueSchemaUnavailable = false;
});

test("OLX worker maps the portal's structured market parameter before strict Radar qualification", async () => {
  persisted = [];
  finalized = [];
  currentRunToken = radarLeaseToken;
  runStopRequestedAt = null;
  const olxListing = {
    ...candidate(),
    description: "Sprzedaż mieszkania. Świeżo po generalnym remoncie w 2025, nowe instalacje, gotowe do zamieszkania.",
    rawPayload: { params: [{ key: "market", normalizedValue: "wtórny" }] },
  };
  const result = await finishRadarOlxJob({ jobId: "job-1", jobLeaseToken: "job-lease-1", workerId: "worker-1", ownerId, runId, radarLeaseToken }, {
    fetched: 1, listings: [olxListing as never], warnings: [], durationMs: 1200,
  }, fakeDb() as never);
  assert.deepEqual(result, { source: "olx", status: "completed", fetched: 1, qualified: 1 });
  assert.equal(persisted.length, 1, "a positive structured 'wtórny' value is mapped to secondary; all other strict checks still pass");
});

test("a stale Radar lease cannot persist or finalize an OLX worker result", async () => {
  persisted = [];
  finalized = [];
  currentRunToken = "new-owner-token";
  runStopRequestedAt = null;
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
  runStopRequestedAt = null;
  const result = await finishRadarOlxJob({ jobId: "job-1", jobLeaseToken: "job-lease-1", workerId: "worker-1", ownerId, runId, radarLeaseToken }, {
    errorCode: "HTTP_403", errorMessage: "Forbidden",
  }, fakeDb() as never);
  assert.deepEqual(result, { source: "olx", status: "failed", fetched: 0, qualified: 0 });
  assert.equal(persisted.length, 0);
  assert.equal(finalized[0].p_job_status, "failed");
  assert.equal((finalized[0].p_source_statuses as Record<string, unknown>).olx, "failed");
  assert.equal((finalized[0].p_checkpoint as typeof checkpoint).currentSourceIndex, 1);
});

test("an OLX worker acknowledges an operator stop before it qualifies or persists payload listings", async () => {
  persisted = [];
  finalized = [];
  districtQueueUpserts = [];
  currentRunToken = radarLeaseToken;
  runStopRequestedAt = new Date().toISOString();
  const result = await finishRadarOlxJob({ jobId: "job-1", jobLeaseToken: "job-lease-1", workerId: "worker-1", ownerId, runId, radarLeaseToken }, {
    fetched: 1, listings: [candidate() as never], warnings: [], durationMs: 1200,
  }, fakeDb() as never);
  assert.deepEqual(result, { source: "olx", status: "failed", fetched: 0, qualified: 0 });
  assert.equal(persisted.length, 0, "a stop request prevents any payload candidate from reaching Radar persistence");
  assert.equal(districtQueueUpserts.length, 0, "a stop request cannot enqueue district-review work");
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].p_run_status, "partial");
  assert.equal(finalized[0].p_error_message, "RADAR_STOPPED_BY_OPERATOR");
  assert.equal(finalized[0].p_job_status, "failed");
  assert.equal(finalized[0].p_error_code, "RADAR_STOPPED_BY_OPERATOR");
  assert.equal(finalized[0].p_run_id, runId, "the stopped worker finalizes only its existing run");
});
