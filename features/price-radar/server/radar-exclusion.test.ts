import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;

function fakeDb(rows: Row[]) {
  return {
    rows,
    from(table: string) {
      assert.equal(table, "price_radar_listings");
      const filters: Array<(row: Row) => boolean> = [];
      let payload: Row | null = null;
      const builder: Row = {
        update: (value: Row) => { payload = value; return builder; },
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        select: () => builder,
        maybeSingle: async () => {
          const matched = rows.filter((row) => filters.every((filter) => filter(row)));
          if (payload) for (const row of matched) Object.assign(row, payload);
          return { data: matched[0] ?? null, error: null };
        },
      };
      return builder;
    },
  };
}

let currentDb: ReturnType<typeof fakeDb>;
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => currentDb } });
const { excludeRadarListing, restoreRadarListing } = await import("./radar-exclusion.ts");

test("excludeRadarListing sets excluded_at/excluded_reason on the matching row", async () => {
  currentDb = fakeDb([{ id: "listing-1", excluded_at: null, excluded_reason: null }]);
  const result = await excludeRadarListing("listing-1", "poza budżetem");
  assert.deepEqual(result, { ok: true });
  assert.ok(currentDb.rows[0].excluded_at);
  assert.equal(currentDb.rows[0].excluded_reason, "poza budżetem");
});

test("excludeRadarListing on a nonexistent id reports not_found, never throws", async () => {
  currentDb = fakeDb([]);
  const result = await excludeRadarListing("missing", null);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("restoreRadarListing clears excluded_at/excluded_reason", async () => {
  currentDb = fakeDb([{ id: "listing-1", excluded_at: "2026-10-01T00:00:00Z", excluded_reason: "poza budżetem" }]);
  const result = await restoreRadarListing("listing-1");
  assert.deepEqual(result, { ok: true });
  assert.equal(currentDb.rows[0].excluded_at, null);
  assert.equal(currentDb.rows[0].excluded_reason, null);
});
