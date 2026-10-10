import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { SourceBatchYield } from "@/features/flip-finder/source-batches";

type Row = Record<string, unknown>;
const ownerId = "owner-test";

function fakeDb(initial: { runs?: Row[]; listings?: Row[] } = {}) {
  const tables: Record<string, Row[]> = { price_radar_runs: initial.runs ?? [], price_radar_listings: initial.listings ?? [], olx_scan_jobs: [] };
  const rpcCalls: Array<{ name: string; args: Row }> = [];
  let seq = 0;
  return {
    tables,
    rpcCalls,
    async rpc(name: string, args: Row) {
      rpcCalls.push({ name, args: structuredClone(args) });
      if (name === "claim_price_radar_run") {
        const existing = tables.price_radar_runs.find((row) => row.owner_id === args.p_owner_id && ["pending", "running"].includes(String(row.status)));
        if (existing) return { data: null, error: null };
        const token = `lease-${++seq}`;
        const row = { id: `run-${seq}`, owner_id: args.p_owner_id, lease_token: token, lease_until: new Date(Date.now() + Number(args.p_lease_seconds) * 1000).toISOString(), started_at: new Date().toISOString(), finished_at: null, status: "running", scanned_count: 0, qualified_count: 0, error_message: null, source_statuses: {}, checkpoint: args.p_initial_checkpoint };
        tables.price_radar_runs.push(row);
        return { data: [{ ...row, run_id: row.id, lease_token: token }], error: null };
      }
      if (name === "checkpoint_price_radar_run") {
        const row = tables.price_radar_runs.find((entry) => entry.id === args.p_run_id && entry.owner_id === args.p_owner_id && entry.lease_token === args.p_lease_token && entry.status === "running");
        if (!row) return { data: false, error: null };
        Object.assign(row, { checkpoint: args.p_checkpoint, source_statuses: args.p_source_statuses, scanned_count: args.p_scanned_count, qualified_count: args.p_qualified_count, status: args.p_status, error_message: args.p_error_message, finished_at: ["completed", "partial", "failed"].includes(String(args.p_status)) ? new Date().toISOString() : null });
        if (row.finished_at) Object.assign(row, { lease_token: null, lease_until: null });
        else row.lease_until = new Date(Date.now() + Number(args.p_lease_seconds) * 1000).toISOString();
        return { data: true, error: null };
      }
      if (name === "persist_price_radar_listing") {
        const run = tables.price_radar_runs.find((entry) => entry.id === args.p_run_id && entry.owner_id === args.p_owner_id && entry.lease_token === args.p_lease_token && entry.status === "running");
        if (!run) return { data: null, error: { message: "RADAR_LEASE_LOST" } };
        const candidate = args.p_listing as Row;
        let row = tables.price_radar_listings.find((entry) => entry.owner_id === args.p_owner_id && entry.source === candidate.source && (entry.external_listing_id === candidate.external_listing_id || entry.normalized_url === candidate.normalized_url));
        if (!row) { row = { id: `listing-${++seq}`, owner_id: args.p_owner_id }; tables.price_radar_listings.push(row); }
        Object.assign(row, candidate, { excluded_at: row.excluded_at ?? null, excluded_reason: row.excluded_reason ?? null, status: "active", first_seen_at: row.first_seen_at ?? candidate.collected_at });
        return { data: row.id, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Array<(row: Row) => boolean> = [];
      let op: "select" | "insert" | "update" | "upsert" = "select";
      let payload: Row | null = null;
      let onConflict: string[] | null = null;
      const builder: Row = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return builder; },
        order: () => builder,
        range: async () => {
          const matched = rows.filter((row) => filters.every((filter) => filter(row)));
          return { data: matched, error: null };
        },
        abortSignal: () => builder,
        insert: (value: Row) => { op = "insert"; payload = value; return builder; },
        update: (value: Row) => { op = "update"; payload = value; return builder; },
        upsert: (value: Row, options?: { onConflict?: string }) => { op = "upsert"; payload = value; onConflict = options?.onConflict?.split(",") ?? null; return builder; },
        maybeSingle: async () => {
          if (op === "insert" && payload) {
            // Simulate the DB's partial unique index: reject a second concurrent pending/running row.
            if (payload.status && ["pending", "running"].includes(String(payload.status)) && rows.some((row) => ["pending", "running"].includes(String(row.status)))) {
              return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
            }
            const row = { id: `run-${++seq}`, started_at: new Date().toISOString(), finished_at: null, status: "running", scanned_count: 0, qualified_count: 0, error_message: null, ...payload };
            rows.push(row);
            return { data: row, error: null };
          }
          const matched = rows.find((row) => filters.every((filter) => filter(row))) ?? null;
          return { data: matched, error: null };
        },
        single: async () => {
          if (op === "insert" && payload) {
            if (table === "olx_scan_jobs" && rows.some((row) => row.idempotency_key === payload!.idempotency_key)) {
              return { data: null, error: { code: "23505", message: "duplicate idempotency key" } };
            }
            if (payload.status && ["pending", "running"].includes(String(payload.status)) && rows.some((row) => ["pending", "running"].includes(String(row.status)))) {
              return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
            const row = { id: `row-${++seq}`, created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, status: table === "olx_scan_jobs" ? "queued" : "running", scanned_count: 0, qualified_count: 0, error_message: null, ...payload };
            rows.push(row);
            return { data: row, error: null };
          }
          if (op === "upsert" && payload) {
            const key = onConflict ?? ["id"];
            const index = rows.findIndex((row) => key.every((column) => row[column] === payload![column]));
            const row = index >= 0 ? Object.assign(rows[index], payload) : (() => { const created = { id: `listing-${++seq}`, ...payload }; rows.push(created); return created; })();
            return { data: row, error: null };
          }
          if (op === "update" && payload) {
            const matched = rows.filter((row) => filters.every((filter) => filter(row)));
            for (const row of matched) Object.assign(row, payload);
            return { data: matched[0] ?? null, error: null };
          }
          return { data: rows.find((row) => filters.every((filter) => filter(row))) ?? null, error: null };
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
          const run = async () => {
            if (op === "update" && payload) {
              const matched = rows.filter((row) => filters.every((filter) => filter(row)));
              for (const row of matched) Object.assign(row, payload);
              return { data: matched, error: null };
            }
            return { data: rows.filter((row) => filters.every((filter) => filter(row))), error: null };
          };
          return run().then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { throw new Error("tests must pass an explicit fake db, never the real admin client"); } } });

type FakeBatch = { listings: unknown[]; warnings: string[]; fetched: number };
type FakeBatchContext = { cursor?: number; radarDetailCursor?: { kind: "radar_detail_v1"; page: number; candidateIndex: number }; onBatch(batch: FakeBatch, nextCursor: unknown): Promise<void> };
let fakeSourceImpl: (id: string, cursor?: number, batches?: FakeBatchContext, signal?: AbortSignal) => Promise<{ listings: unknown[]; warnings: string[]; fetched: number }>;
const mockedSources = [
  { id: "domiporta", label: "Domiporta", fetch: async (_criteria: unknown, signal?: AbortSignal, batches?: FakeBatchContext) => fakeSourceImpl("domiporta", batches?.cursor, batches, signal) },
  { id: "morizon", label: "Morizon", fetch: async (_criteria: unknown, signal?: AbortSignal, batches?: FakeBatchContext) => fakeSourceImpl("morizon", batches?.cursor, batches, signal) },
  { id: "olx", label: "OLX", fetch: async (_criteria: unknown, signal?: AbortSignal, batches?: FakeBatchContext) => fakeSourceImpl("olx", batches?.cursor, batches, signal) },
];
mock.module("@/features/flip-finder/server/search-source-registry", {
  namedExports: {
    SOURCES: mockedSources,
    slugifyCity: () => "lodz",
    activeSources: (filter: { sources: string[] }) => mockedSources.filter((source) => filter.sources.includes(source.id)),
  },
});

const { claimOrCreateRadarRun, runRadarCollectionPortion, RADAR_SOURCES } = await import("./collect.ts");

function qualifyingListing(id: string, source: string) {
  return {
    source, externalListingId: id, originalUrl: `https://example.test/${id}`, normalizedUrl: `https://example.test/${id}`,
    title: "Mieszkanie w bloku, Łódź Bałuty", description: "Świeżo po generalnym remoncie w 2025, nowe instalacje, gotowe do zamieszkania. Rynek wtórny.",
    price: 450_000, area: 50, pricePerSqm: 9_000, rooms: 2, city: "Łódź", district: "Bałuty",
    buildingType: null, floor: null, locationText: "Bałuty, Łódź", thumbnailUrl: null, images: [], publishedAt: null,
    rawPayload: source === "domiporta" ? { detailVerified: true } : {}, contentHash: `hash-${id}`,
  };
}

test("claimOrCreateRadarRun creates exactly one run and reports a concurrent attempt as already_active/blocked, never a second row", async () => {
  const db = fakeDb();
  const first = await claimOrCreateRadarRun(ownerId, [], db as never);
  assert.equal(first.kind, "claimed");
  if (first.kind === "claimed") {
    assert.deepEqual(first.run.checkpoint.sourceQueue, RADAR_SOURCES, "a new run's checkpoint seeds the full, real schema-ready source queue");
  }
  const second = await claimOrCreateRadarRun(ownerId, [], db as never);
  assert.equal(second.kind, "blocked");
  assert.equal(db.tables.price_radar_runs.length, 1);
});

test("claim and continuation checkpoints use the 75-second lease for a 42-second portion", async () => {
  const db = fakeDb();
  fakeSourceImpl = async () => ({ listings: [], warnings: [], fetched: 0 });
  const claim = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected claimed");
  const result = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);

  assert.equal(result.status, "completed");
  const leaseCalls = db.rpcCalls.filter(({ name }) => name === "claim_price_radar_run" || name === "checkpoint_price_radar_run");
  assert.ok(leaseCalls.length >= 2);
  assert.ok(leaseCalls.every(({ args }) => args.p_lease_seconds === 75), "every claim and checkpoint must retain the shorter lease window");
});

const MOCKED_SOURCE_COUNT = 2;

test("runRadarCollectionPortion processes every mocked source, persists qualified listings, and marks the run completed", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id) => ({ listings: [qualifyingListing(`${id}-1`, id), qualifyingListing(`${id}-2`, id)], warnings: [], fetched: 2 });
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta", "morizon"], db as never);
  assert.equal(claimed.kind, "claimed");
  if (claimed.kind !== "claimed") return;

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  assert.equal(result.status, "completed");
  assert.equal(result.scannedCount, MOCKED_SOURCE_COUNT * 2);
  // Every fetched candidate here qualifies, so qualifiedCount must match too.
  assert.equal(result.qualifiedCount, MOCKED_SOURCE_COUNT * 2);
  assert.equal(db.tables.price_radar_listings.length, MOCKED_SOURCE_COUNT * 2);
  assert.equal(db.tables.price_radar_runs[0].status, "completed");
  assert.ok(db.tables.price_radar_runs[0].finished_at);
});

test("a non-qualifying candidate is scanned but never persisted", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id) => ({
    listings: [{ ...qualifyingListing(`${id}-rent`, id), title: "Pokój do wynajęcia", description: "" }],
    warnings: [], fetched: 1,
  });
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta", "morizon"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");
  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  assert.equal(result.qualifiedCount, 0);
  assert.equal(db.tables.price_radar_listings.length, 0);
  assert.equal(result.scannedCount, MOCKED_SOURCE_COUNT);
  assert.deepEqual(result.qualificationRejections, { domiporta: { rental: 1 }, morizon: { rental: 1 } }, "each source records the exact first strict rejection reason without persisting rejected candidates");
  assert.deepEqual((db.tables.price_radar_runs[0].checkpoint as Row).qualificationRejections, result.qualificationRejections, "reason counts survive in the existing durable JSON checkpoint");
});

test("one source's fetch failure is terminal and visible -- other sources still save and the run ends partial", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id) => {
    if (id === "domiporta") throw new Error("network error");
    return { listings: [qualifyingListing(`${id}-ok`, id)], warnings: [], fetched: 1 };
  };
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta", "morizon"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");
  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  assert.equal(result.status, "partial");
  assert.equal(result.sourceStatuses.domiporta, "failed");
  assert.equal(db.tables.price_radar_listings.length, MOCKED_SOURCE_COUNT - 1);
});

test("a source that times out mid-portion is marked pending with an honest message (no claimed daily wait) and resumes on the very next portion call", async () => {
  // The real Production run (93a7f1d5...) showed official_cooperative as
  // "RADAR_PORTION_WAITING_FOR_NEXT_DAILY_WINDOW", then later concluded with
  // a real terminal result within the same operator session -- proving
  // nothing in this code actually enforces a calendar-day wait. The label
  // was simply wrong; this is what it can honestly promise.
  const db = fakeDb();
  let domiportaAttempts = 0;
  fakeSourceImpl = async (id) => {
    if (id === "domiporta") {
      domiportaAttempts += 1;
      if (domiportaAttempts === 1) { const error = new Error("simulated portion timeout"); error.name = "AbortError"; throw error; }
      return { listings: [qualifyingListing("domiporta-resumed", "domiporta")], warnings: [], fetched: 1 };
    }
    return { listings: [qualifyingListing(`${id}-1`, id)], warnings: [], fetched: 1 };
  };
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta", "morizon"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");
  const first = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  assert.equal(first.sourceStatuses.domiporta, "pending");
  assert.equal(first.sourceStatuses.morizon, "completed", "the timed-out source must move behind the other source in the same run");
  assert.equal(first.status, "running", "the same run remains resumable while Domiporta is pending");
  const firstStoredRun = db.tables.price_radar_runs[0] as Row;
  const firstCheckpoint = firstStoredRun.checkpoint as { sourceQueue: string[] };
  assert.deepEqual(firstCheckpoint.sourceQueue, ["morizon", "domiporta"]);
  assert.doesNotMatch(first.sourceErrors.domiporta ?? "", /NEXT_DAILY_WINDOW/, "must not reintroduce the old label claiming a specific daily wait that no code enforces");
  assert.match(first.sourceErrors.domiporta ?? "", /najbliższym uruchomieniu/);

  const second = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  assert.equal(domiportaAttempts, 2, "the very next portion call, not a day later, must retry the same pending source");
  assert.equal(claimed.run.id, db.tables.price_radar_runs[0]?.id, "continuation must retain the original run ID");
  assert.equal(((db.tables.price_radar_runs[0] as Row).source_statuses as Record<string, unknown>).morizon, "completed", "a completed source is not repeated during resume");
  assert.equal(second.status, "completed");
  assert.equal(second.sourceStatuses.domiporta, "completed");
});

test("a detail-batch yield checkpoints its cursor and lets later sources progress before retrying that source", async () => {
  const db = fakeDb();
  let domiportaCalls = 0;
  let morizonCalls = 0;
  let resumedCursor: FakeBatchContext["radarDetailCursor"] = undefined;
  fakeSourceImpl = async (id, _cursor, batches) => {
    if (id === "domiporta") {
      domiportaCalls += 1;
      if (domiportaCalls === 1) {
        await batches!.onBatch({ listings: [qualifyingListing("domiporta-page-1", id)], warnings: [], fetched: 1 }, { kind: "radar_detail_v1", page: 2, candidateIndex: 12 });
        throw new SourceBatchYield("detail_batch_limit");
      }
      resumedCursor = batches?.radarDetailCursor;
      return { listings: [qualifyingListing("domiporta-resumed", id)], warnings: [], fetched: 1 };
    }
    morizonCalls += 1;
    return { listings: [qualifyingListing("morizon-once", id)], warnings: [], fetched: 1 };
  };
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta", "morizon"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");

  const first = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  assert.equal(first.status, "running");
  assert.equal(first.sourceStatuses.domiporta, "pending");
  assert.equal(first.sourceStatuses.morizon, "completed", "a source that yielded a normal detail batch cannot hold later sources behind it");
  const firstStoredRun = db.tables.price_radar_runs[0] as Row;
  const firstCheckpoint = firstStoredRun.checkpoint as { perSourceCursor: Record<string, unknown>; sourceQueue: string[] };
  assert.deepEqual(firstCheckpoint.perSourceCursor.domiporta, { kind: "radar_detail_v1", page: 2, candidateIndex: 12 });
  assert.deepEqual(firstCheckpoint.sourceQueue, ["morizon", "domiporta"]);

  const resumed = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  assert.deepEqual(resumedCursor, { kind: "radar_detail_v1", page: 2, candidateIndex: 12 }, "the original detail cursor is preserved across the source rotation");
  assert.equal(morizonCalls, 1, "the completed later source is not fetched again");
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.sourceStatuses.domiporta, "completed");
  assert.equal(db.tables.price_radar_runs[0]?.id, claimed.run.id);
});

test("a resumed run at the end of its source queue processes both pending sources once and preserves its detail cursor", async () => {
  const sourceQueue = ["morizon", "domiporta"];
  const detailCursor = { kind: "radar_detail_v1" as const, page: 4, candidateIndex: 12 };
  const checkpoint = {
    sourceQueue,
    currentSourceIndex: sourceQueue.length,
    sourceStatuses: { morizon: "pending", domiporta: "pending" },
    sourceErrors: {},
    perSourceCursor: { morizon: 3, domiporta: detailCursor },
    qualificationRejections: {},
    buffer: [],
    bufferOffset: 0,
  };
  const runId = "run-resume-at-end-with-two-pending";
  const db = fakeDb({ runs: [{
    id: runId,
    owner_id: ownerId,
    status: "running",
    lease_token: "current-resume-lease",
    lease_until: new Date(Date.now() + 60_000).toISOString(),
    started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    checkpoint,
    source_statuses: checkpoint.sourceStatuses,
    source_errors: checkpoint.sourceErrors,
    scanned_count: 17,
    qualified_count: 0,
  }] });
  const attempts: Record<string, number> = {};
  let resumedDomiportaCursor: FakeBatchContext["radarDetailCursor"];
  fakeSourceImpl = async (id, cursor, batches) => {
    attempts[id] = (attempts[id] ?? 0) + 1;
    if (id === "morizon") assert.equal(cursor, 3, "resume keeps Morizon's page cursor");
    if (id === "domiporta") resumedDomiportaCursor = batches?.radarDetailCursor;
    return { listings: [qualifyingListing(`${id}-resumed`, id)], warnings: [], fetched: 1 };
  };

  const result = await runRadarCollectionPortion({ runId, ownerId, leaseToken: "current-resume-lease" }, db as never);

  assert.equal(result.status, "completed");
  assert.equal(result.sourceStatuses.morizon, "completed");
  assert.equal(result.sourceStatuses.domiporta, "completed");
  assert.deepEqual(attempts, { morizon: 1, domiporta: 1 }, "both pending sources resume once; neither source is repeated");
  assert.deepEqual(resumedDomiportaCursor, detailCursor, "Domiporta resumes from its saved detail candidate, not from the start");
  assert.equal(db.tables.price_radar_runs.length, 1, "continuation preserves the existing run instead of creating another");
  assert.equal(db.tables.price_radar_runs[0]?.id, runId);
  assert.equal(result.scannedCount, 19, "the existing total is incremented by exactly one fetched candidate per resumed source");
});

test("a resumed Domiporta detail cursor clears only its stale portion-timeout diagnostic after successful completion", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id) => ({ listings: [qualifyingListing(`${id}-resumed`, id)], warnings: [], fetched: 1 });
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");
  const row = db.tables.price_radar_runs[0]!;
  const checkpoint = row.checkpoint as Record<string, unknown>;
  row.checkpoint = {
    ...checkpoint,
    perSourceCursor: { domiporta: { kind: "radar_detail_v1", page: 2, candidateIndex: 12 } },
    sourceStatuses: { domiporta: "pending" },
    sourceErrors: { domiporta: "RADAR_PORTION_TIME_BUDGET_EXCEEDED: retry at next portion" },
  };

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  assert.equal(result.status, "completed", "a successful retry of a detailed cursor must not inherit the prior transient timeout as a terminal error");
  assert.equal(result.sourceStatuses.domiporta, "completed");
  assert.equal(result.sourceErrors.domiporta, undefined);
});

test("re-collecting the same listing preserves a prior exclusion -- persistRadarListing's upsert never writes excluded_at/excluded_reason", async () => {
  const db = fakeDb({
    listings: [{ id: "existing-1", owner_id: ownerId, source: "domiporta", external_listing_id: "domiporta-1", normalized_url: "https://example.test/domiporta-1", excluded_at: "2026-10-01T00:00:00Z", excluded_reason: "poza budżetem" }],
  });
  fakeSourceImpl = async (id) => (id === "domiporta" ? { listings: [qualifyingListing("domiporta-1", "domiporta")], warnings: [], fetched: 1 } : { listings: [], warnings: [], fetched: 0 });
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");
  await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  const row = db.tables.price_radar_listings.find((listing) => listing.id === "existing-1");
  assert.ok(row);
  assert.equal(row.excluded_at, "2026-10-01T00:00:00Z", "a re-collection must never clear a prior exclusion");
  assert.equal(row.excluded_reason, "poza budżetem");
});

test("resuming after the OLX worker exhausted its lease (claim_olx_scan_job's own LEASE_EXHAUSTED path, not Radar's finalize RPC) marks olx failed and lets the rest of the queue finish -- a run is never stuck forever behind a dead OLX job", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id) => (id === "olx" ? { listings: [], warnings: [], fetched: 0 } : { listings: [qualifyingListing(`${id}-1`, id)], warnings: [], fetched: 1 });
  const claimed = await claimOrCreateRadarRun(ownerId, [], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");
  // Reproduces the real Production state: a prior portion queued this run's
  // OLX job, the local worker never finished it, and claim_olx_scan_job's own
  // generic lease-exhaustion fallback (not Radar's finalize_price_radar_olx_job
  // RPC) marked the job "failed" directly -- so the run's own checkpoint was
  // never told. enqueueRadarOlxJob must surface this as RADAR_OLX_JOB_ALREADY_FAILED
  // on the next attempt rather than silently re-queuing or hanging.
  db.tables.olx_scan_jobs.push({ id: "job-1", idempotency_key: `price-radar:${ownerId}:olx:${claimed.run.id}`, status: "failed", error_code: "LEASE_EXHAUSTED" });

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  assert.equal(result.sourceStatuses.olx, "failed", "a dead OLX job must be recognized as failed, not left at 'running' forever");
  assert.match(result.sourceErrors.olx ?? "", /RADAR_OLX_JOB_ALREADY_FAILED/);
  assert.equal(result.sourceStatuses.domiporta, "completed", "sources after olx in the queue must still run");
  assert.equal(result.sourceStatuses.morizon, "completed");
  assert.equal(result.status, "partial", "one dead source among otherwise-successful ones ends the run partial, not stuck in 'running'");
  assert.notEqual(db.tables.price_radar_runs[0].status, "running", "the run must reach a terminal status instead of waiting on OLX forever");
});
