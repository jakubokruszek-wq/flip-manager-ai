import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { SourceBatchYield } from "@/features/flip-finder/source-batches";
import type { RadarDetailDiagnostic } from "@/features/flip-finder/source-batches";

type Row = Record<string, unknown>;
const ownerId = "owner-test";

function fakeDb(initial: { runs?: Row[]; listings?: Row[]; olxJobs?: Row[]; districtQueue?: Row[]; verificationQueue?: Row[]; districtQueueRpcError?: { code: string; message: string }; verificationQueueRpcError?: { code: string; message: string }; onListingPersisted?: (run: Row, candidate: Row) => void } = {}) {
  const tables: Record<string, Row[]> = { price_radar_runs: initial.runs ?? [], price_radar_listings: initial.listings ?? [], olx_scan_jobs: initial.olxJobs ?? [], price_radar_district_queue: initial.districtQueue ?? [], price_radar_verification_queue: initial.verificationQueue ?? [] };
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
        if (row.stop_requested_at && !(args.p_status === "partial" && args.p_error_message === "RADAR_STOPPED_BY_OPERATOR")) return { data: false, error: null };
        Object.assign(row, { checkpoint: args.p_checkpoint, source_statuses: args.p_source_statuses, scanned_count: args.p_scanned_count, qualified_count: args.p_qualified_count, status: args.p_status, error_message: args.p_error_message, finished_at: ["completed", "partial", "failed"].includes(String(args.p_status)) ? new Date().toISOString() : null });
        if (row.finished_at) Object.assign(row, { lease_token: null, lease_until: null });
        else row.lease_until = new Date(Date.now() + Number(args.p_lease_seconds) * 1000).toISOString();
        return { data: true, error: null };
      }
      if (name === "persist_price_radar_listing") {
        const run = tables.price_radar_runs.find((entry) => entry.id === args.p_run_id && entry.owner_id === args.p_owner_id && entry.lease_token === args.p_lease_token && entry.status === "running");
        if (!run || run.stop_requested_at || run.user_terminated_at) return { data: null, error: { message: "RADAR_LEASE_LOST" } };
        const candidate = args.p_listing as Row;
        let row = tables.price_radar_listings.find((entry) => entry.owner_id === args.p_owner_id && entry.source === candidate.source && (entry.external_listing_id === candidate.external_listing_id || entry.normalized_url === candidate.normalized_url));
        if (!row) { row = { id: `listing-${++seq}`, owner_id: args.p_owner_id }; tables.price_radar_listings.push(row); }
        Object.assign(row, candidate, { excluded_at: row.excluded_at ?? null, excluded_reason: row.excluded_reason ?? null, status: "active", first_seen_at: row.first_seen_at ?? candidate.collected_at });
        initial.onListingPersisted?.(run, candidate);
        return { data: row.id, error: null };
      }
      if (name === "upsert_price_radar_district_queue_candidate") {
        if (initial.districtQueueRpcError) return { data: null, error: initial.districtQueueRpcError };
        const candidate = args.p_candidate as Row;
        let row = tables.price_radar_district_queue.find((entry) => entry.owner_id === args.p_owner_id && entry.source === candidate.source && entry.external_listing_id === candidate.external_listing_id);
        if (!row) { row = { id: `queue-${++seq}`, owner_id: args.p_owner_id, status: "pending", assigned_district: null }; tables.price_radar_district_queue.push(row); }
        Object.assign(row, candidate);
        return { data: row.id, error: null };
      }
      if (name === "upsert_price_radar_verification_candidate") {
        if (initial.verificationQueueRpcError) return { data: null, error: initial.verificationQueueRpcError };
        const candidate = args.p_candidate as Row;
        let row = tables.price_radar_verification_queue.find((entry) => entry.owner_id === args.p_owner_id && entry.source === candidate.source && (entry.external_listing_id === candidate.external_listing_id || entry.normalized_url === candidate.normalized_url));
        if (!row) {
          row = { id: `verification-${++seq}`, owner_id: args.p_owner_id, status: "pending", operator_decision: null, radar_listing_id: null };
          tables.price_radar_verification_queue.push(row);
        }
        Object.assign(row, candidate, { owner_id: args.p_owner_id, status: row.status, operator_decision: row.operator_decision, radar_listing_id: row.radar_listing_id });
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
        is: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        lte: (key: string, value: string) => { filters.push((row) => typeof row[key] === "string" && Date.parse(String(row[key])) <= Date.parse(value)); return builder; },
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
          if (op === "update" && payload) {
            const matched = rows.find((row) => filters.every((filter) => filter(row))) ?? null;
            if (matched) Object.assign(matched, payload);
            return { data: matched, error: null };
          }
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
mock.module("@/features/price-radar/server/radar-district-ai", {
  namedExports: {
    createRadarDistrictAiBudget: () => ({ tryConsume: () => true }),
    suggestRadarDistrictWithAi: async () => null,
  },
});

type FakeBatch = { listings: unknown[]; warnings: string[]; fetched: number; diagnostics?: RadarDetailDiagnostic[]; rejectionReasons?: string[]; sourceRejectionCounts?: Record<string, number> };
type FakeBatchContext = { cursor?: number; radarDetailCursor?: { kind: "radar_detail_v1"; page: number; candidateIndex: number }; ofertyNetLegacySearch?: boolean; onBatch(batch: FakeBatch, nextCursor: unknown): Promise<void> };
let fakeSourceImpl: (id: string, cursor?: number, batches?: FakeBatchContext, signal?: AbortSignal) => Promise<{ listings: unknown[]; warnings: string[]; fetched: number }>;
let observedSearchCriteria: unknown = null;
const mockedSources = [
  { id: "domiporta", label: "Domiporta", fetch: async (criteria: unknown, signal?: AbortSignal, batches?: FakeBatchContext) => { observedSearchCriteria = criteria; return fakeSourceImpl("domiporta", batches?.cursor, batches, signal); } },
  { id: "morizon", label: "Morizon", fetch: async (criteria: unknown, signal?: AbortSignal, batches?: FakeBatchContext) => { observedSearchCriteria = criteria; return fakeSourceImpl("morizon", batches?.cursor, batches, signal); } },
  { id: "olx", label: "OLX", fetch: async (criteria: unknown, signal?: AbortSignal, batches?: FakeBatchContext) => { observedSearchCriteria = criteria; return fakeSourceImpl("olx", batches?.cursor, batches, signal); } },
  { id: "oferty_net", label: "Oferty.net", fetch: async (criteria: unknown, signal?: AbortSignal, batches?: FakeBatchContext) => { observedSearchCriteria = criteria; return fakeSourceImpl("oferty_net", batches?.cursor, batches, signal); } },
  { id: "adresowo", label: "Adresowo.pl", fetch: async (criteria: unknown, signal?: AbortSignal, batches?: FakeBatchContext) => { observedSearchCriteria = criteria; return fakeSourceImpl("adresowo", batches?.cursor, batches, signal); } },
  { id: "allegro_lokalnie", label: "Allegro Lokalnie", fetch: async (criteria: unknown, signal?: AbortSignal, batches?: FakeBatchContext) => { observedSearchCriteria = criteria; return fakeSourceImpl("allegro_lokalnie", batches?.cursor, batches, signal); } },
];
mock.module("@/features/flip-finder/server/search-source-registry", {
  namedExports: {
    SOURCES: mockedSources,
    slugifyCity: () => "lodz",
    activeSources: (filter: { sources: string[] }) => mockedSources.filter((source) => filter.sources.includes(source.id)),
  },
});

const { claimOrCreateRadarRun, releaseRadarRunLease, resumeExistingRadarRun, runRadarCollectionPortion, RADAR_SOURCES, RADAR_SOURCE_TIMEOUT_LIMIT } = await import("./collect.ts");
const { getRadarResults } = await import("./radar-results.ts");

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
  const savedCheckpoint = db.tables.price_radar_runs[0]?.checkpoint as Row;
  assert.ok(typeof savedCheckpoint.lastProgressAt === "string" && Number.isFinite(Date.parse(savedCheckpoint.lastProgressAt)), "each durable checkpoint stores a progress timestamp without a schema migration");
  const leaseCalls = db.rpcCalls.filter(({ name }) => name === "claim_price_radar_run" || name === "checkpoint_price_radar_run");
  assert.ok(leaseCalls.length >= 2);
  assert.ok(leaseCalls.every(({ args }) => args.p_lease_seconds === 75), "every claim and checkpoint must retain the shorter lease window");
});

test("terminal CAPTCHA and HTTP 429 failures are recorded once while pending portals keep advancing", async () => {
  const db = fakeDb();
  const attempts: Record<string, number> = {};
  fakeSourceImpl = async (id) => {
    attempts[id] = (attempts[id] ?? 0) + 1;
    if (id === "adresowo") throw new Error("HTTP 403 CAPTCHA_OR_ACCESS_DENIED");
    if (id === "allegro_lokalnie") throw new Error("HTTP 429 Too Many Requests");
    return { listings: [qualifyingListing(`${id}-long-run`, id)], warnings: [], fetched: 1 };
  };
  const claim = await claimOrCreateRadarRun(ownerId, ["adresowo", "allegro_lokalnie", "domiporta", "oferty_net"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  assert.equal(result.status, "partial");
  assert.equal(result.sourceStatuses.adresowo, "failed");
  assert.equal(result.sourceStatuses.allegro_lokalnie, "failed");
  assert.equal(result.sourceStatuses.domiporta, "completed", "a terminal access failure cannot hold later sources");
  assert.equal(result.sourceStatuses.oferty_net, "completed", "the last pending portal still advances in the same run");
  assert.match(result.sourceErrors.adresowo ?? "", /TERMINAL_ACCESS_ERROR/u);
  assert.match(result.sourceErrors.allegro_lokalnie ?? "", /429/u);
  assert.deepEqual(attempts, { adresowo: 1, allegro_lokalnie: 1, domiporta: 1, oferty_net: 1 });

  const repeated = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  assert.equal(repeated.status, "partial");
  assert.deepEqual(attempts, { adresowo: 1, allegro_lokalnie: 1, domiporta: 1, oferty_net: 1 }, "terminal failures and completed portals are never retried inside the same run");
});

test("a pending OLX reservation is deferred behind unfinished portals, then uses only its existing worker queue", async () => {
  let nonOlxPersisted = false;
  const db = fakeDb({ onListingPersisted: (_run, candidate) => {
    if (candidate.source !== "olx") {
      nonOlxPersisted = true;
      assert.equal(db.tables.olx_scan_jobs.length, 0, "OLX is not queued before another portal has had a collection turn");
    }
  } });
  fakeSourceImpl = async (id) => ({ listings: [qualifyingListing(`${id}-before-olx`, id)], warnings: [], fetched: 1 });
  const claimed = await claimOrCreateRadarRun(ownerId, ["olx", "domiporta"], db as never);
  if (claimed.kind !== "claimed" || !claimed.run.leaseToken) throw new Error("expected claimed run");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken }, db as never);
  const saved = db.tables.price_radar_runs[0]!;
  const checkpoint = saved.checkpoint as { sourceQueue: string[]; sourceStatuses: Record<string, string> };
  assert.equal(nonOlxPersisted, true);
  assert.deepEqual(checkpoint.sourceQueue, ["domiporta", "olx"], "legacy source order is rotated in-place while keeping the same run");
  assert.equal(result.sourceStatuses.domiporta, "completed");
  assert.equal(result.sourceStatuses.olx, "running", "an unavailable worker remains visibly pending/running instead of claiming completion");
  assert.equal(db.tables.olx_scan_jobs.length, 1, "OLX still gets exactly one idempotent reservation in its existing queue");
  assert.equal(result.status, "running");
});

test("a persisted STOP request prevents the next source fetch and releases the same run as resumable partial", async () => {
  const db = fakeDb();
  let fetchCalls = 0;
  fakeSourceImpl = async () => { fetchCalls += 1; return { listings: [qualifyingListing("must-not-fetch", "domiporta")], warnings: [], fetched: 1 }; };
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claimed.kind !== "claimed" || !claimed.run.leaseToken) throw new Error("expected claimed run");
  const savedRun = db.tables.price_radar_runs[0]!;
  savedRun.stop_requested_at = new Date().toISOString();

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken }, db as never);
  assert.equal(fetchCalls, 0, "a stop persisted before a new source starts prevents any portal request");
  assert.equal(result.status, "partial");
  assert.equal(result.sourceStatuses.domiporta, "pending");
  assert.equal(savedRun.id, claimed.run.id, "STOP preserves the existing run rather than allocating a new one");
  assert.equal(savedRun.status, "partial");
  assert.equal(savedRun.error_message, "RADAR_STOPPED_BY_OPERATOR");
  assert.equal(savedRun.lease_token, null, "acknowledgment releases the lease instead of leaving an orphaned lock");
  assert.deepEqual((savedRun.checkpoint as { sourceQueue: string[] }).sourceQueue, ["domiporta"]);
});

test("a user termination during a batch aborts remaining candidate work and returns the durable terminal checkpoint without saving a late checkpoint", async () => {
  let sourceFetches = 0;
  let savedRun: Row | undefined;
  const db = fakeDb({ onListingPersisted: (run) => {
    savedRun = run;
    run.user_terminated_at = new Date().toISOString();
    run.status = "partial";
    run.finished_at = run.user_terminated_at;
    run.lease_token = null;
    run.lease_until = null;
    const checkpoint = run.checkpoint as Row;
    checkpoint.sourceStatuses = { domiporta: "pending", morizon: "pending" };
    run.source_statuses = checkpoint.sourceStatuses;
  } });
  fakeSourceImpl = async (_id, _cursor, batches) => {
    sourceFetches += 1;
    await batches?.onBatch({ listings: [qualifyingListing("saved-before-end", "domiporta"), qualifyingListing("must-not-save-after-end", "domiporta")], warnings: [], fetched: 2 }, null);
    return { listings: [], warnings: [], fetched: 0 };
  };
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta", "morizon"], db as never);
  if (claimed.kind !== "claimed" || !claimed.run.leaseToken) throw new Error("expected claimed run");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken }, db as never);
  assert.equal(sourceFetches, 1, "the source is never fetched a second time after the DB marker is observed");
  assert.equal(db.rpcCalls.filter(({ name }) => name === "persist_price_radar_listing").length, 1, "the in-flight batch stops before persisting its next listing");
  assert.equal(db.rpcCalls.filter(({ name }) => name === "checkpoint_price_radar_run").at(-1)?.args.p_status, "running", "the stale worker does not issue a terminal or running checkpoint after losing the lease");
  assert.equal(result.status, "partial");
  assert.equal(result.sourceStatuses.domiporta, "pending", "the interrupted source remains unfinished");
  assert.equal(result.sourceStatuses.morizon, "pending", "later work remains pending");
  assert.equal(savedRun?.user_terminated_at !== undefined, true);
  assert.equal(savedRun?.status, "partial", "the user-end marker remains the authority after the source portion returns");
  assert.equal(db.tables.price_radar_listings.length, 1, "the already persisted result survives termination");
});

test("a STOP racing with persistence does not advance a partial page cursor or double-count it on replay", async () => {
  let stopAfterFirstPersist = true;
  const db = fakeDb({ onListingPersisted: (run) => {
    if (stopAfterFirstPersist) {
      stopAfterFirstPersist = false;
      run.stop_requested_at = new Date().toISOString();
    }
  } });
  fakeSourceImpl = async (_id, _cursor, batches) => {
    await batches?.onBatch({ listings: [qualifyingListing("stop-page-1", "domiporta"), qualifyingListing("stop-page-2", "domiporta")], warnings: [], fetched: 2 }, { kind: "radar_detail_v1", page: 2, candidateIndex: 0 });
    return { listings: [], warnings: [], fetched: 0 };
  };
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claimed.kind !== "claimed" || !claimed.run.leaseToken) throw new Error("expected claimed run");
  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken }, db as never);
  const run = db.tables.price_radar_runs[0]!;
  const savedCheckpoint = run.checkpoint as { perSourceCursor: Record<string, unknown>; sourceStatuses: Record<string, string> };
  assert.equal(result.status, "partial");
  assert.equal(result.sourceStatuses.domiporta, "pending");
  assert.equal(db.tables.price_radar_listings.length, 1, "a listing persisted before STOP remains intact and is not deleted");
  assert.deepEqual(savedCheckpoint.perSourceCursor, {}, "a partially processed page is not committed past its prior cursor");
  assert.equal(run.scanned_count, 0, "an interrupted batch is replayed without inflating scanned counters");
  assert.equal(run.qualified_count, 0, "qualified count commits only after the batch is fully processed");
});

test("new Radar runs snapshot selected area and room bounds and reuse them for source fetches", async () => {
  const db = fakeDb();
  observedSearchCriteria = null;
  fakeSourceImpl = async () => ({ listings: [], warnings: [], fetched: 0 });
  const claim = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never, { areaMin: 31, areaMax: 62, rooms: [1, 2, 3], minPricePerSqm: 8_800, qualityRulesVersion: 2 });
  if (claim.kind !== "claimed") throw new Error("expected claimed");
  assert.deepEqual(claim.run.checkpoint.searchCriteria, { areaMin: 31, areaMax: 62, rooms: [1, 2, 3], minPricePerSqm: 8_800, qualityRulesVersion: 2 });
  await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  const criteria = observedSearchCriteria as { city?: string; areaMin?: number | null; areaMax?: number | null; rooms?: number[] } | null;
  assert.equal(criteria?.city, "\u0141\u00f3d\u017a");
  assert.equal(criteria?.areaMin, 31);
  assert.equal(criteria?.areaMax, 62);
  assert.deepEqual(criteria?.rooms, [1, 2, 3], "continuation uses the run snapshot instead of mutable settings");
});

test("a legacy checkpoint with no qualification version keeps strict v1 rules when resumed", async () => {
  const db = fakeDb();
  const bCandidate = qualifyingListing("ready-b", "domiporta");
  bCandidate.description = "Mieszkanie w pełni wykończone, gotowe do zamieszkania, wysoki standard. Rynek wtórny.";
  fakeSourceImpl = async (_id, _cursor, batches) => {
    await batches?.onBatch({ listings: [bCandidate], warnings: [], fetched: 1 }, null);
    return { listings: [], warnings: [], fetched: 0 };
  };
  const claim = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never, { areaMin: 31, areaMax: 62, rooms: [1, 2, 3] });
  if (claim.kind !== "claimed" || !claim.run.leaseToken) throw new Error("expected claimed legacy-style run");
  const portion = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken }, db as never);
  assert.equal(portion.qualifiedCount, 0, "a pre-v2 active run is not silently broadened to category B");
  assert.deepEqual(portion.qualificationRejections, {}, "uncertain finish is held for operator review instead of being discarded");
  assert.equal(db.tables.price_radar_verification_queue.length, 1, "legacy qualification rules remain strict while the candidate can still be reviewed separately");
  assert.equal(db.tables.price_radar_listings.length, 0);
});

test("a v2 checkpoint accepts a fully ready high-standard secondary listing without requiring a fresh renovation year", async () => {
  const db = fakeDb();
  const bCandidate = qualifyingListing("ready-b-v2", "domiporta");
  bCandidate.description = "Mieszkanie w pełni wykończone, gotowe do zamieszkania, wysoki standard. Rynek wtórny.";
  fakeSourceImpl = async (_id, _cursor, batches) => {
    await batches?.onBatch({ listings: [bCandidate], warnings: [], fetched: 1 }, null);
    return { listings: [], warnings: [], fetched: 0 };
  };
  const claim = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never, { areaMin: 31, areaMax: 62, rooms: [1, 2, 3], qualityRulesVersion: 2, minPricePerSqm: null });
  if (claim.kind !== "claimed" || !claim.run.leaseToken) throw new Error("expected v2 run");
  const portion = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken }, db as never);
  assert.equal(portion.qualifiedCount, 1);
  assert.equal(db.tables.price_radar_listings[0]?.renovation_status, "turnkey_finish");
});

test("only a pre-form Oferty.net checkpoint replays its saved page with the legacy search", async () => {
  const legacyDb = fakeDb();
  const observed: Array<{ page: number | undefined; legacy: boolean | undefined }> = [];
  fakeSourceImpl = async (id, page, batches) => {
    if (id === "oferty_net") observed.push({ page, legacy: batches?.ofertyNetLegacySearch });
    return { listings: [], warnings: [], fetched: 0 };
  };
  const legacy = await claimOrCreateRadarRun(ownerId, ["oferty_net"], legacyDb as never);
  if (legacy.kind !== "claimed") throw new Error("expected legacy claim");
  (legacyDb.tables.price_radar_runs[0]!.checkpoint as Row).perSourceCursor = { oferty_net: 2 };
  await runRadarCollectionPortion({ runId: legacy.run.id, ownerId, leaseToken: legacy.run.leaseToken! }, legacyDb as never);
  const currentDb = fakeDb();
  const current = await claimOrCreateRadarRun(ownerId, ["oferty_net"], currentDb as never, { areaMin: 31, areaMax: 62, rooms: [1, 2, 3] });
  if (current.kind !== "claimed") throw new Error("expected current claim");
  await runRadarCollectionPortion({ runId: current.run.id, ownerId, leaseToken: current.run.leaseToken! }, currentDb as never);
  assert.deepEqual(observed, [{ page: 2, legacy: true }, { page: undefined, legacy: undefined }]);
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
  assert.equal((db.tables.price_radar_runs[0].checkpoint as Row).rejectedCount, 0);
  assert.equal((db.tables.price_radar_runs[0].checkpoint as Row).verificationQueuedCount, 0);
  assert.equal((db.tables.price_radar_runs[0].checkpoint as Row).districtQueuedCount, 0);
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
  assert.equal((db.tables.price_radar_runs[0].checkpoint as Row).rejectedCount, MOCKED_SOURCE_COUNT, "the exact rejected-candidate total is saved alongside reason details");
});

test("preflight exclusions are checkpointed with their concrete reason and never trigger persistence", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id, _cursor, batches) => {
    if (id === "domiporta" && batches) {
      await batches.onBatch({ listings: [], warnings: [], fetched: 1, rejectionReasons: ["house_excluded"] }, null);
    }
    return { listings: [], warnings: [], fetched: 0 };
  };
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);

  assert.equal(result.scannedCount, 1, "the candidate rejected before detail is still included in the scanned count");
  assert.equal(result.qualifiedCount, 0);
  assert.deepEqual(result.qualificationRejections, { domiporta: { house_excluded: 1 } });
  assert.equal((db.tables.price_radar_runs[0].checkpoint as Row).rejectedCount, 1);
  assert.equal(db.tables.price_radar_listings.length, 0, "an explicitly ineligible candidate is never persisted");
  assert.equal(db.rpcCalls.some(({ name }) => name === "persist_price_radar_listing"), false, "the persistence RPC is not called for a preflight rejection");
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

test("public search page cap keeps saved offers and finishes the source/run as partial without retrying", async () => {
  const db = fakeDb();
  let fetchCount = 0;
  fakeSourceImpl = async (id) => {
    fetchCount += 1;
    const listing = qualifyingListing(`${id}-saved-before-cap`, id);
    listing.rawPayload.detailVerified = true;
    return {
      listings: [listing],
      warnings: [`${id}: PUBLIC_SEARCH_PAGE_LIMIT_REACHED (5 pages); later pages were not requested.`],
      fetched: 1,
    };
  };
  const claimed = await claimOrCreateRadarRun(ownerId, ["oferty_net"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);

  assert.equal(result.status, "partial");
  assert.equal(result.sourceStatuses.oferty_net, "partial");
  assert.equal(result.sourceErrors.oferty_net, undefined, "a deliberate page cap is coverage information, not a source failure");
  assert.ok(result.sourceWarnings?.oferty_net?.some((warning) => warning.includes("PUBLIC_SEARCH_PAGE_LIMIT_REACHED")));
  assert.equal(result.scannedCount, 1);
  assert.equal(result.qualifiedCount, 1);
  assert.equal(db.tables.price_radar_listings.length, 1, "already parsed and qualified rows remain persisted");
  assert.equal(db.tables.price_radar_runs[0]?.status, "partial");
  assert.equal(db.tables.price_radar_runs[0]?.lease_token, null, "partial is terminal and releases the lease");

  const repeated = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  assert.equal(repeated.status, "partial");
  assert.equal(fetchCount, 1, "terminal coverage caps are not automatically retried as a new scan");
});

test("candidate-level price rejections do not fail a source or discard its valid listings", async () => {
  const db = fakeDb();
  const invalidPriceWarning = "INVALID_SALE_PRICE: pominięto 7 ofert bez poprawnej całkowitej ceny sprzedaży.";
  fakeSourceImpl = async (id, _cursor, batches) => {
    const listing = qualifyingListing(`${id}-valid-mixed-batch`, id);
    listing.rawPayload.detailVerified = true;
    if (batches) {
      await batches.onBatch({
        listings: [listing], warnings: [invalidPriceWarning], fetched: 8,
        sourceRejectionCounts: { invalid_sale_price: 7 },
      }, null);
    }
    return { listings: [listing], warnings: [invalidPriceWarning], fetched: 8 };
  };
  const claimed = await claimOrCreateRadarRun(ownerId, ["oferty_net"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);

  assert.equal(result.status, "completed");
  assert.equal(result.sourceStatuses.oferty_net, "completed");
  assert.equal(result.sourceErrors.oferty_net, undefined, "candidate exclusions must not be displayed as source errors");
  assert.deepEqual(result.sourceRejectionCounts?.oferty_net, { invalid_sale_price: 7 });
  assert.ok(result.sourceWarnings?.oferty_net?.includes(invalidPriceWarning));
  assert.equal(result.scannedCount, 8);
  assert.equal(result.qualifiedCount, 1);
  assert.equal(db.tables.price_radar_listings.length, 1, "the valid listing in the mixed batch remains persisted");
  assert.equal((db.tables.price_radar_runs[0].checkpoint as Row).rejectedCount, 7, "parser-level rejected candidates are included exactly once in the durable count");
});

test("a genuine unclassified warning remains a source failure while preserving valid rows", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id) => ({
    listings: [{ ...qualifyingListing(`${id}-valid-before-source-warning`, id), rawPayload: { detailVerified: true } }],
    warnings: ["Oferty.net: upstream parser contract changed."],
    fetched: 1,
  });
  const claimed = await claimOrCreateRadarRun(ownerId, ["oferty_net"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);

  assert.equal(result.status, "failed");
  assert.equal(result.sourceStatuses.oferty_net, "failed");
  assert.match(result.sourceErrors.oferty_net ?? "", /parser contract changed/);
  assert.equal(result.qualifiedCount, 1);
  assert.equal(db.tables.price_radar_listings.length, 1, "a later source warning cannot roll back a qualified listing");
});

test("detail diagnostics retain at most five sanitized samples per source without changing scan counters", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id, _cursor, batches) => {
    if (id === "domiporta" && batches) {
      const diagnostics: RadarDetailDiagnostic[] = Array.from({ length: 8 }, (_, index) => ({
        kind: "detail_not_confirmed", listingUrl: `https://example.test/listing-${index}/contact+48123456789?token=secret`,
        finalUrl: `https://example.test/listing-${index}/contact+48123456789?email=private%40example.com`, httpStatus: 200,
        identity: "same_listing_id", unconfirmedFields: ["market_type", "unknown_raw_field"], contradictoryFields: [],
      }));
      await batches.onBatch({ listings: [], warnings: [], fetched: diagnostics.length, diagnostics }, null);
    }
    return { listings: [], warnings: [], fetched: 0 };
  };
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta", "morizon"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");
  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);
  const checkpoint = db.tables.price_radar_runs[0]?.checkpoint as Row;
  const examples = (checkpoint.detailDiagnostics as Record<string, RadarDetailDiagnostic[]>).domiporta;

  assert.equal(result.scannedCount, 8, "diagnostic recording does not change the batch's existing scan count");
  assert.equal(result.qualifiedCount, 0);
  assert.deepEqual(checkpoint.qualificationRejections, {}, "diagnostics do not synthesize qualification rejections");
  assert.equal(examples.length, 5, "only five detail samples per source are retained");
  assert.ok(examples.every((item) => item.unconfirmedFields.join(",") === "market_type"));
  assert.ok(examples.every((item) => !JSON.stringify(item).includes("secret") && !JSON.stringify(item).includes("123456789") && !JSON.stringify(item).includes("private@example.com")));
  assert.ok(examples.every((item) => item.listingUrl?.startsWith("https://example.test/listing-")));
  assert.ok(examples.every((item) => item.listingUrl!.length <= 1_024 && item.finalUrl!.length <= 1_024), "URLs are bounded before entering the durable checkpoint");
});

test("detail diagnostics retain public Oferty.net and Domiporta IDs while scrubbing contact data", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id, _cursor, batches) => {
    if (id === "domiporta" && batches) await batches.onBatch({ listings: [], warnings: [], fetched: 0, diagnostics: [
      { kind: "detail_not_confirmed", listingUrl: "https://www.oferty.net/mieszkanie-na-sprzedaz-bauty-fb,1543068412?token=secret", finalUrl: "https://www.oferty.net/mieszkanie-na-sprzedaz-bauty-fb,1543068412#contact", httpStatus: 200, identity: "same_url", unconfirmedFields: ["market_type"], contradictoryFields: [] },
      { kind: "detail_not_confirmed", listingUrl: "https://www.oferty.net/of,1543068412?token=secret", finalUrl: "https://www.oferty.net/of,1543068412#contact", httpStatus: 200, identity: "same_url", unconfirmedFields: ["market_type"], contradictoryFields: [] },
      { kind: "detail_not_confirmed", listingUrl: "https://www.oferty.net/mieszkanie-na-sprzedaz-baluty-ba,1543068412?src=portal", finalUrl: "https://www.oferty.net/mieszkanie-na-sprzedaz-baluty-ba,1543068412", httpStatus: 200, identity: "same_url", unconfirmedFields: ["district"], contradictoryFields: [] },
      { kind: "detail_not_confirmed", listingUrl: "https://www.domiporta.pl/nieruchomosci/sprzedam-mieszkanie-dwupokojowe-lodz-45m2/156297090?auth=secret", finalUrl: "https://www.domiporta.pl/nieruchomosci/sprzedam-mieszkanie-dwupokojowe-lodz-45m2/156297090", httpStatus: 200, identity: "same_url", unconfirmedFields: ["district"], contradictoryFields: [] },
      { kind: "detail_not_confirmed", listingUrl: "https://example.test/contact+48123456789", finalUrl: null, httpStatus: 200, identity: "unconfirmed", unconfirmedFields: [], contradictoryFields: [] },
    ] }, null);
    return { listings: [], warnings: [], fetched: 0 };
  };
  const claim = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected claimed");
  await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  const examples = ((db.tables.price_radar_runs[0]?.checkpoint as Row).detailDiagnostics as Record<string, RadarDetailDiagnostic[]>).domiporta;
  assert.ok(examples[0]?.listingUrl?.endsWith("-fb,1543068412"));
  assert.ok(examples[1]?.listingUrl?.endsWith("/of,1543068412"), "the canonical public ID is retained too");
  assert.ok(examples[2]?.listingUrl?.endsWith("-ba,1543068412"), "other two-letter Oferty.net routes retain their public IDs too");
  assert.ok(examples[3]?.listingUrl?.endsWith("/156297090"));
  assert.ok(examples[4]?.listingUrl?.includes("[redacted]"));
  assert.ok(!JSON.stringify(examples).includes("secret"));
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

test("a changed dwelling under the same portal ID is retained for review, excluded from qualification, and never overwritten by a price/property reimport", async () => {
  const previousRaw = { detailVerified: true, detailLocationText: "Łódź, Teofilów, Łanowa", detailEvidence: { area: 45, rooms: 2, floor: 0, locationText: "Łódź, Teofilów, Łanowa" } };
  const existing = {
    id: "radar-existing-1543068412", owner_id: ownerId, source: "oferty_net", external_listing_id: "1543068412",
    original_url: "https://www.oferty.net/of,1543068412", normalized_url: "https://www.oferty.net/of,1543068412",
    title: "Mieszkanie Łanowa, Teofilów", description: "Mieszkanie o powierzchni 45 m², 2 pokoje, parter, Teofilów. Świeży generalny remont, gotowe do wprowadzenia. Rynek wtórny.",
    price: 419_000, area: 45, price_per_sqm: 419_000 / 45, rooms: 2, city: "Łódź", district: "Bałuty", building_type: "blok",
    market_type: "secondary", renovation_status: "fresh_renovation", content_hash: "old-property", first_seen_at: "2026-10-01T00:00:00Z",
    last_seen_at: "2026-10-01T00:00:00Z", collected_at: "2026-10-01T00:00:00Z", cross_source_identity: null, raw_payload: previousRaw,
    status: "active", excluded_at: null, excluded_reason: null,
  };
  const db = fakeDb({ listings: [existing] });
  const incoming = qualifyingListing("1543068412", "oferty_net") as Record<string, unknown>;
  incoming.price = 549_000;
  incoming.area = 57;
  incoming.pricePerSqm = 549_000 / 57;
  incoming.rooms = 3;
  incoming.title = "Mieszkanie w bloku, Zawiszy Czarnego, Bałuty-Doły";
  incoming.buildingType = "blok";
  incoming.description = "Mieszkanie o powierzchni 57 m², 3 pokoje, 6 piętro, Bałuty-Doły. Świeży generalny remont w 2026, gotowe do wprowadzenia. Rynek wtórny.";
  incoming.rawPayload = { detailVerified: true, marketType: "secondary", propertyType: "apartment", detailLocationText: "Łódź, Bałuty-Doły, Zawiszy Czarnego", detailEvidence: { area: 57, rooms: 3, floor: 6, locationText: "Łódź, Bałuty-Doły, Zawiszy Czarnego" } };
  fakeSourceImpl = async (_id, _cursor, batches) => {
    await batches?.onBatch({ listings: [incoming], warnings: [], fetched: 1 }, null);
    return { listings: [], warnings: [], fetched: 0 };
  };
  const claim = await claimOrCreateRadarRun(ownerId, ["oferty_net"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected claimed run");
  const result = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  const kept = db.tables.price_radar_listings[0]!;
  assert.equal(result.qualifiedCount, 0);
  assert.equal(kept.id, "radar-existing-1543068412");
  assert.equal(kept.area, 45, "new details for a materially different dwelling do not overwrite the saved property snapshot");
  assert.equal(kept.price, 419_000, "the new property's price is not mistaken for a price update of the old dwelling");
  assert.deepEqual((kept.raw_payload as Row).identityVerificationIssues, ["area", "rooms", "floor", "location"]);
  assert.deepEqual(result.qualificationRejections.oferty_net, { listing_identity_changed: 1 });
});

test("a rejected contradictory reimport quarantines the previously counted dwelling without replacing its facts", async () => {
  const existing = {
    id: "radar-existing-conflicted", owner_id: ownerId, source: "oferty_net", external_listing_id: "1543068412",
    original_url: "https://www.oferty.net/of,1543068412", normalized_url: "https://www.oferty.net/of,1543068412",
    title: "Mieszkanie na Łanowej, Teofilów", description: "Mieszkanie o powierzchni 45 m², 2 pokoje, parter, Teofilów. Pełny remont, gotowe do wprowadzenia.",
    price: 419_000, area: 45, price_per_sqm: 419_000 / 45, rooms: 2, city: "Łódź", district: "Bałuty", building_type: "blok",
    market_type: "secondary", renovation_status: "fresh_renovation", content_hash: "old-property", first_seen_at: "2026-10-01T00:00:00Z",
    last_seen_at: "2026-10-01T00:00:00Z", collected_at: "2026-10-01T00:00:00Z", cross_source_identity: null,
    raw_payload: { detailVerified: true, detailEvidence: { area: 45, rooms: 2, floor: 0, locationText: "Łódź, Teofilów, Łanowa" } },
    status: "active", excluded_at: null, excluded_reason: null,
  };
  const db = fakeDb({ listings: [existing] });
  const incoming = qualifyingListing("1543068412", "oferty_net") as Record<string, unknown>;
  incoming.area = 57;
  incoming.rooms = 3;
  incoming.title = "Mieszkanie na Zawiszy Czarnego, Bałuty-Doły";
  incoming.description = "Mieszkanie o powierzchni 45 m², 2 pokoje, parter na Teofilowie; nagłówek ogłoszenia podaje 57 m², 3 pokoje i 6. piętro.";
  incoming.rawPayload = {
    detailVerified: false, marketType: "secondary", propertyType: "apartment",
    detailLocationText: "Łódź, Bałuty-Doły, Zawiszy Czarnego",
    detailContradictions: ["area", "rooms", "floor", "location"],
    detailEvidence: { area: 57, rooms: 3, floor: 6, locationText: "Łódź, Bałuty-Doły, Zawiszy Czarnego" },
  };
  fakeSourceImpl = async (_id, _cursor, batches) => {
    await batches?.onBatch({ listings: [incoming], warnings: [], fetched: 1 }, null);
    return { listings: [], warnings: [], fetched: 0 };
  };
  const claim = await claimOrCreateRadarRun(ownerId, ["oferty_net"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected claimed run");
  const result = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  const kept = db.tables.price_radar_listings[0]!;
  assert.equal(result.qualifiedCount, 0);
  assert.equal(kept.area, 45);
  assert.equal(kept.price, 419_000);
  assert.deepEqual((kept.raw_payload as Row).identityVerificationIssues, ["area", "rooms", "floor", "location"]);
  assert.deepEqual(result.qualificationRejections, { oferty_net: { already_in_analysis: 1 } }, "the conflict is flagged inline on the already-active row, never queued a second time as a fresh pending card");
  assert.equal(db.tables.price_radar_verification_queue.length, 0, "a listing already active in the analysis is never also queued for a separate review decision");

  const read = await getRadarResults(ownerId, { districts: ["Bałuty"], market: "both", areaMin: 30, areaMax: 80, rooms: [], sources: [], minPricePerSqm: null }, db as never);
  assert.equal(read.listings.length, 1, "the saved record and its evidence remain available for review");
  assert.equal(read.listings[0]?.id, "radar-existing-conflicted");
  assert.deepEqual(read.listings[0]?.verificationIssues, ["area", "rooms", "floor", "location"]);
  assert.equal(read.stats.length, 0, "the saved but unresolved record is excluded from A/B reference statistics");
});

test("a materially changed reimport never clears a pre-existing manual exclusion", async () => {
  const db = fakeDb({ listings: [{
    id: "excluded-old", owner_id: ownerId, source: "oferty_net", external_listing_id: "changed-id", original_url: "https://oferty.net/old", normalized_url: "https://oferty.net/old",
    title: "Old apartment", description: "Old description", price: 400_000, area: 45, price_per_sqm: 400_000 / 45, rooms: 2, city: "Łódź", district: "Bałuty",
    building_type: "blok", market_type: "secondary", renovation_status: "fresh_renovation", content_hash: "old-hash", first_seen_at: "2026-10-01T00:00:00Z",
    last_seen_at: "2026-10-01T00:00:00Z", collected_at: "2026-10-01T00:00:00Z", cross_source_identity: null,
    raw_payload: { detailEvidence: { area: 45, rooms: 2, floor: 0, locationText: "Teofilów" } }, status: "active", excluded_at: "2026-10-02T00:00:00Z", excluded_reason: "ręczna decyzja",
  }] });
  const incoming = qualifyingListing("changed-id", "oferty_net") as Record<string, unknown>;
  incoming.rawPayload = { detailVerified: true, marketType: "secondary", propertyType: "apartment", detailEvidence: { area: 57, rooms: 3, floor: 6, locationText: "Bałuty-Doły" } };
  incoming.area = 57;
  incoming.rooms = 3;
  (incoming.rawPayload as Row).detailLocationText = "Bałuty-Doły";
  fakeSourceImpl = async (_id, _cursor, batches) => { await batches?.onBatch({ listings: [incoming], warnings: [], fetched: 1 }, null); return { listings: [], warnings: [], fetched: 0 }; };
  const claim = await claimOrCreateRadarRun(ownerId, ["oferty_net"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected claimed run");
  await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  assert.equal(db.tables.price_radar_listings[0]?.excluded_at, "2026-10-02T00:00:00Z");
  assert.equal(db.tables.price_radar_listings[0]?.excluded_reason, "ręczna decyzja");
  assert.equal(db.rpcCalls.filter(({ name }) => name === "persist_price_radar_listing").length, 0, "an excluded snapshot is not rewritten while identity is uncertain");
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

test("normal expired-run resume releases a terminal OLX job and continues pending portals without repeating completed sources", async () => {
  const runId = "run-olx-terminal-resume";
  const checkpoint = {
    sourceQueue: ["morizon", "olx", "oferty_net"], currentSourceIndex: 1,
    sourceStatuses: { morizon: "completed", olx: "running", oferty_net: "pending" },
    sourceErrors: {}, perSourceCursor: { morizon: "__RADAR_SOURCE_DONE__" },
    qualificationRejections: {}, buffer: [], bufferOffset: 0,
  };
  const row = {
    id: runId, owner_id: ownerId, status: "running", started_at: "2026-10-12T20:00:00.000Z",
    lease_token: "expired-radar-lease", lease_until: new Date(Date.now() - 60_000).toISOString(),
    finished_at: null, scanned_count: 1, qualified_count: 1, error_message: null,
    checkpoint, source_statuses: checkpoint.sourceStatuses,
  };
  const db = fakeDb({ runs: [row], olxJobs: [{
    id: "terminal-olx-job", context_type: "price_radar", radar_owner_id: ownerId, radar_run_id: runId,
    idempotency_key: `price-radar:${ownerId}:olx:${runId}`, status: "failed", error_code: "LEASE_EXHAUSTED",
  }] });
  let morizonCalls = 0;
  let ofertyCalls = 0;
  fakeSourceImpl = async (id) => {
    if (id === "morizon") morizonCalls += 1;
    if (id === "oferty_net") ofertyCalls += 1;
    return { listings: [qualifyingListing(`${id}-after-olx-failure`, id)], warnings: [], fetched: 1 };
  };

  const resumed = await resumeExistingRadarRun(ownerId, runId, db as never);
  assert.equal(resumed.kind, "claimed", "a terminal worker result cannot permanently lock the Radar run");
  if (resumed.kind !== "claimed") return;
  const result = await runRadarCollectionPortion({ runId, ownerId, leaseToken: resumed.run.leaseToken! }, db as never);
  assert.equal(result.status, "partial");
  assert.equal(result.sourceStatuses.olx, "failed");
  assert.match(result.sourceErrors.olx ?? "", /RADAR_OLX_JOB_ALREADY_FAILED/u);
  assert.equal(result.sourceStatuses.oferty_net, "completed", "a terminal OLX job cannot block the remaining portal");
  assert.equal(morizonCalls, 0, "the already-completed source is not fetched again");
  assert.equal(ofertyCalls, 1);
  assert.equal(db.tables.olx_scan_jobs.length, 1, "resume never creates a duplicate OLX reservation");
  assert.equal(db.tables.olx_scan_jobs[0]?.status, "failed", "Radar does not rewrite the worker's terminal job status");
});

test("a completed OLX reservation is checkpointed as completed before later sources continue", async () => {
  const runId = "run-olx-completed-checkpoint";
  const checkpoint = {
    sourceQueue: ["olx", "oferty_net"], currentSourceIndex: 0,
    sourceStatuses: { olx: "running", oferty_net: "pending" }, sourceErrors: {}, perSourceCursor: {},
    qualificationRejections: {}, buffer: [], bufferOffset: 0,
  };
  const row = {
    id: runId, owner_id: ownerId, status: "running", started_at: "2026-10-12T20:00:00.000Z",
    lease_token: "expired-radar-lease", lease_until: new Date(Date.now() - 60_000).toISOString(),
    finished_at: null, scanned_count: 1, qualified_count: 0, error_message: null,
    checkpoint, source_statuses: checkpoint.sourceStatuses,
  };
  const db = fakeDb({ runs: [row], olxJobs: [{
    id: "completed-olx-job", context_type: "price_radar", radar_owner_id: ownerId, radar_run_id: runId,
    idempotency_key: `price-radar:${ownerId}:olx:${runId}`, status: "completed",
  }] });
  let ofertyCalls = 0;
  fakeSourceImpl = async (id) => {
    if (id === "oferty_net") ofertyCalls += 1;
    return { listings: [qualifyingListing(`${id}-completed-olx`, id)], warnings: [], fetched: 1 };
  };

  const resumed = await resumeExistingRadarRun(ownerId, runId, db as never);
  assert.equal(resumed.kind, "claimed");
  if (resumed.kind !== "claimed") return;
  const result = await runRadarCollectionPortion({ runId, ownerId, leaseToken: resumed.run.leaseToken! }, db as never);
  assert.equal(result.status, "completed");
  assert.equal(result.sourceStatuses.olx, "completed");
  assert.equal(result.sourceStatuses.oferty_net, "completed");
  assert.equal(ofertyCalls, 1);
  assert.equal(db.tables.olx_scan_jobs.length, 1, "the completed worker reservation is reused rather than duplicated");
});

test("resuming a legacy checkpoint that still queues a now-disabled source (szybko) skips it with an honest reason, fetches nothing from it, and still runs the rest of the queue", async () => {
  const db = fakeDb();
  // claimOrCreateRadarRun already filters a newly requested source list
  // against RADAR_SOURCES, so it could never itself produce this state.
  // This reproduces a run whose sourceQueue was saved to the database
  // before szybko was turned off -- the one case that matters here.
  const leaseToken = "lease-legacy-szybko";
  db.tables.price_radar_runs.push({
    id: "run-legacy-szybko", owner_id: ownerId, lease_token: leaseToken,
    lease_until: new Date(Date.now() + 75_000).toISOString(),
    started_at: new Date().toISOString(), finished_at: null, status: "running",
    scanned_count: 0, qualified_count: 0, error_message: null, source_statuses: { szybko: "pending", domiporta: "pending" },
    checkpoint: {
      sourceQueue: ["szybko", "domiporta"], currentSourceIndex: 0, perSourceCursor: {},
      sourceStatuses: { szybko: "pending", domiporta: "pending" }, sourceErrors: {}, qualificationRejections: {}, buffer: [], bufferOffset: 0,
    },
  });
  let szybkoFetchAttempted = false;
  fakeSourceImpl = async (id) => {
    if (id === "szybko") { szybkoFetchAttempted = true; return { listings: [], warnings: [], fetched: 0 }; }
    return { listings: [qualifyingListing(`${id}-1`, id)], warnings: [], fetched: 1 };
  };

  const result = await runRadarCollectionPortion({ runId: "run-legacy-szybko", ownerId, leaseToken }, db as never);

  assert.equal(szybkoFetchAttempted, false, "a disabled source already queued by an old checkpoint must never actually be fetched");
  assert.equal(result.sourceStatuses.szybko, "failed");
  assert.equal(result.sourceErrors.szybko, "Źródło wyłączone.", "the skip reason must say the source is disabled, not merely 'not registered'");
  assert.equal(result.sourceStatuses.domiporta, "completed", "the rest of the queue still runs after the disabled stage is skipped");
  assert.equal(result.qualifiedCount, 1);
  assert.equal(result.status, "partial", "a skipped disabled source still ends the run partial, not silently 'completed'");
});

test("a candidate missing ONLY its district (every other Radar criterion confirmed) is queued for manual district assignment, never counted as a dead-end rejection", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id) => ({ listings: [{ ...qualifyingListing(`${id}-nodist`, id), district: null }], warnings: [], fetched: 1 });
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);

  assert.equal(result.qualifiedCount, 0, "a queued candidate is not yet a qualified Radar listing");
  assert.equal(db.tables.price_radar_listings.length, 0, "a district-only-missing candidate is never written straight to price_radar_listings");
  assert.deepEqual(result.qualificationRejections, {}, "it must never also be counted as district_not_confirmed -- it is an actionable queue item, not a dead end");
  assert.equal(db.tables.price_radar_district_queue.length, 1);
  assert.equal(db.tables.price_radar_district_queue[0]?.source, "domiporta");
  assert.equal(db.tables.price_radar_district_queue[0]?.building_type, "blok");
  assert.equal(db.tables.price_radar_district_queue[0]?.status, "pending");
  assert.equal((db.tables.price_radar_runs[0].checkpoint as Row).districtQueuedCount, 1);
  assert.equal((db.tables.price_radar_runs[0].checkpoint as Row).verificationQueuedCount, 0);
  assert.equal((db.tables.price_radar_runs[0].checkpoint as Row).rejectedCount, 0);
});

test("a verified Oferty.net category-B listing missing only its district reaches the operator queue", async () => {
  const db = fakeDb();
  fakeSourceImpl = async () => ({ listings: [{
    ...qualifyingListing("oferty-b-no-district", "oferty_net"),
    title: "Mieszkanie w bloku, Łódź",
    description: "Sprzedaż mieszkania. Rynek wtórny. W pełni wykończone pod klucz, gotowe do zamieszkania, wysoki standard.",
    district: null,
    rawPayload: { detailVerified: true, marketType: "secondary", propertyType: "apartment" },
  }], warnings: [], fetched: 1 });
  const claim = await claimOrCreateRadarRun(ownerId, ["oferty_net"], db as never, { areaMin: null, areaMax: null, rooms: [], qualityRulesVersion: 2, minPricePerSqm: null });
  if (claim.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  assert.equal(result.qualifiedCount, 0, "the operator must confirm the district before the offer enters A/B statistics");
  assert.equal(db.tables.price_radar_listings.length, 0);
  assert.equal(db.tables.price_radar_district_queue.length, 1, "the missing district is the only unresolved criterion");
  assert.equal(db.tables.price_radar_district_queue[0]?.source, "oferty_net");
  assert.equal(db.tables.price_radar_district_queue[0]?.market_type, "secondary");
  assert.equal(db.tables.price_radar_district_queue[0]?.renovation_status, "turnkey_finish", "category B needs no renovation date");
  assert.deepEqual(result.qualificationRejections, {});
});

test("an uncertain but credible apartment-sale candidate is saved only to the separate verification queue", async () => {
  const db = fakeDb();
  fakeSourceImpl = async () => ({ listings: [{
    ...qualifyingListing("needs-verification-42", "oferty_net"),
    title: "Mieszkanie na sprzedaż w Łodzi, Śródmieście",
    description: "Pojedyncze mieszkanie w budynku. Część danych szczegółowych wymaga sprawdzenia.",
    buildingType: null, marketType: null,
    rawPayload: {
      radarSearchScope: "apartment-sale", propertyType: "apartment", detailVerified: false,
      marketType: null,
      detailEvidence: { unconfirmedFields: ["building_type", "market_type", "finish_evidence"] },
      detailResponse: { httpStatus: 200, finalUrl: "https://allegrolokalnie.pl/oferta/needs-verification-42", identity: "same_listing_id" },
    },
  }], warnings: [], fetched: 1 });
  const claim = await claimOrCreateRadarRun(ownerId, ["oferty_net"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);

  assert.equal(result.qualifiedCount, 0);
  assert.equal(db.tables.price_radar_listings.length, 0, "unverified source data never reaches Radar comparisons");
  assert.equal(db.tables.price_radar_district_queue.length, 0, "multiple missing facts do not masquerade as district-only work");
  assert.equal(db.tables.price_radar_verification_queue.length, 1);
  const queued = db.tables.price_radar_verification_queue[0]!;
  assert.equal(queued.owner_id, ownerId);
  assert.equal(queued.status, "pending");
  assert.equal(queued.original_url, "https://example.test/needs-verification-42");
  assert.equal((queued.source_snapshot as Row).sourceHttpStatus, 200);
  assert.deepEqual(queued.missing_fields, ["building_type", "market_type", "standard"]);
  assert.deepEqual(result.qualificationRejections, {}, "a successfully queued candidate is not counted as a discarded rejection");
  assert.equal((db.tables.price_radar_runs[0].checkpoint as Row).verificationQueuedCount, 1);
  assert.equal((db.tables.price_radar_runs[0].checkpoint as Row).rejectedCount, 0);
});

test("a confirmed operator decision is reapplied on source reimport, promotes one listing, and stays visible below the 20-offer sample minimum", async () => {
  const decision = {
    apartmentSaleConfirmed: true, price: 440_000, area: 40, rooms: 2, city: "Łódź", district: "Bałuty",
    buildingType: "blok", marketType: "secondary", qualityCategory: "ready_high_standard",
  };
  const db = fakeDb({ verificationQueue: [{
    id: "verification-confirmed", owner_id: ownerId, source: "oferty_net", external_listing_id: "reimported-offer",
    status: "confirmed", operator_decision: decision,
  }] });
  fakeSourceImpl = async () => ({ listings: [{
    ...qualifyingListing("reimported-offer", "oferty_net"),
    title: "Mieszkanie na sprzedaż w Łodzi",
    description: "Pojedyncze mieszkanie na sprzedaż; wykończenie pod klucz, gotowe do zamieszkania, wysoki standard.",
    price: 9_500, area: 40, pricePerSqm: 237.5, district: null, buildingType: null,
    rawPayload: {
      radarSearchScope: "apartment-sale", propertyType: "apartment", detailVerified: false,
      priceIsStartingAt: true, priceKind: "from", priceUnit: "per_sqm", marketType: null,
    },
  }], warnings: [], fetched: 1 });
  const claim = await claimOrCreateRadarRun(ownerId, ["oferty_net"], db as never, {
    areaMin: 31, areaMax: 62, rooms: [1, 2, 3], qualityRulesVersion: 2, minPricePerSqm: 8_800,
  });
  if (claim.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);

  assert.equal(result.qualifiedCount, 1, "the persisted operator total price and corrected fields are applied before qualification");
  assert.equal(db.tables.price_radar_listings.length, 1, "reimport updates/promotes one canonical Radar listing");
  const saved = db.tables.price_radar_listings[0]!;
  assert.equal(saved.price, 440_000);
  assert.equal(saved.price_per_sqm, 11_000);
  assert.equal(saved.district, "Bałuty");
  assert.equal((saved.raw_payload as Row).priceKind, "total");
  assert.equal(((saved.raw_payload as Row).operatorPriceEvidence as Row).priceKind, "from", "the original parser warning remains auditable");

  const visible = await getRadarResults(ownerId, {
    districts: ["Bałuty"], market: "both", areaMin: 31, areaMax: 62, rooms: [1, 2, 3], sources: [], minPricePerSqm: 8_800,
  }, db as never);
  assert.equal(visible.listings.length, 1, "the confirmed offer is not hidden while its group has fewer than 20 records");
  assert.equal(visible.stats.length, 1);
  assert.equal(visible.stats[0]?.sampleSize, 1);
  assert.equal(visible.stats[0]?.isSmallSample, true);
  assert.equal(visible.stats[0]?.averagePricePerSqm, null, "a one-offer sample does not publish a reference price");
});

test("a candidate already rejected in the verification queue stays rejected even once a later scan fully confirms it, instead of silently qualifying directly", async () => {
  const db = fakeDb({ verificationQueue: [{
    id: "verification-rejected", owner_id: ownerId, source: "domiporta", external_listing_id: "now-confirmed-offer",
    status: "rejected", operator_decision: null,
  }] });
  fakeSourceImpl = async () => ({ listings: [qualifyingListing("now-confirmed-offer", "domiporta")], warnings: [], fetched: 1 });
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);

  assert.equal(result.qualifiedCount, 0, "a listing the operator already rejected in the verification queue must never qualify directly, even once fully confirmed");
  assert.equal(db.tables.price_radar_listings.length, 0);
  assert.deepEqual(result.qualificationRejections, { domiporta: { previously_rejected_by_operator: 1 } });
});

test("a candidate already rejected in the district-assignment queue stays rejected even once its district later becomes confirmed, instead of silently qualifying directly", async () => {
  const db = fakeDb({ districtQueue: [{
    id: "district-rejected", owner_id: ownerId, source: "domiporta", external_listing_id: "now-district-confirmed",
    status: "rejected", assigned_district: null,
  }] });
  fakeSourceImpl = async () => ({ listings: [qualifyingListing("now-district-confirmed", "domiporta")], warnings: [], fetched: 1 });
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);

  assert.equal(result.qualifiedCount, 0, "a listing the operator already rejected in the district-assignment queue must never qualify directly, even once its district is later confirmed");
  assert.equal(db.tables.price_radar_listings.length, 0);
  assert.deepEqual(result.qualificationRejections, { domiporta: { previously_rejected_by_operator: 1 } });
});

test("a candidate otherwise reviewable (e.g. a missing price) is never queued for a separate decision when it already has an active row in the comparison analysis", async () => {
  const existing = {
    id: "radar-existing-active", owner_id: ownerId, source: "domiporta", external_listing_id: "already-active-offer",
    original_url: "https://example.test/already-active-offer", normalized_url: "https://example.test/already-active-offer",
    title: "Mieszkanie w bloku, Łódź Bałuty", description: "Świeżo po remoncie.", price: 450_000, area: 50,
    price_per_sqm: 9_000, rooms: 2, city: "Łódź", district: "Bałuty", building_type: "blok", market_type: "secondary",
    renovation_status: "fresh_renovation", content_hash: "old-hash", first_seen_at: "2026-10-01T00:00:00Z",
    last_seen_at: "2026-10-01T00:00:00Z", collected_at: "2026-10-01T00:00:00Z", cross_source_identity: null,
    raw_payload: { detailVerified: true }, status: "active", excluded_at: null, excluded_reason: null,
  };
  const db = fakeDb({ listings: [existing] });
  fakeSourceImpl = async () => ({ listings: [{ ...qualifyingListing("already-active-offer", "domiporta"), price: null }], warnings: [], fetched: 1 });
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);

  assert.equal(result.qualifiedCount, 0);
  assert.equal(db.tables.price_radar_verification_queue.length, 0, "already represented in the analysis -- never queued again as a fresh pending card");
  assert.deepEqual(result.qualificationRejections, { domiporta: { already_in_analysis: 1 } });
});

test("an unapplied district queue migration is surfaced as partial work instead of silently dropping an otherwise eligible candidate", async () => {
  const db = fakeDb({ districtQueueRpcError: { code: "PGRST202", message: "Could not find the function public.upsert_price_radar_district_queue_candidate in the schema cache" } });
  fakeSourceImpl = async (id) => ({ listings: [{ ...qualifyingListing(`${id}-nodist-no-schema`, id), district: null }], warnings: [], fetched: 1 });
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);

  assert.equal(result.status, "partial", "a missing required queue schema is not reported as a clean, completed source");
  assert.equal(result.sourceStatuses.domiporta, "partial");
  assert.equal(db.tables.price_radar_district_queue.length, 0, "the test does not pretend an unavailable table accepted the candidate");
  assert.equal(db.tables.price_radar_listings.length, 0, "a district-missing candidate is never promoted without operator confirmation");
  assert.match(result.sourceWarnings?.domiporta?.join(" ") ?? "", /RADAR_DISTRICT_QUEUE_UNAVAILABLE/u);
  assert.deepEqual(result.qualificationRejections, {}, "the candidate remains an actionable queue dependency, not a false rejection");
});

test("a candidate missing its district AND another criterion (e.g. an unconfirmed building type) enters the general verification queue, not the district-only queue", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id) => ({
    listings: [{ ...qualifyingListing(`${id}-nodist-nobuild`, id), district: null, title: "Mieszkanie", description: "Świeżo po generalnym remoncie w 2025, gotowe do zamieszkania. Rynek wtórny." }],
    warnings: [], fetched: 1,
  });
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");

  const result = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken! }, db as never);

  assert.equal(db.tables.price_radar_district_queue.length, 0, "missing more than just the district must never enter the district-only queue");
  assert.equal(db.tables.price_radar_verification_queue.length, 1, "the general queue handles multiple uncertain facts for a credible offer");
  assert.deepEqual(result.qualificationRejections, {}, "a saved review candidate is not counted as discarded");
});

test("a portal that times out on every portion is closed after a bounded number of tries so the run, OLX and other portals are never blocked", async () => {
  // Production 2026-10-13: run 0938a6b6 returned "running" 443/27 for 24
  // consecutive scheduler portions because Domy.pl timed out each time and a
  // timeout was always retried; OLX (always last) could never start.
  // Oferty.net stands in for that portal here; Adresowo is CAPTCHA-blocked.
  const db = fakeDb();
  const attempts: Record<string, number> = {};
  fakeSourceImpl = async (id) => {
    attempts[id] = (attempts[id] ?? 0) + 1;
    if (id === "oferty_net") { const error = new Error("The operation was aborted due to timeout"); error.name = "TimeoutError"; throw error; }
    if (id === "adresowo") throw new Error("HTTP 403 CAPTCHA_OR_ACCESS_DENIED");
    return { listings: [qualifyingListing(`${id}-ok`, id)], warnings: [], fetched: 1 };
  };
  const claim = await claimOrCreateRadarRun(ownerId, ["oferty_net", "adresowo", "domiporta", "olx"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected claimed");
  const input = { runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! };

  const portions = [];
  for (let portion = 0; portion < RADAR_SOURCE_TIMEOUT_LIMIT + 2; portion += 1) {
    const startedAt = Date.now();
    const result = await runRadarCollectionPortion(input, db as never);
    assert.ok(Date.now() - startedAt < 5_000, "a deferred OLX source must not spin checkpoint writes until the 34 s portion budget is spent");
    portions.push(result);
    if (result.sourceStatuses.olx === "running") break;
  }
  const last = portions.at(-1)!;
  assert.equal(attempts.oferty_net, RADAR_SOURCE_TIMEOUT_LIMIT, "the timing-out portal is tried exactly up to the limit, never forever");
  assert.equal(last.sourceStatuses.oferty_net, "failed");
  assert.match(last.sourceErrors.oferty_net ?? "", /^RADAR_SOURCE_TIMEOUT_LIMIT:/u);
  assert.equal(last.sourceStatuses.adresowo, "failed");
  assert.match(last.sourceErrors.adresowo ?? "", /TERMINAL_ACCESS_ERROR/u, "a CAPTCHA is recorded, never bypassed or retried");
  assert.equal(attempts.adresowo, 1);
  assert.equal(last.sourceStatuses.domiporta, "completed");
  assert.equal(attempts.domiporta, 1, "a completed portal is never fetched again by later portions");
  assert.equal(last.sourceStatuses.olx, "running", "OLX finally reaches its worker queue instead of being deferred forever");
  assert.equal(db.tables.olx_scan_jobs.length, 1);
  assert.equal(db.tables.price_radar_runs.length, 1, "all portions continued the one run");
  assert.equal(db.tables.price_radar_runs[0]?.id, claim.run.id);
});

test("a portal that commits progress between timeouts is not closed; only consecutive no-progress timeouts count", async () => {
  const db = fakeDb();
  let calls = 0;
  fakeSourceImpl = async (id, cursor, batches) => {
    if (id !== "domiporta") return { listings: [], warnings: [], fetched: 0 };
    calls += 1;
    // Each attempt commits one page and then runs out of time on the next.
    await batches!.onBatch({ listings: [qualifyingListing(`page-${calls}`, "domiporta")], warnings: [], fetched: 1 }, (cursor ?? 1) + 1);
    if (calls <= RADAR_SOURCE_TIMEOUT_LIMIT + 1) { const error = new Error("timeout"); error.name = "AbortError"; throw error; }
    return { listings: [], warnings: [], fetched: 0 };
  };
  const claim = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected claimed");
  let result;
  for (let portion = 0; portion < RADAR_SOURCE_TIMEOUT_LIMIT + 3; portion += 1) {
    result = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
    if (result.status !== "running") break;
  }
  assert.equal(result?.status, "completed", "a slow but progressing portal finishes normally");
  assert.equal(result?.scannedCount, RADAR_SOURCE_TIMEOUT_LIMIT + 2);
});

test("releasing a lease after a portion lets the next continuation claim the same run at once, fenced by the exact lease token", async () => {
  const db = fakeDb();
  fakeSourceImpl = async () => ({ listings: [], warnings: [], fetched: 0 });
  const claim = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected claimed");
  const row = db.tables.price_radar_runs[0]!;
  const blocked = await resumeExistingRadarRun(ownerId, claim.run.id, db as never);
  assert.deepEqual(blocked, { kind: "blocked", reason: "lease_active" }, "an active lease is never taken over");

  assert.equal(await releaseRadarRunLease({ runId: claim.run.id, ownerId, leaseToken: "someone-elses-token" }, db as never), false);
  assert.ok(Date.parse(String(row.lease_until)) > Date.now(), "a foreign token cannot release the lease");

  assert.equal(await releaseRadarRunLease({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never), true);
  const resumed = await resumeExistingRadarRun(ownerId, claim.run.id, db as never);
  assert.equal(resumed.kind, "claimed");
  if (resumed.kind !== "claimed") return;
  assert.equal(resumed.run.id, claim.run.id, "the same run continues; no parallel run is created");
  assert.notEqual(resumed.run.leaseToken, claim.run.leaseToken);
  const second = await resumeExistingRadarRun(ownerId, claim.run.id, db as never);
  assert.equal(second.kind, "blocked", "a concurrent second continuation loses the CAS");
  assert.equal(db.tables.price_radar_runs.length, 1);
});
