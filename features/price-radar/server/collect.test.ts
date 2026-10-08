import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;

function fakeDb(initial: { runs?: Row[]; listings?: Row[] } = {}) {
  const tables: Record<string, Row[]> = { price_radar_runs: initial.runs ?? [], price_radar_listings: initial.listings ?? [] };
  let seq = 0;
  return {
    tables,
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
            if (payload.status && ["pending", "running"].includes(String(payload.status)) && rows.some((row) => ["pending", "running"].includes(String(row.status)))) {
              return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
            const row = { id: `run-${++seq}`, started_at: new Date().toISOString(), finished_at: null, status: "running", scanned_count: 0, qualified_count: 0, error_message: null, ...payload };
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

let fakeSourceImpl: (id: string) => Promise<{ listings: unknown[]; warnings: string[]; fetched: number }>;
mock.module("@/features/flip-finder/server/search-source-registry", {
  namedExports: {
    SOURCES: [
      { id: "domiporta", label: "Domiporta", fetch: async () => fakeSourceImpl("domiporta") },
      { id: "olx", label: "OLX", fetch: async () => fakeSourceImpl("olx") },
    ],
  },
});

const { claimOrCreateRadarRun, runRadarCollectionPortion, RADAR_SOURCES } = await import("./collect.ts");

function qualifyingListing(id: string, source: string) {
  return {
    source, externalListingId: id, originalUrl: `https://example.test/${id}`, normalizedUrl: `https://example.test/${id}`,
    title: "Mieszkanie w bloku, Łódź Bałuty", description: "Po generalnym remoncie, nowe instalacje, gotowe do zamieszkania. Rynek wtórny.",
    price: 450_000, area: 50, pricePerSqm: 9_000, rooms: 2, city: "Łódź", district: "Bałuty",
    buildingType: null, floor: null, locationText: "Bałuty, Łódź", thumbnailUrl: null, images: [], publishedAt: null,
    rawPayload: {}, contentHash: `hash-${id}`,
  };
}

test("claimOrCreateRadarRun creates exactly one run and reports a concurrent attempt as already_active/blocked, never a second row", async () => {
  const db = fakeDb();
  const first = await claimOrCreateRadarRun(db as never);
  assert.equal(first.kind, "claimed");
  if (first.kind === "claimed") {
    assert.deepEqual(first.run.checkpoint.sourceQueue, RADAR_SOURCES, "a new run's checkpoint seeds the full, real schema-ready source queue");
  }
  const second = await claimOrCreateRadarRun(db as never);
  assert.equal(second.kind, "already_active");
  assert.equal(db.tables.price_radar_runs.length, 1);
});

// RADAR_SOURCES is the real, full SCHEMA_READY_SOURCE_IDS list (14 entries)
// -- unaffected by this file's SOURCES mock, which only stubs 2 for test
// simplicity. Every id in RADAR_SOURCES without a mocked SOURCES entry is
// gracefully skipped (collect.ts's `if (!source) { ...continue; }`), so
// exactly the 2 mocked sources are ever actually scanned here. In real
// (non-test) operation every RADAR_SOURCES id does have a SOURCES entry
// (confirmed: search-source-registry.ts's SOURCES is a strict superset of
// SCHEMA_READY_SOURCE_IDS), so this gap never occurs outside this fixture.
const MOCKED_SOURCE_COUNT = 2;

test("runRadarCollectionPortion processes every mocked source, persists qualified listings, and marks the run completed", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id) => ({ listings: [qualifyingListing(`${id}-1`, id), qualifyingListing(`${id}-2`, id)], warnings: [], fetched: 2 });
  const claimed = await claimOrCreateRadarRun(db as never);
  assert.equal(claimed.kind, "claimed");
  if (claimed.kind !== "claimed") return;

  const result = await runRadarCollectionPortion(claimed.run.id, db as never);
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
  const claimed = await claimOrCreateRadarRun(db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");
  const result = await runRadarCollectionPortion(claimed.run.id, db as never);
  assert.equal(result.qualifiedCount, 0);
  assert.equal(db.tables.price_radar_listings.length, 0);
  assert.equal(result.scannedCount, MOCKED_SOURCE_COUNT);
});

test("one source's fetch failure is isolated -- the run still completes and other sources' listings are still saved", async () => {
  const db = fakeDb();
  fakeSourceImpl = async (id) => {
    if (id === "domiporta") throw new Error("network error");
    return { listings: [qualifyingListing(`${id}-ok`, id)], warnings: [], fetched: 1 };
  };
  const claimed = await claimOrCreateRadarRun(db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");
  const result = await runRadarCollectionPortion(claimed.run.id, db as never);
  assert.equal(result.status, "completed");
  assert.equal(db.tables.price_radar_listings.length, MOCKED_SOURCE_COUNT - 1);
});

test("re-collecting the same listing preserves a prior exclusion -- persistRadarListing's upsert never writes excluded_at/excluded_reason", async () => {
  const db = fakeDb({
    listings: [{ id: "existing-1", source: "domiporta", external_listing_id: "domiporta-1", excluded_at: "2026-10-01T00:00:00Z", excluded_reason: "poza budżetem" }],
  });
  fakeSourceImpl = async (id) => (id === "domiporta" ? { listings: [qualifyingListing("1", "domiporta")], warnings: [], fetched: 1 } : { listings: [], warnings: [], fetched: 0 });
  const claimed = await claimOrCreateRadarRun(db as never);
  if (claimed.kind !== "claimed") throw new Error("expected claimed");
  await runRadarCollectionPortion(claimed.run.id, db as never);
  const row = db.tables.price_radar_listings.find((listing) => listing.id === "existing-1");
  assert.ok(row);
  assert.equal(row.excluded_at, "2026-10-01T00:00:00Z", "a re-collection must never clear a prior exclusion");
  assert.equal(row.excluded_reason, "poza budżetem");
});
