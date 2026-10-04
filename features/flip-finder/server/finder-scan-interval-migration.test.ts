import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const foundationPath = path.join(process.cwd(), "supabase/migrations/20260719113000_create_flip_finder_foundation.sql");
const draftPath = path.join(process.cwd(), "supabase/migrations/20261004123000_add_finder_scan_interval.sql");

function searchFiltersTable(sql: string): string {
  const start = sql.indexOf("create table if not exists public.search_filters (");
  const endMarker = "create index if not exists search_filters_active_last_scanned_at_idx\n  on public.search_filters (is_active, last_scanned_at);";
  const end = sql.indexOf(endMarker, start);
  assert.ok(start >= 0 && end >= 0);
  return sql.slice(start, end + endMarker.length);
}

async function databaseWithDraft(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(searchFiltersTable(fs.readFileSync(foundationPath, "utf8")));
  await db.exec(fs.readFileSync(draftPath, "utf8"));
  return db;
}

test("Finder interval draft adds only its own durable column and positive constraint", async () => {
  const sql = fs.readFileSync(draftPath, "utf8");
  assert.match(sql, /add column if not exists finder_scan_interval_minutes integer not null default 60/i);
  assert.match(sql, /search_filters_finder_scan_interval_positive/i);
  assert.match(sql, /check \(finder_scan_interval_minutes > 0\)/i);
  assert.doesNotMatch(sql, /scan_interval_minutes\s*=/i, "the Watcher interval must not be rewritten");

  const db = await databaseWithDraft();
  const row = await db.query(
    `insert into public.search_filters
      (name, sources, city, districts, rooms, building_types, ownership_types, required_keywords, excluded_keywords, scan_interval_minutes, finder_scan_interval_minutes, is_active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning scan_interval_minutes, finder_scan_interval_minutes`,
    ["Finder", JSON.stringify(["otodom"]), "Łódź", JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), 30, 45, true],
  );
  assert.deepEqual(row.rows[0], { scan_interval_minutes: 30, finder_scan_interval_minutes: 45 });
  await assert.rejects(
    () => db.query(
      `insert into public.search_filters
        (name, sources, city, districts, rooms, building_types, ownership_types, required_keywords, excluded_keywords, scan_interval_minutes, finder_scan_interval_minutes, is_active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      ["Invalid", JSON.stringify(["otodom"]), "Łódź", JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), 30, 0, true],
    ),
    (error: unknown) => {
      assert.match(String(error), /search_filters_finder_scan_interval_positive/);
      return true;
    },
  );
});
