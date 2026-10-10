import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { SourceBatchYield } from "@/features/flip-finder/source-batches";

type Row = Record<string, unknown>;
type Listing = { source: string; externalListingId: string; originalUrl: string; normalizedUrl: string; title: string; description: string; price: number; area: number; pricePerSqm: number; rooms: number; city: string; district: string; buildingType: null; floor: null; locationText: string; thumbnailUrl: null; images: never[]; publishedAt: null; rawPayload: Record<string, unknown>; contentHash: string };
type Batch = { listings: Listing[]; warnings: string[]; fetched: number };
type RadarDetailCursor = { kind: "radar_detail_v1"; page: number; candidateIndex: number };
type Batches = { cursor?: number; radarDetailCursor?: RadarDetailCursor; purpose?: "finder" | "price_radar"; deadlineAt?: number; onBatch(batch: Batch, nextCursor: number | RadarDetailCursor | null): Promise<void> };
const ownerId = "owner-radar-checkpoint";

function fakeDb() {
  const tables: Record<string, Row[]> = { price_radar_runs: [], price_radar_listings: [], olx_scan_jobs: [] };
  const accessedTables = new Set<string>();
  const persisted: string[] = [];
  let sequence = 0;
  return {
    tables,
    accessedTables,
    persisted,
    async rpc(name: string, args: Row) {
      if (name === "claim_price_radar_run") {
        const existing = tables.price_radar_runs.find((row) => row.owner_id === args.p_owner_id && ["pending", "running"].includes(String(row.status)));
        if (existing) return { data: null, error: null };
        const id = `run-${++sequence}`;
        const token = `lease-${sequence}`;
        const row = { id, run_id: id, owner_id: args.p_owner_id, lease_token: token, lease_until: new Date(Date.now() + Number(args.p_lease_seconds) * 1000).toISOString(), started_at: new Date().toISOString(), finished_at: null, status: "running", scanned_count: 0, qualified_count: 0, error_message: null, source_statuses: {}, checkpoint: args.p_initial_checkpoint };
        tables.price_radar_runs.push(row);
        return { data: [row], error: null };
      }
      if (name === "checkpoint_price_radar_run") {
        const row = tables.price_radar_runs.find((item) => item.id === args.p_run_id && item.owner_id === args.p_owner_id && item.lease_token === args.p_lease_token && item.status === "running");
        if (!row) return { data: false, error: null };
        Object.assign(row, { checkpoint: args.p_checkpoint, source_statuses: args.p_source_statuses, scanned_count: args.p_scanned_count, qualified_count: args.p_qualified_count, status: args.p_status, error_message: args.p_error_message });
        if (["completed", "partial", "failed"].includes(String(args.p_status))) Object.assign(row, { finished_at: new Date().toISOString(), lease_token: null, lease_until: null });
        else row.lease_until = new Date(Date.now() + Number(args.p_lease_seconds) * 1000).toISOString();
        return { data: true, error: null };
      }
      if (name === "persist_price_radar_listing") { persisted.push(String((args.p_listing as Row).external_listing_id)); return { data: `listing-${++sequence}`, error: null }; }
      throw new Error(`unexpected RPC ${name}`);
    },
    from(table: string) {
      accessedTables.add(table);
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Array<(row: Row) => boolean> = [];
      let op: "select" | "insert" = "select";
      let payload: Row | null = null;
      const builder: Row = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        order: () => builder,
        maybeSingle: async () => ({ data: rows.find((row) => filters.every((filter) => filter(row))) ?? null, error: null }),
        insert: (value: Row) => { op = "insert"; payload = value; return builder; },
        single: async () => {
          if (op !== "insert" || !payload) throw new Error("unexpected fake DB single() call");
          const existing = rows.find((row) => row.idempotency_key === payload!.idempotency_key);
          if (existing) return { data: null, error: { code: "23505", message: "duplicate idempotency key" } };
          const row = { id: `job-${++sequence}`, status: "queued", created_at: new Date().toISOString(), ...payload };
          rows.push(row);
          return { data: row, error: null };
        },
      };
      return builder;
    },
  };
}

function listing(id: string): Listing {
  return {
    source: "domiporta", externalListingId: id, originalUrl: `https://example.test/${id}`, normalizedUrl: `https://example.test/${id}`,
    title: "Mieszkanie w bloku, Łódź Bałuty", description: "Świeżo po generalnym remoncie w 2025, nowe instalacje, gotowe do zamieszkania. Rynek wtórny.",
    price: 450_000, area: 50, pricePerSqm: 9_000, rooms: 2, city: "Łódź", district: "Bałuty", buildingType: null, floor: null,
    locationText: "Bałuty, Łódź", thumbnailUrl: null, images: [], publishedAt: null, rawPayload: { detailVerified: true }, contentHash: `hash-${id}`,
  };
}

let fetchFixture: (source: string, cursor: number | undefined, batches: Batches | undefined) => Promise<{ listings: Listing[]; warnings: string[]; fetched: number }>;
let fetchRadarDetailFixture: ((batches: Batches | undefined) => Promise<{ listings: Listing[]; warnings: string[]; fetched: number }>) | null = null;
const sourceRegistry = ["domiporta", "olx"].map((id) => ({
  id, label: id,
  fetch: async (_criteria: unknown, _signal?: AbortSignal, batches?: Batches) => id === "domiporta" && fetchRadarDetailFixture ? fetchRadarDetailFixture(batches) : fetchFixture(id, batches?.cursor, batches),
}));
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { throw new Error("checkpoint tests must inject a fake DB"); } } });
mock.module("@/features/flip-finder/server/search-source-registry", {
  namedExports: { SOURCES: sourceRegistry, slugifyCity: () => "lodz", activeSources: (filter: { sources: string[] }) => sourceRegistry.filter((source) => filter.sources.includes(source.id)) },
});
const { claimOrCreateRadarRun, runRadarCollectionPortion } = await import("./collect.ts");

test("a page checkpoint resumes the same run at the next page and does not fetch the completed page again", async () => {
  const db = fakeDb();
  let pageOneReads = 0;
  let pageTwoReads = 0;
  fetchFixture = async (_source, cursor, batches) => {
    assert.ok(batches);
    if (cursor === undefined) {
      pageOneReads += 1;
      await batches.onBatch({ listings: [listing("page-1")], warnings: [], fetched: 1 }, 2);
      throw Object.assign(new Error("checkpointed portion yield"), { name: "AbortError" });
    }
    assert.equal(cursor, 2);
    pageTwoReads += 1;
    await batches.onBatch({ listings: [listing("page-2")], warnings: [], fetched: 1 }, null);
    return { listings: [], warnings: [], fetched: 0 };
  };
  const claim = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected a claimed run");
  const first = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  assert.equal(first.status, "running");
  assert.equal(first.sourceStatuses.domiporta, "pending");
  assert.equal(db.tables.price_radar_runs[0].id, claim.run.id);
  assert.equal((db.tables.price_radar_runs[0].checkpoint as { perSourceCursor: Record<string, unknown> }).perSourceCursor.domiporta, 2);
  const second = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  assert.equal(second.status, "completed");
  assert.equal(pageOneReads, 1);
  assert.equal(pageTwoReads, 1);
});

test("a Radar detail checkpoint resumes the same run and persists only candidates not already checkpointed", async () => {
  const db = fakeDb();
  let adapterCalls = 0;
  fetchRadarDetailFixture = async (batches) => {
    adapterCalls += 1;
    assert.equal(batches?.purpose, "price_radar");
    if (!batches?.radarDetailCursor) {
      assert.ok(batches?.onBatch);
      await batches.onBatch({ listings: [listing("detail-1")], warnings: [], fetched: 1 }, { kind: "radar_detail_v1", page: 1, candidateIndex: 1 });
      throw new SourceBatchYield("detail_batch_limit");
    }
    assert.deepEqual(batches.radarDetailCursor, { kind: "radar_detail_v1", page: 1, candidateIndex: 1 });
    await batches.onBatch({ listings: [listing("detail-2")], warnings: [], fetched: 1 }, null);
    return { listings: [], warnings: [], fetched: 0 };
  };
  try {
    const claim = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
    if (claim.kind !== "claimed") throw new Error("expected a claimed run");
    const first = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
    const saved = db.tables.price_radar_runs[0]!;
    assert.equal(first.status, "running");
    assert.equal(first.sourceStatuses.domiporta, "pending");
    assert.equal(saved.id, claim.run.id, "the incomplete detail queue keeps the original run ID");
    assert.deepEqual((saved.checkpoint as { perSourceCursor: Record<string, unknown> }).perSourceCursor.domiporta, { kind: "radar_detail_v1", page: 1, candidateIndex: 1 });
    assert.deepEqual(db.persisted, ["detail-1"]);

    const second = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
    assert.equal(second.status, "completed");
    assert.equal(adapterCalls, 2);
    assert.deepEqual(db.persisted, ["detail-1", "detail-2"], "only the uncompleted candidate is persisted by the resumed portion");
    assert.equal(db.tables.price_radar_runs[0]?.id, claim.run.id);
  } finally { fetchRadarDetailFixture = null; }
});

test("completed and terminal 403 source checkpoints advance without retrying the adapter", async () => {
  let fetchCalls = 0;
  fetchFixture = async () => { fetchCalls += 1; throw new Error("terminal checkpoint must not fetch"); };
  for (const sourceStatus of ["completed", "failed"] as const) {
    const db = fakeDb();
    const claim = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
    if (claim.kind !== "claimed") throw new Error("expected a claimed run");
    db.tables.price_radar_runs[0].checkpoint = {
      sourceQueue: ["domiporta"], currentSourceIndex: 0, perSourceCursor: { domiporta: "__RADAR_SOURCE_DONE__" },
      sourceStatuses: { domiporta: sourceStatus }, sourceErrors: sourceStatus === "failed" ? { domiporta: "TERMINAL_ACCESS_ERROR: HTTP 403" } : {}, buffer: [], bufferOffset: 0,
    };
    const result = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
    assert.equal(result.sourceStatuses.domiporta, sourceStatus);
    assert.equal(result.status, sourceStatus === "failed" ? "failed" : "completed");
  }
  assert.equal(fetchCalls, 0);
});

test("OLX is queued once in its Radar context and creates no Finder source scan or membership", async () => {
  const db = fakeDb();
  fetchFixture = async () => { throw new Error("OLX must use its existing async worker queue"); };
  const claim = await claimOrCreateRadarRun(ownerId, ["olx"], db as never);
  if (claim.kind !== "claimed") throw new Error("expected a claimed run");
  const first = await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  assert.equal(first.status, "running");
  assert.equal(first.sourceStatuses.olx, "running");
  assert.equal(db.tables.olx_scan_jobs.length, 1);
  assert.equal(db.tables.olx_scan_jobs[0].context_type, "price_radar");
  assert.equal(db.tables.olx_scan_jobs[0].source_scan_id, null);
  assert.equal(db.tables.olx_scan_jobs[0].search_filter_id, null);
  assert.equal(db.tables.olx_scan_jobs[0].radar_run_id, claim.run.id);
  await runRadarCollectionPortion({ runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! }, db as never);
  assert.equal(db.tables.olx_scan_jobs.length, 1, "repeated scheduler portions reuse the idempotent row");
  assert.ok(!db.accessedTables.has("source_scans"));
  assert.ok(!db.accessedTables.has("listing_filter_matches"));
});
