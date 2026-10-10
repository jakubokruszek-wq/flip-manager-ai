import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;

mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { throw new Error("resume tests must inject a fake DB"); } } });
mock.module("@/features/flip-finder/server/search-source-registry", { namedExports: { SOURCES: [], slugifyCity: () => "lodz", activeSources: () => [] } });
const { resumeExistingRadarRun } = await import("./collect.ts");

function fakeDb(initial: Row) {
  const rows = [structuredClone(initial)];
  let updates = 0;
  const db = {
    rows,
    get updates() { return updates; },
    from(table: string) {
      assert.equal(table, "price_radar_runs");
      const filters: Array<(row: Row) => boolean> = [];
      let payload: Row | null = null;
      const builder: Row = {
        select: () => builder,
        update: (value: Row) => { payload = value; return builder; },
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        is: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        lte: (key: string, value: string) => { filters.push((row) => typeof row[key] === "string" && Date.parse(String(row[key])) <= Date.parse(value)); return builder; },
        maybeSingle: async () => {
          const row = rows.find((candidate) => filters.every((filter) => filter(candidate))) ?? null;
          if (payload && row) { Object.assign(row, payload); updates += 1; }
          return { data: row ? structuredClone(row) : null, error: null };
        },
      };
      return builder;
    },
  };
  return db;
}

function run(overrides: Row = {}) {
  return {
    id: "radar-run-current", owner_id: "owner-1", status: "running", started_at: "2026-10-10T10:00:00.000Z",
    lease_token: "old-token", lease_until: new Date(Date.now() - 60_000).toISOString(),
    checkpoint: { sourceQueue: ["morizon", "olx"], currentSourceIndex: 0, sourceStatuses: { morizon: "pending", olx: "pending" }, sourceErrors: {}, perSourceCursor: {} },
    source_statuses: { morizon: "pending", olx: "pending" }, scanned_count: 12, qualified_count: 2, error_message: null,
    ...overrides,
  };
}

test("an expired lease is reclaimed by compare-and-set for the exact run ID and checkpoint", async () => {
  const db = fakeDb(run());
  const result = await resumeExistingRadarRun("owner-1", "radar-run-current", db as never);
  assert.equal(result.kind, "claimed");
  if (result.kind !== "claimed") return;
  assert.equal(result.run.id, "radar-run-current");
  assert.notEqual(result.run.leaseToken, "old-token");
  const claimedLeaseMs = Date.parse(result.run.leaseUntil ?? "") - Date.now();
  assert.ok(claimedLeaseMs > 70_000 && claimedLeaseMs <= 75_000, "resume should use the short, fenced lease that matches the portion budget");
  assert.equal(result.run.scannedCount, 12);
  assert.deepEqual(db.rows[0].checkpoint, run().checkpoint);
  assert.equal(db.updates, 1);
});

test("an expired run with its pointer at the end can still reclaim its pending rotated source", async () => {
  const checkpoint = {
    sourceQueue: ["morizon", "domiporta"], currentSourceIndex: 2,
    sourceStatuses: { morizon: "completed", domiporta: "pending" }, sourceErrors: {},
    perSourceCursor: { domiporta: { kind: "radar_detail_v1", page: 2, candidateIndex: 12 } },
  };
  const db = fakeDb(run({ checkpoint }));
  const result = await resumeExistingRadarRun("owner-1", "radar-run-current", db as never);
  assert.equal(result.kind, "claimed", "the same run remains resumable when the next pending source wraps around the rotated queue");
  if (result.kind !== "claimed") return;
  assert.equal(result.run.id, "radar-run-current");
  assert.deepEqual(db.rows[0]?.checkpoint, checkpoint, "reclaim does not reset or replace the source cursor");
  assert.equal(db.updates, 1);
});

test("an expired run at the end with two pending sources reclaims the same run without resetting either cursor", async () => {
  const checkpoint = {
    sourceQueue: ["morizon", "domiporta"], currentSourceIndex: 2,
    sourceStatuses: { morizon: "pending", domiporta: "pending" }, sourceErrors: {},
    perSourceCursor: { morizon: 3, domiporta: { kind: "radar_detail_v1", page: 4, candidateIndex: 12 } },
  };
  const db = fakeDb(run({ checkpoint }));
  const result = await resumeExistingRadarRun("owner-1", "radar-run-current", db as never);

  assert.equal(result.kind, "claimed", "the end pointer is valid as long as at least one queued source is unfinished");
  if (result.kind !== "claimed") return;
  assert.equal(result.run.id, "radar-run-current", "resume never creates a replacement run");
  assert.deepEqual(db.rows[0]?.checkpoint, checkpoint, "the reclaim preserves both pending statuses and each source's saved cursor");
  assert.notEqual(result.run.leaseToken, "old-token", "the resumed work is fenced by the newly claimed lease");
  assert.equal(db.updates, 1);
});

test("two resume requests for one expired run have one compare-and-set winner", async () => {
  const db = fakeDb(run());
  const results = await Promise.all([
    resumeExistingRadarRun("owner-1", "radar-run-current", db as never),
    resumeExistingRadarRun("owner-1", "radar-run-current", db as never),
  ]);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["blocked", "claimed"]);
  assert.equal(db.updates, 1);
  assert.equal(db.rows.length, 1, "resume must never insert a second full Radar run");
});

test("a live lease, terminal run, mismatched run ID, or active OLX queue source cannot be reclaimed", async (t) => {
  const cases: Array<[string, Row, string]> = [
    ["live lease", run({ lease_until: new Date(Date.now() + 60_000).toISOString() }), "lease_active"],
    ["terminal run", run({ status: "partial" }), "run_changed"],
    ["OLX queue source", run({ checkpoint: { sourceQueue: ["olx"], currentSourceIndex: 0, sourceStatuses: { olx: "running" }, sourceErrors: {}, perSourceCursor: {} } }), "olx_queue_owns_source"],
    ["OLX queue source behind rotated pointer", run({ checkpoint: { sourceQueue: ["morizon", "olx"], currentSourceIndex: 2, sourceStatuses: { morizon: "completed", olx: "running" }, sourceErrors: {}, perSourceCursor: {} } }), "olx_queue_owns_source"],
  ];
  for (const [label, row, reason] of cases) await t.test(label, async () => {
    const db = fakeDb(row);
    const result = await resumeExistingRadarRun("owner-1", "radar-run-current", db as never);
    assert.deepEqual(result, { kind: "blocked", reason });
    assert.equal(db.updates, 0);
  });
  const mismatched = fakeDb(run());
  assert.deepEqual(await resumeExistingRadarRun("owner-1", "another-run", mismatched as never), { kind: "blocked", reason: "run_changed" });
  assert.equal(mismatched.updates, 0);
});
