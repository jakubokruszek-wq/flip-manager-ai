import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { SearchFilterInput } from "../search-filter-contract.ts";

/**
 * "Rok budowy od" criterion, save path. year_built_min's own migration
 * (supabase/migrations/20261004030000_add_year_built_criterion.sql) is a
 * DRAFT, not applied here or anywhere by this change. writeSearchFilter
 * must never assume it is live -- it only ever reacts to the exact
 * "column does not exist" error Postgres/PostgREST report for it, falling
 * back to the pre-existing payload shape so every OTHER field a user saves
 * still goes through untouched, exactly like reserve_source_scans'
 * RPC-missing fallback in manual-scan.ts.
 */

type WriteResult = { data: Record<string, unknown> | null; error: { code: string; message: string } | null };

const baseRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Flip", sources: ["otodom"], city: "Łódź", districts: [],
  price_min: null, price_max: null, area_min: null, area_max: null, rooms: [],
  floor_min: null, floor_max: null, exclude_ground_floor: false, exclude_top_floor: false,
  building_types: [], ownership_types: [], market_type: null, private_only: false,
  max_price_per_sqm: null, required_keywords: [], excluded_keywords: [],
  min_flip_score: null, min_estimated_profit: null, max_estimated_renovation_cost: null,
  scan_interval_minutes: 60, is_active: true,
  last_scanned_at: null, created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:00:00Z",
};

const baseInput: SearchFilterInput = {
  name: "Flip", sources: ["otodom"], city: "Łódź", districts: [],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [],
  floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false,
  buildingTypes: [], ownershipTypes: [], marketType: null, privateOnly: false,
  maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [],
  minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60, isActive: true,
};

type Mode = "normal" | "missing-column" | "real-error";
let mode: Mode = "normal";
let insertCalls: Record<string, unknown>[] = [];

function fakeAdminClient() {
  return {
    from(table: string) {
      assert.equal(table, "search_filters");
      return {
        insert(payload: Record<string, unknown>) {
          insertCalls.push(payload);
          return {
            select: () => ({
              async single(): Promise<WriteResult> {
                if (mode === "real-error") {
                  return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
                }
                if (mode === "missing-column" && "year_built_min" in payload) {
                  return { data: null, error: { code: "PGRST204", message: "Could not find the 'year_built_min' column of 'search_filters' in the schema cache" } };
                }
                return { data: { ...baseRow, ...payload }, error: null };
              },
            }),
          };
        },
      };
    },
  };
}

mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: fakeAdminClient } });
const { createSearchFilter } = await import("./search-filters.ts");

test("saving a filter with yearBuiltMin sends year_built_min in the insert payload", async () => {
  mode = "normal";
  insertCalls = [];
  const saved = await createSearchFilter({ ...baseInput, yearBuiltMin: 1950 });
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0]?.year_built_min, 1950);
  assert.equal(saved.yearBuiltMin, 1950);
});

test("if year_built_min does not exist yet (draft migration not applied), the save still succeeds and every other field is preserved -- only the new criterion is silently not persisted for that retry", async () => {
  mode = "missing-column";
  insertCalls = [];
  const saved = await createSearchFilter({ ...baseInput, name: "Flip with a year filter", yearBuiltMin: 1950 });
  assert.equal(insertCalls.length, 2, "must retry exactly once, without year_built_min, after the column-missing error");
  assert.ok(!("year_built_min" in insertCalls[1]!), "the retried payload must not include the missing column at all");
  assert.equal(insertCalls[1]?.name, "Flip with a year filter", "every other field must still reach the retried insert unchanged");
  assert.equal(saved.name, "Flip with a year filter");
  assert.equal(saved.yearBuiltMin, null, "falls back to null (not persisted) rather than throwing and losing the whole save");
});

test("a real database error unrelated to year_built_min is never swallowed by the fallback", async () => {
  mode = "real-error";
  insertCalls = [];
  await assert.rejects(() => createSearchFilter({ ...baseInput, yearBuiltMin: 1950 }), /duplicate key/);
  assert.equal(insertCalls.length, 1, "a genuine, unrelated database error must never trigger the missing-column retry");
});
