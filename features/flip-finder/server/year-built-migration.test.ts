import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

/**
 * Real, database-level schema-compatibility check for the DRAFT "Rok budowy
 * od" migration (supabase/migrations/20261004030000_add_year_built_criterion.sql
 * -- not applied anywhere, including here: PGlite is a throwaway, in-memory
 * engine, not Supabase/Production). Runs the ACTUAL migration SQL (not a
 * hand-written re-description of it) against a real, embedded Postgres
 * engine, on top of the real foundation tables, proving the column and
 * check-constraint syntax is valid and behaves as the application code
 * (search-filters.ts, persist-listing.ts) assumes -- before a human ever
 * applies it for real. Mirrors search-filters-schema.test.ts's own approach
 * and stated scope (schema/constraint/type compatibility only, not
 * GRANT/RLS).
 */

function extractBlock(sql: string, startMarker: string, endMarker: string): string {
  const start = sql.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = sql.indexOf(endMarker, start);
  assert.ok(end >= 0, `end marker not found: ${endMarker}`);
  return sql.slice(start, end + endMarker.length);
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  const foundation = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260719113000_create_flip_finder_foundation.sql"), "utf8");
  const draft = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20261004030000_add_year_built_criterion.sql"), "utf8");

  await db.exec(extractBlock(
    foundation,
    "create table if not exists public.search_filters (",
    "create index if not exists search_filters_active_last_scanned_at_idx\n  on public.search_filters (is_active, last_scanned_at);",
  ));
  await db.exec(extractBlock(
    foundation,
    "create table if not exists public.listings (",
    "create index if not exists listings_city_district_idx\n  on public.listings (city, district);",
  ));
  // The draft's own begin/commit wrapper is dropped -- this single exec call
  // is already one PGlite statement batch, and the real migration runner
  // (not exercised here) owns transactional semantics for the real thing.
  await db.exec(extractBlock(draft, "alter table public.search_filters", "check (year_built is null or (year_built >= 1700 and year_built <= 2100));"));

  return db;
}

test("the draft migration's year_built_min column and range constraint apply cleanly on top of the real search_filters foundation", async () => {
  const db = await freshDb();
  const result = await db.query(
    `insert into public.search_filters (name, sources, city, districts, rooms, building_types, ownership_types, required_keywords, excluded_keywords, scan_interval_minutes, is_active, year_built_min)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning year_built_min`,
    ["Flip", JSON.stringify(["otodom"]), "Łódź", JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), 60, true, 1950],
  );
  assert.equal((result.rows[0] as Record<string, unknown>)?.year_built_min, 1950);
});

test("search_filters.year_built_min accepts null (no criterion set)", async () => {
  const db = await freshDb();
  const result = await db.query(
    `insert into public.search_filters (name, sources, city, districts, rooms, building_types, ownership_types, required_keywords, excluded_keywords, scan_interval_minutes, is_active, year_built_min)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning year_built_min`,
    ["Flip", JSON.stringify(["otodom"]), "Łódź", JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), 60, true, null],
  );
  assert.equal((result.rows[0] as Record<string, unknown>)?.year_built_min, null);
});

test("an implausible year_built_min (e.g. 1500) is rejected by the real check constraint", async () => {
  const db = await freshDb();
  await assert.rejects(
    () => db.query(
      `insert into public.search_filters (name, sources, city, districts, rooms, building_types, ownership_types, required_keywords, excluded_keywords, scan_interval_minutes, is_active, year_built_min)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      ["Flip", JSON.stringify(["otodom"]), "Łódź", JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), 60, true, 1500],
    ),
    (error: unknown) => {
      assert.match((error as Error).message, /search_filters_year_built_min_range/);
      return true;
    },
  );
});

test("the draft migration's listings.year_built column and range constraint apply cleanly, and persist-listing.ts's exact payload shape round-trips 1897", async () => {
  const db = await freshDb();
  const result = await db.query(
    `insert into public.listings (source, external_listing_id, original_url, images, year_built)
     values ($1, $2, $3, $4, $5) returning year_built`,
    ["otodom", "offer-1", "https://allegrolokalnie.pl/oferta/offer-1", JSON.stringify([]), 1897],
  );
  assert.equal((result.rows[0] as Record<string, unknown>)?.year_built, 1897);
});

test("listings.year_built accepts null (source has no explicit label)", async () => {
  const db = await freshDb();
  const result = await db.query(
    `insert into public.listings (source, external_listing_id, original_url, images, year_built)
     values ($1, $2, $3, $4, $5) returning year_built`,
    ["otodom", "offer-2", "https://gratka.pl/oferta/offer-2", JSON.stringify([]), null],
  );
  assert.equal((result.rows[0] as Record<string, unknown>)?.year_built, null);
});

test("an implausible listings.year_built (e.g. 50) is rejected by the real check constraint", async () => {
  const db = await freshDb();
  await assert.rejects(
    () => db.query(
      `insert into public.listings (source, external_listing_id, original_url, images, year_built)
       values ($1, $2, $3, $4, $5)`,
      ["otodom", "offer-3", "https://allegrolokalnie.pl/oferta/offer-3", JSON.stringify([]), 50],
    ),
    (error: unknown) => {
      assert.match((error as Error).message, /listings_year_built_range/);
      return true;
    },
  );
});
