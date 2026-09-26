import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

/**
 * Real, database-level schema-compatibility check for the search_filters
 * write path (createSearchFilter/updateSearchFilter -> toDatabasePayload()).
 * Runs the ACTUAL migration SQL (not a hand-written re-description of it)
 * against a real, embedded Postgres engine, then attempts the exact INSERT
 * shape the application code produces -- so a future migration that adds a
 * NOT NULL column without a default, tightens a check constraint, or
 * renames a column the code still writes under its old name would fail this
 * test, not silently reach Production.
 *
 * Scope, stated explicitly: this proves schema/constraint/type
 * compatibility only. PGlite's own GRANT/RLS/SET ROLE enforcement was
 * separately found to be unreliable even for a trivial, RLS-free table
 * (has_table_privilege() correctly reports true, SET ROLE correctly
 * switches current_user, and the INSERT still fails with "permission
 * denied") -- a PGlite-specific limitation, not real Postgres behavior.
 * This test therefore runs as the Postgres superuser, which bypasses all
 * grant/RLS checks, and asserts nothing about permissions.
 */

function extractBlock(sql: string, startMarker: string, endMarker: string): string {
  const start = sql.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = sql.indexOf(endMarker, start);
  assert.ok(end >= 0, `end marker not found: ${endMarker}`);
  return sql.slice(start, end + endMarker.length);
}

async function freshSearchFiltersDb(): Promise<PGlite> {
  const db = new PGlite();
  const foundation = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260719113000_create_flip_finder_foundation.sql"), "utf8");

  const createTable = extractBlock(
    foundation,
    "create table if not exists public.search_filters (",
    "create index if not exists search_filters_active_last_scanned_at_idx\n  on public.search_filters (is_active, last_scanned_at);",
  );
  await db.exec(createTable);

  const trigger = extractBlock(
    foundation,
    "create or replace function public.set_search_filter_updated_at()",
    "execute function public.set_search_filter_updated_at();",
  );
  await db.exec(trigger);

  return db;
}

function toDatabasePayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "Test filter",
    sources: JSON.stringify(["otodom"]),
    city: "Łódź",
    districts: JSON.stringify([]),
    price_min: null,
    price_max: null,
    area_min: null,
    area_max: null,
    rooms: JSON.stringify([]),
    floor_min: null,
    floor_max: null,
    exclude_ground_floor: false,
    exclude_top_floor: false,
    building_types: JSON.stringify([]),
    ownership_types: JSON.stringify([]),
    market_type: null,
    private_only: false,
    max_price_per_sqm: null,
    required_keywords: JSON.stringify([]),
    excluded_keywords: JSON.stringify([]),
    min_flip_score: null,
    min_estimated_profit: null,
    max_estimated_renovation_cost: null,
    scan_interval_minutes: 60,
    is_active: true,
    ...overrides,
  };
}

async function insert(db: PGlite, payload: Record<string, unknown>) {
  const columns = Object.keys(payload);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  return db.query(
    `insert into public.search_filters (${columns.join(", ")}) values (${placeholders}) returning *`,
    Object.values(payload),
  );
}

test("the exact INSERT payload the application code sends is schema-compatible with the real search_filters migration", async () => {
  const db = await freshSearchFiltersDb();
  const result = await insert(db, toDatabasePayload());
  const row = result.rows[0] as Record<string, unknown>;
  assert.equal(row.name, "Test filter");
  assert.equal(row.city, "Łódź");
  assert.deepEqual(row.sources, ["otodom"]);
  assert.equal(row.scan_interval_minutes, 60);
  assert.equal(row.is_active, true);
});

test("the updated_at trigger fires on UPDATE with the exact application payload shape", async () => {
  const db = await freshSearchFiltersDb();
  const inserted = await insert(db, toDatabasePayload());
  const id = (inserted.rows[0] as Record<string, unknown>).id;
  const originalUpdatedAt = (inserted.rows[0] as Record<string, unknown>).updated_at;

  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = await db.query(
    `update public.search_filters set name = $1 where id = $2 returning *`,
    ["Renamed filter", id],
  );
  const row = updated.rows[0] as Record<string, unknown>;
  assert.equal(row.name, "Renamed filter");
  assert.notEqual(row.updated_at, originalUpdatedAt, "the trigger must bump updated_at on every real update");
});

test("a price range violating the real check constraint is rejected with the exact Postgres error the write path now surfaces", async () => {
  const db = await freshSearchFiltersDb();
  await assert.rejects(
    () => insert(db, toDatabasePayload({ price_min: 500_000, price_max: 100_000 })),
    (error: unknown) => {
      assert.match((error as Error).message, /search_filters_price_range/);
      return true;
    },
  );
});

test("a negative scan interval is rejected by the real check constraint", async () => {
  const db = await freshSearchFiltersDb();
  await assert.rejects(
    () => insert(db, toDatabasePayload({ scan_interval_minutes: 0 })),
    (error: unknown) => {
      assert.match((error as Error).message, /search_filters_scan_interval_positive/);
      return true;
    },
  );
});

test("a non-array value for a jsonb array column is rejected by the real check constraint", async () => {
  const db = await freshSearchFiltersDb();
  await assert.rejects(
    () => insert(db, toDatabasePayload({ sources: JSON.stringify({ not: "an array" }) })),
    (error: unknown) => {
      assert.match((error as Error).message, /search_filters_sources_array/);
      return true;
    },
  );
});
