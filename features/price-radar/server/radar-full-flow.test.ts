import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Full-flow proof the mission asked for by name: adapter data ->
 * qualification -> persist -> stats -> (UI reads via getRadarResults) ->
 * exclusion -> recomputed stats -> refresh. One shared fake database behind
 * both the admin client (collect.ts's writes) and the regular client
 * (radar-results.ts/radar-exclusion.ts's reads/updates), proving these are
 * not just independently-mocked units but a real, connected pipeline.
 */

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
        abortSignal: () => builder,
        range: async () => ({ data: rows.filter((row) => filters.every((filter) => filter(row))), error: null }),
        insert: (value: Row) => { op = "insert"; payload = value; return builder; },
        update: (value: Row) => { op = "update"; payload = value; return builder; },
        upsert: (value: Row, options?: { onConflict?: string }) => { op = "upsert"; payload = value; onConflict = options?.onConflict?.split(",") ?? null; return builder; },
        maybeSingle: async () => {
          if (op === "insert" && payload) {
            if (payload.status && ["pending", "running"].includes(String(payload.status)) && rows.some((row) => ["pending", "running"].includes(String(row.status)))) {
              return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
            const row = { id: `run-${++seq}`, started_at: new Date().toISOString(), finished_at: null, status: "running", scanned_count: 0, qualified_count: 0, error_message: null, ...payload };
            rows.push(row);
            return { data: row, error: null };
          }
          if (op === "update" && payload) {
            const matched = rows.filter((row) => filters.every((filter) => filter(row)));
            for (const row of matched) Object.assign(row, payload);
            return { data: matched[0] ?? null, error: null };
          }
          return { data: rows.find((row) => filters.every((filter) => filter(row))) ?? null, error: null };
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
            // Real callers never set price_radar_listings.first_seen_at
            // explicitly on creation -- it relies on the real column's
            // DEFAULT now() (see the draft migration), which this fake must
            // simulate for a genuinely new row only, never for an update to
            // an existing one.
            const row = index >= 0
              ? Object.assign(rows[index], payload)
              : (() => { const created = { id: `listing-${++seq}`, first_seen_at: new Date().toISOString(), excluded_at: null, excluded_reason: null, ...payload }; rows.push(created); return created; })();
            return { data: row, error: null };
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

let db: ReturnType<typeof fakeDb>;
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => db } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => db } });
mock.module("@/features/flip-finder/server/search-source-registry", {
  namedExports: {
    SOURCES: [
      {
        id: "domiporta", label: "Domiporta", fetch: async () => ({
          listings: [{
            source: "domiporta", externalListingId: "flow-1", originalUrl: "https://domiporta.pl/flow-1", normalizedUrl: "https://domiporta.pl/flow-1",
            title: "Mieszkanie w bloku, Łódź Bałuty", description: "Po generalnym remoncie, nowe instalacje, gotowe do zamieszkania. Rynek wtórny.",
            price: 450_000, area: 50, pricePerSqm: 9_000, rooms: 2, floor: null, city: "Łódź", district: "Bałuty",
            buildingType: null, locationText: "Bałuty, Łódź", thumbnailUrl: null, images: [], publishedAt: null,
            rawPayload: {}, contentHash: "hash-flow-1",
          }],
          warnings: [], fetched: 1,
        }),
      },
    ],
  },
});

const { claimOrCreateRadarRun, runRadarCollectionPortion } = await import("./collect.ts");
const { getRadarResults } = await import("./radar-results.ts");
const { excludeRadarListing, restoreRadarListing } = await import("./radar-exclusion.ts");

test("full flow: adapter data -> qualification -> persist -> stats -> UI read -> exclude -> recomputed stats -> refresh -> restore", async () => {
  db = fakeDb();
  const filters = { districts: ["Bałuty"], market: "both" as const, areaMin: null, areaMax: null, rooms: [], sources: [] };

  // 1) Collection: adapter data -> qualification -> persist.
  const claimed = await claimOrCreateRadarRun(db as never);
  assert.equal(claimed.kind, "claimed");
  if (claimed.kind !== "claimed") return;
  const portion = await runRadarCollectionPortion(claimed.run.id, db as never);
  assert.equal(portion.status, "completed");
  assert.equal(portion.qualifiedCount, 1, "the one real, qualifying adapter candidate must be persisted");

  // 2) Stats / UI read.
  const before = await getRadarResults(filters);
  assert.equal(before.listings.length, 1);
  assert.equal(before.excludedListings.length, 0);
  assert.equal(before.stats.length, 1);
  assert.equal(before.stats[0].sampleSize, 1);
  assert.equal(before.stats[0].averagePricePerSqm, 9_000);
  const listingId = before.listings[0].id;

  // 3) Exclude -> stats recompute immediately.
  const excludeResult = await excludeRadarListing(listingId, "poza budżetem");
  assert.deepEqual(excludeResult, { ok: true });
  const afterExclude = await getRadarResults(filters);
  assert.equal(afterExclude.listings.length, 0, "the excluded listing must disappear from the visible sample");
  assert.equal(afterExclude.excludedListings.length, 1);
  assert.equal(afterExclude.stats.length, 0, "an empty sample is simply absent, not a zero-filled group");

  // 4) A second collection run (re-collection) must NOT un-exclude it.
  const secondClaim = await claimOrCreateRadarRun(db as never);
  assert.equal(secondClaim.kind, "claimed", "the first run completed, so a new one is allowed");
  if (secondClaim.kind === "claimed") {
    await runRadarCollectionPortion(secondClaim.run.id, db as never);
  }
  const afterRecollection = await getRadarResults(filters);
  assert.equal(afterRecollection.listings.length, 0, "re-collection must never silently restore an excluded listing");
  assert.equal(afterRecollection.excludedListings.length, 1);

  // 5) Manual restore -> back in the sample, stats recompute again.
  const restoreResult = await restoreRadarListing(listingId);
  assert.deepEqual(restoreResult, { ok: true });
  const afterRestore = await getRadarResults(filters);
  assert.equal(afterRestore.listings.length, 1);
  assert.equal(afterRestore.excludedListings.length, 0);
  assert.equal(afterRestore.stats[0].sampleSize, 1);
});
