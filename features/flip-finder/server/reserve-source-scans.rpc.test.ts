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

// RESOLVED -- the gap this test.todo() used to mark is closed. The test
// directly above proves reserve_source_scans' SQL logic is correct, but
// PGlite runs every query through one exclusive embedded connection, so it
// was never able to prove -- and still cannot prove -- that the function's
// `select ... for update` row lock actually blocks a second, genuinely
// independent session. Do not read that test as concurrency proof.
//
// The real proof is scripts/reserve-source-scans-race.sh, run by
// .github/workflows/reserve-source-scans-concurrency.yml against a
// disposable `services: postgres:` container (never Production/Supabase):
// two real, independent psql connections, released from a shared barrier so
// neither can submit its call before both are ready, raced against the
// same search_filter_id. Confirmed green:
// https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/37368504544
// (run attempt 2; attempt 1 was cancelled mid-queue by a GitHub Actions
// platform incident before any step ran, unrelated to this code). Its log
// shows exactly one of the two concurrent calls winning, the other
// genuinely blocking on the row lock and then receiving the real
// SCAN_ALREADY_RUNNING error from Postgres itself, and exactly one
// source_scans row/scan_run_id surviving for the filter afterward.

// Local, always-runnable check that the CI artifacts above actually exist
// and are wired together correctly (right script, right migration paths,
// a real postgres service, two genuinely separate psql processes) --
// this is NOT the concurrency proof itself (it asserts file content, not
// database behavior), only a guard against the CI wiring silently rotting
// (a renamed script, a workflow that stops calling it, a typo'd path) now
// that the real proof above depends on it staying correct.
test("the real-Postgres concurrency CI workflow and script are present and correctly wired", () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "reserve-source-scans-concurrency.yml"), "utf8");
  assert.match(workflow, /image:\s*postgres:17/);
  assert.match(workflow, /POSTGRES_HOST_AUTH_METHOD:\s*trust/);
  assert.match(workflow, /pg_isready/);
  assert.match(workflow, /DATABASE_URL:\s*postgresql:\/\/postgres@127\.0\.0\.1:5432/);
  assert.match(workflow, /bash scripts\/reserve-source-scans-race\.sh/);
  assert.doesNotMatch(workflow, /supabase\.co|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_URL/i);

  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "reserve-source-scans-race.sh"), "utf8");
  assert.match(script, /DATABASE_URL is required/);
  assert.match(script, /20261004020000_add_manual_scan_reservation_lock\.sql/);
  // Two independently backgrounded psql processes released from one shared
  // file barrier -- not a single sequential call, and not a JS mutex.
  assert.match(script, /&\s*\n\s*local pid_a=\$!/);
  assert.match(script, /&\s*\n\s*local pid_b=\$!/);
  assert.match(script, /wait "\$pid_a"/);
  assert.match(script, /wait "\$pid_b"/);
  assert.match(script, /SCAN_ALREADY_RUNNING/);
  assert.doesNotMatch(script, /supabase\.co|SUPABASE_SERVICE_ROLE_KEY/i);
});
