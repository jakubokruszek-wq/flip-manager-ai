import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

/**
 * This test executes the real reserve_source_scans migration definition in an
 * embedded PostgreSQL engine.  PGlite is intentionally used only as a local
 * SQL harness; it does not contact Supabase or Production.
 */
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  const foundation = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260719113000_create_flip_finder_foundation.sql"), "utf8");
  // The migration's production grant/revoke is part of the SQL under test;
  // create the same role names in this throwaway database so that PostgreSQL
  // can execute those statements without any Supabase connection.
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(extractBlock(foundation, "create table if not exists public.search_filters (", "create index if not exists search_filters_active_last_scanned_at_idx\n  on public.search_filters (is_active, last_scanned_at);"));
  await db.exec(extractBlock(foundation, "create table if not exists public.source_scans (", "create index if not exists source_scans_search_filter_id_started_at_idx\n  on public.source_scans (search_filter_id, started_at desc);"));
  // pending is added by the existing local-worker schema migration before the
  // reservation function can insert its prepared rows.
  await db.exec("alter table public.source_scans drop constraint if exists source_scans_status_check; alter table public.source_scans add constraint source_scans_status_check check (status in ('pending', 'running', 'completed', 'failed', 'partial'));");
  await db.exec(fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260719131000_add_source_scan_diagnostics.sql"), "utf8"));
  await db.exec(fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20261004020000_add_manual_scan_reservation_lock.sql"), "utf8"));
  return db;
}

function extractBlock(sql: string, startMarker: string, endMarker: string): string {
  const start = sql.indexOf(startMarker);
  assert.ok(start >= 0, `missing migration marker: ${startMarker}`);
  const end = sql.indexOf(endMarker, start);
  assert.ok(end >= 0, `missing migration marker: ${endMarker}`);
  return sql.slice(start, end + endMarker.length);
}

const FILTER_ID = "00000000-0000-0000-0000-000000000031";
const FIRST_RUN_ID = "00000000-0000-0000-0000-000000000032";
const SECOND_RUN_ID = "00000000-0000-0000-0000-000000000033";

test("the real reserve_source_scans SQL creates one reservation and rejects a later active duplicate", async () => {
  const db = await freshDb();
  try {
    await db.query(
      `insert into public.search_filters (id, name, sources, scan_interval_minutes)
       values ($1, 'RPC reservation test', '["otodom"]'::jsonb, 60)`,
      [FILTER_ID],
    );

    const first = await db.query(
      `select * from public.reserve_source_scans($1::uuid, $2::text[], $3::uuid, $4::jsonb)`,
      [FILTER_ID, ["otodom"], FIRST_RUN_ID, JSON.stringify({ name: "RPC reservation test" })],
    );
    assert.equal(first.rows.length, 1, "the actual function must insert one pending source row");
    assert.equal((first.rows[0] as { scan_run_id?: string } | undefined)?.scan_run_id, FIRST_RUN_ID);

    await assert.rejects(
      db.query(
        `select * from public.reserve_source_scans($1::uuid, $2::text[], $3::uuid, $4::jsonb)`,
        [FILTER_ID, ["otodom"], SECOND_RUN_ID, JSON.stringify({ name: "duplicate" })],
      ),
      /SCAN_ALREADY_RUNNING/,
      "the actual function must refuse a later active reservation for the same filter/source",
    );

    const rows = await db.query<{ scan_run_id: string }>(
      "select scan_run_id from public.source_scans where search_filter_id = $1",
      [FILTER_ID],
    );
    assert.deepEqual(rows.rows.map((row) => row.scan_run_id), [FIRST_RUN_ID]);
  } finally {
    await db.close();
  }
});

test.todo("true overlapping reserve_source_scans calls require two independent PostgreSQL connections; PGlite's transaction/query APIs run through one exclusive embedded connection");
