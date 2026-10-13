/**
 * enqueue_scheduled_finder_olx_job in embedded PostgreSQL (PGlite), on top of
 * the real OLX queue migration, the olx_scan_jobs columns Radar adds and the
 * new schedule migration. Time is moved by shifting stored timestamps
 * backwards (the function always uses the database clock, as in Production).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const QUEUE = fs.readFileSync(path.join(MIGRATIONS, "20260810190000_create_olx_local_worker_queue.sql"), "utf8");
const SCHEDULE = fs.readFileSync(path.join(MIGRATIONS, "20261014120000_add_finder_olx_schedule.sql"), "utf8");
const ROLLBACK = fs.readFileSync(path.join(process.cwd(), "scripts/finder-olx-schedule.rollback.sql"), "utf8");

const FLIP = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const OLX_ONLY = "55555555-5555-4555-8555-555555555555";
const OWNER = "00000000-0000-4000-8000-000000000001";
const URL = "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/";

type Decision = Record<string, unknown> & { decision: string; reason: string | null };

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users (id uuid primary key);
    insert into auth.users (id) values ('${OWNER}');
    create table public.search_filters (
      id uuid primary key, is_active boolean not null default true, sources jsonb not null default '[]'::jsonb,
      finder_scan_interval_minutes integer not null default 300, last_scanned_at timestamptz
    );
    insert into public.search_filters (id, sources) values
      ('${FLIP}', '["otodom","gratka","olx"]'), ('${OTHER}', '["olx","morizon"]'), ('${OLX_ONLY}', '["olx"]');
    create table public.source_scans (
      id uuid primary key default gen_random_uuid(),
      search_filter_id uuid not null references public.search_filters(id),
      source text not null, status text not null default 'pending', scan_run_id uuid, filter_snapshot jsonb,
      started_at timestamptz not null default now(), finished_at timestamptz, error_message text,
      constraint source_scans_status_check check (status in ('pending','running','completed','failed','partial'))
    );
    create table public.price_radar_runs (id uuid primary key);
  `);
  await db.exec(QUEUE);
  await db.exec(`
    alter table public.olx_scan_jobs alter column source_scan_id drop not null, alter column search_filter_id drop not null;
    alter table public.olx_scan_jobs add column if not exists context_type text not null default 'finder';
    alter table public.olx_scan_jobs add column if not exists radar_owner_id uuid references auth.users(id);
    alter table public.olx_scan_jobs add column if not exists radar_run_id uuid references public.price_radar_runs(id);
    alter table public.olx_scan_jobs add column if not exists radar_lease_token uuid;
  `);
  await db.exec(SCHEDULE);
  return db;
}

async function schedule(db: PGlite, filter = FLIP, options: { shared?: number; dryRun?: boolean } = {}): Promise<Decision> {
  const result = await db.query<{ result: Decision }>(
    `select public.enqueue_scheduled_finder_olx_job($1, gen_random_uuid(), $2, $3::jsonb, $4, $5) as result`,
    [filter, URL, JSON.stringify({ id: filter }), options.shared ?? 1, options.dryRun ?? false],
  );
  return result.rows[0].result;
}

/** Moves every stored OLX timestamp back, i.e. lets `hours` pass. */
async function elapse(db: PGlite, hours: number) {
  await db.exec(`
    update public.olx_scan_jobs set created_at = created_at - interval '${hours} hours',
      started_at = started_at - interval '${hours} hours', finished_at = finished_at - interval '${hours} hours';
    update public.source_scans set started_at = started_at - interval '${hours} hours';
  `);
}

async function finishAll(db: PGlite, status: "completed" | "failed" = "completed") {
  await db.exec(`update public.olx_scan_jobs set status = '${status}', finished_at = now() where status in ('queued','running');
    update public.source_scans set status = '${status}' where status in ('pending','running');`);
}

async function jobs(db: PGlite) {
  return (await db.query<{ search_filter_id: string; requested_by: string | null; status: string }>(`select search_filter_id, requested_by, status from public.olx_scan_jobs order by created_at`)).rows;
}

test("first call queues exactly one automatic job with a pending OLX source scan", async () => {
  const db = await database();
  const result = await schedule(db);
  assert.equal(result.decision, "enqueued");
  assert.equal(result.reason, null);
  assert.equal(result.interval_minutes, 1440);
  assert.equal(result.automatic_jobs_in_window, 1);
  const rows = await jobs(db);
  assert.deepEqual(rows, [{ search_filter_id: FLIP, requested_by: "scheduler", status: "queued" }]);
  const scans = (await db.query<{ source: string; status: string }>(`select source, status from public.source_scans`)).rows;
  assert.deepEqual(scans, [{ source: "olx", status: "pending" }]);
});

test("no second OLX job before 24 h, even after the first one completed; exactly one after 24 h", async () => {
  const db = await database();
  assert.equal((await schedule(db)).decision, "enqueued");
  assert.equal((await schedule(db)).reason, "OLX_JOB_IN_FLIGHT");
  await finishAll(db);
  for (const hours of [5, 5, 5, 5]) { // 07:30 -> 12:30 -> 17:30 -> 22:30 -> 03:30 (date change)
    await elapse(db, hours);
    const skipped = await schedule(db);
    assert.equal(skipped.decision, "skipped");
    assert.equal(skipped.reason, "OLX_INTERVAL_NOT_ELAPSED");
  }
  await elapse(db, 4); // 24 h after the ORDER of the first job
  assert.equal((await schedule(db)).decision, "enqueued");
  assert.equal((await jobs(db)).length, 2);
});

test("next allowed time is counted from when the job was ordered, not from its late completion", async () => {
  const db = await database();
  await schedule(db);
  await elapse(db, 12);
  await finishAll(db); // finished 12 h after it was ordered
  const status = await schedule(db, FLIP, { dryRun: true });
  assert.equal(status.reason, "OLX_INTERVAL_NOT_ELAPSED");
  const lastOrdered = Date.parse(String(status.last_job_at));
  assert.equal(Date.parse(String(status.next_allowed_at)) - lastOrdered, 24 * 3_600_000);
  await elapse(db, 12);
  assert.equal((await schedule(db)).decision, "enqueued");
});

test("a 48 h interval waits 48 h; the budget is shared by every filter", async () => {
  const db = await database();
  await db.exec(`update public.search_filters set finder_olx_scan_interval_minutes = 2880 where id = '${FLIP}'`);
  assert.equal((await schedule(db, FLIP)).decision, "enqueued");
  await finishAll(db);
  // Another filter is due by its own interval, but the global automatic budget is used.
  const other = await schedule(db, OTHER);
  assert.equal(other.reason, "AUTOMATIC_DAILY_BUDGET_USED");
  await elapse(db, 24);
  assert.equal((await schedule(db, FLIP)).reason, "OLX_INTERVAL_NOT_ELAPSED");
  assert.equal((await schedule(db, OTHER)).decision, "enqueued");
  await finishAll(db);
  await elapse(db, 24);
  assert.equal((await schedule(db, FLIP)).decision, "enqueued");
});

test("database refuses an OLX interval shorter than 24 h", async () => {
  const db = await database();
  await assert.rejects(db.exec(`update public.search_filters set finder_olx_scan_interval_minutes = 300 where id = '${FLIP}'`), /search_filters_finder_olx_scan_interval_min/);
});

test("manual Finder jobs and Price Radar jobs use the shared budget without being changed", async () => {
  const db = await database();
  const scan = (await db.query<{ id: string }>(`insert into public.source_scans (search_filter_id, source, status) values ($1, 'olx', 'completed') returning id`, [OTHER])).rows[0].id;
  await db.query(`insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key, status)
    values (gen_random_uuid(), $1, $2, $3, 'manual', 'completed')`, [scan, OTHER, URL]);
  const blocked = await schedule(db, FLIP);
  assert.equal(blocked.reason, "SHARED_DAILY_BUDGET_USED");
  assert.equal(blocked.finder_other_jobs_in_window, 1);
  // A larger, separately configured shared budget lets the automatic job through.
  assert.equal((await schedule(db, FLIP, { shared: 2 })).decision, "enqueued");

  const radarDb = await database();
  const run = "44444444-4444-4444-8444-444444444444";
  await radarDb.exec(`insert into public.price_radar_runs (id) values ('${run}')`);
  await radarDb.query(`insert into public.olx_scan_jobs (scan_run_id, context_type, radar_owner_id, radar_run_id, radar_lease_token, request_url, idempotency_key, status, worker_id, started_at)
    values ($1, 'price_radar', $2, $1, gen_random_uuid(), $3, 'radar', 'completed', 'cloudflare-olx-stage2', now())`, [run, OWNER, URL]);
  const radarBlocked = await schedule(radarDb, FLIP);
  assert.equal(radarBlocked.reason, "SHARED_DAILY_BUDGET_USED");
  assert.equal(radarBlocked.radar_jobs_in_window, 1);
  assert.equal(radarBlocked.cloudflare_jobs_in_window, 1);
  const radarRow = (await radarDb.query<{ status: string; requested_by: string | null }>(`select status, requested_by from public.olx_scan_jobs where context_type = 'price_radar'`)).rows[0];
  assert.deepEqual(radarRow, { status: "completed", requested_by: null });
  await elapse(radarDb, 24);
  assert.equal((await schedule(radarDb, FLIP)).decision, "enqueued");
});

test("a failed automatic job keeps its budget: re-running the scheduler does not retry it", async () => {
  const db = await database();
  await schedule(db);
  await finishAll(db, "failed");
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await schedule(db)).decision, "skipped");
  assert.equal((await jobs(db)).length, 1);
});

test("parallel calls for several filters queue one automatic job in total", async () => {
  const db = await database();
  const results = await Promise.all([schedule(db, FLIP), schedule(db, OTHER), schedule(db, OLX_ONLY), schedule(db, FLIP)]);
  assert.equal(results.filter((result) => result.decision === "enqueued").length, 1);
  assert.equal((await jobs(db)).length, 1);
});

test("a stuck OLX row of the filter (queue inconsistency) blocks only a new OLX job", async () => {
  const db = await database();
  await db.query(`insert into public.source_scans (search_filter_id, source, status) values ($1, 'olx', 'pending')`, [FLIP]);
  assert.equal((await schedule(db)).reason, "OLX_JOB_IN_FLIGHT");
  assert.equal((await jobs(db)).length, 0);
});

test("dry run reports the decision and writes nothing", async () => {
  const db = await database();
  const result = await schedule(db, FLIP, { dryRun: true });
  assert.equal(result.decision, "due");
  assert.equal(result.job_id, null);
  assert.equal((await jobs(db)).length, 0);
});

test("inactive filters and filters without OLX are skipped", async () => {
  const db = await database();
  await db.exec(`update public.search_filters set is_active = false where id = '${OTHER}'; update public.search_filters set sources = '["otodom"]' where id = '${OLX_ONLY}'`);
  assert.equal((await schedule(db, OTHER)).reason, "FILTER_INACTIVE");
  assert.equal((await schedule(db, OLX_ONLY)).reason, "OLX_NOT_SELECTED");
  assert.equal((await schedule(db, "99999999-9999-4999-8999-999999999999")).reason, "FILTER_NOT_FOUND");
});

test("shared limit is validated; anon and authenticated cannot execute the function", async () => {
  const db = await database();
  await assert.rejects(schedule(db, FLIP, { shared: 0 }), /p_shared_limit/);
  await assert.rejects(schedule(db, FLIP, { shared: 21 }), /p_shared_limit/);
  const grants = (await db.query<{ grantee: string }>(`select grantee from information_schema.routine_privileges where routine_name = 'enqueue_scheduled_finder_olx_job' order by grantee`)).rows.map((row) => row.grantee);
  assert.ok(grants.includes("service_role"));
  assert.ok(!grants.includes("anon") && !grants.includes("authenticated") && !grants.includes("PUBLIC"));
});

test("state is durable: a new connection after a restart sees the same budget", async () => {
  const db = await database();
  assert.equal((await schedule(db)).decision, "enqueued");
  // The data directory reopened by a new instance = application/database restart.
  const dump = await db.dumpDataDir();
  await db.close();
  const restarted = await PGlite.create({ loadDataDir: dump });
  assert.equal((await schedule(restarted)).reason, "OLX_JOB_IN_FLIGHT");
  await finishAll(restarted);
  assert.equal((await schedule(restarted)).reason, "OLX_INTERVAL_NOT_ELAPSED");
});

test("rollback removes only what the migration added", async () => {
  const db = await database();
  await schedule(db);
  await db.exec(ROLLBACK);
  const columns = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name in ('search_filters','olx_scan_jobs') and column_name in ('finder_olx_scan_interval_minutes','requested_by')`)).rows;
  assert.deepEqual(columns, []);
  assert.equal((await db.query(`select 1 from pg_proc where proname = 'enqueue_scheduled_finder_olx_job'`)).rows.length, 0);
  assert.equal((await jobs(db)).length, 1, "existing OLX jobs are kept");
  // Re-applying the migration after a rollback works (idempotent draft).
  await db.exec(SCHEDULE);
  await db.exec(SCHEDULE);
});
