import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

/**
 * Real PostgreSQL (PGlite) proof of the operational retention draft
 * (supabase/drafts/retention/01_add_finder_operational_retention.sql).
 * Production is never contacted. The schema below mirrors only the columns
 * of the production tables the retention functions read or write.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const RETENTION = path.join(ROOT, "supabase/drafts/retention/01_add_finder_operational_retention.sql");
const NONCE_GRANT = path.join(ROOT, "supabase/drafts/retention/02_fix_facebook_worker_nonce_cleanup_grant.sql");
const FILTER = "10000000-0000-4000-8000-000000000001";
const LISTING = "20000000-0000-4000-8000-000000000002";
const DEVICE = "30000000-0000-4000-8000-000000000003";

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.search_filters(id uuid primary key);
    create table public.listings(id uuid primary key, price numeric);
    create table public.listing_snapshots(id uuid primary key default gen_random_uuid(), listing_id uuid not null references public.listings(id) on delete cascade, captured_at timestamptz not null default now(), price numeric, raw_data jsonb not null default '{}'::jsonb);
    create table public.source_scans(
      id uuid primary key default gen_random_uuid(), search_filter_id uuid not null references public.search_filters(id) on delete cascade,
      source text not null, status text not null, started_at timestamptz not null, finished_at timestamptz,
      scan_run_id uuid, scanned_count integer not null default 0, matched_count integer not null default 0, new_count integer not null default 0,
      listings_created integer not null default 0, listings_updated integer not null default 0, price_drop_count integer not null default 0,
      warnings jsonb not null default '[]'::jsonb, diagnostics jsonb not null default '[]'::jsonb,
      filter_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(filter_snapshot) = 'object'),
      continuation_lease_until timestamptz);
    create table public.listing_filter_matches(listing_id uuid not null references public.listings(id), search_filter_id uuid not null references public.search_filters(id),
      is_current_match boolean not null default true, match_reasons jsonb not null default '[]'::jsonb,
      source_scan_id uuid references public.source_scans(id) on delete set null, primary key(listing_id, search_filter_id));
    create table public.olx_scan_jobs(id uuid primary key default gen_random_uuid(), source_scan_id uuid not null unique references public.source_scans(id) on delete cascade, status text not null);
    create table public.facebook_scan_jobs(id uuid primary key default gen_random_uuid(), source_scan_id uuid unique references public.source_scans(id) on delete cascade, status text not null);
    create table public.gallery_request_traces(id uuid primary key default gen_random_uuid(), listing_id uuid not null, created_at timestamptz not null default now());
    create table public.facebook_worker_nonces(nonce text primary key, created_at timestamptz not null default now(), expires_at timestamptz not null);
    create table public.olx_worker_nonces(nonce text primary key, expires_at timestamptz not null);
    create table public.collector_request_nonces(device_id uuid not null, nonce text not null, expires_at timestamptz not null, created_at timestamptz not null default now(), primary key(device_id, nonce));
    create table public.collector_scan_batches(id uuid primary key default gen_random_uuid(), device_id uuid not null, scan_id uuid not null, batch_id uuid not null,
      source_type text not null, status text not null, visible_card_count integer not null default 0, captured_post_count integer not null default 0,
      payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'), received_at timestamptz not null default now(), finished_at timestamptz);
    revoke all on all tables in schema public from anon, authenticated;
    grant insert, delete on table public.facebook_worker_nonces to service_role;
  `);
  await db.exec(fs.readFileSync(RETENTION, "utf8"));
  return db;
}

const ago = (days: number) => `now() - interval '${days} days'`;

async function seed(db: PGlite): Promise<void> {
  await db.exec(`
    insert into public.search_filters(id) values ('${FILTER}');
    insert into public.listings(id, price) values ('${LISTING}', 269000);
    insert into public.listing_snapshots(listing_id, captured_at, price, raw_data) values
      ('${LISTING}', ${ago(200)}, 289000, '{"sourcePublishedAt":"2026-03-01T10:00:00Z"}'),
      ('${LISTING}', ${ago(100)}, 279000, '{}'), ('${LISTING}', ${ago(1)}, 269000, '{}');
    insert into public.gallery_request_traces(listing_id, created_at) values
      ('${LISTING}', ${ago(30)}), ('${LISTING}', ${ago(20)}), ('${LISTING}', ${ago(15)}), ('${LISTING}', ${ago(2)});
    insert into public.facebook_worker_nonces(nonce, expires_at) values
      ('expired-old', ${ago(3)}), ('expired-old-2', ${ago(1)}), ('expired-recent', now() - interval '10 minutes'), ('valid', now() + interval '5 minutes');
    insert into public.olx_worker_nonces(nonce, expires_at) values ('olx-expired', ${ago(2)}), ('olx-valid', now() + interval '5 minutes');
    insert into public.collector_request_nonces(device_id, nonce, expires_at) values ('${DEVICE}', 'c-expired', ${ago(2)}), ('${DEVICE}', 'c-valid', now() + interval '5 minutes');
    insert into public.collector_scan_batches(device_id, scan_id, batch_id, source_type, status, visible_card_count, captured_post_count, payload, received_at, finished_at) values
      ('${DEVICE}', gen_random_uuid(), gen_random_uuid(), 'GROUP', 'completed', 10, 9, '{"posts":["a large payload"]}', ${ago(120)}, ${ago(120)}),
      ('${DEVICE}', gen_random_uuid(), gen_random_uuid(), 'GROUP', 'completed', 8, 8, '{"posts":["b"]}', ${ago(20)}, ${ago(20)}),
      ('${DEVICE}', gen_random_uuid(), gen_random_uuid(), 'GROUP', 'degraded', 5, 2, '{"posts":["c"]}', ${ago(3)}, ${ago(3)}),
      ('${DEVICE}', gen_random_uuid(), gen_random_uuid(), 'GROUP', 'processing', 4, 1, '{"posts":["in flight"]}', ${ago(40)}, null);
    insert into public.source_scans(id, search_filter_id, source, status, started_at, finished_at, scanned_count, matched_count, new_count, filter_snapshot, diagnostics) values
      ('a0000000-0000-4000-8000-000000000001', '${FILTER}', 'otodom', 'completed', ${ago(60)}, ${ago(60)}, 100, 3, 1, '{"big":"snapshot"}', '[{"d":1}]'),
      ('a0000000-0000-4000-8000-000000000002', '${FILTER}', 'otodom', 'failed', ${ago(50)}, ${ago(50)}, 40, 0, 0, '{"big":"snapshot"}', '[]'),
      ('a0000000-0000-4000-8000-000000000003', '${FILTER}', 'otodom', 'completed', ${ago(45)}, ${ago(45)}, 90, 2, 0, '{"big":"snapshot"}', '[]'),
      ('a0000000-0000-4000-8000-000000000004', '${FILTER}', 'olx', 'completed', ${ago(70)}, ${ago(70)}, 10, 1, 1, '{"big":"snapshot"}', '[]'),
      ('a0000000-0000-4000-8000-000000000005', '${FILTER}', 'olx', 'completed', ${ago(65)}, ${ago(65)}, 12, 1, 0, '{"big":"snapshot"}', '[]'),
      ('a0000000-0000-4000-8000-000000000006', '${FILTER}', 'otodom', 'running', ${ago(40)}, null, 0, 0, 0, '{"_scanProgress":{}}', '[]'),
      ('a0000000-0000-4000-8000-000000000007', '${FILTER}', 'otodom', 'completed', ${ago(2)}, ${ago(2)}, 80, 4, 0, '{"recent":"snapshot"}', '[]');
    -- scan 3 is the provenance of a saved membership; scan 4 has a queued OLX job.
    insert into public.listing_filter_matches(listing_id, search_filter_id, source_scan_id) values ('${LISTING}', '${FILTER}', 'a0000000-0000-4000-8000-000000000003');
    insert into public.olx_scan_jobs(source_scan_id, status) values ('a0000000-0000-4000-8000-000000000004', 'queued');
  `);
}

async function rows<T>(db: PGlite, sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}

test("retention functions are service-role only, security definer with a fixed search_path, and applying the draft deletes nothing", async () => {
  const db = await database();
  try {
    await seed(db);
    const before = await rows<{ count: number }>(db, "select count(*)::int as count from public.gallery_request_traces");
    assert.equal(before[0].count, 4);
    const grants = await rows<Record<string, boolean>>(db, `select
      has_function_privilege('anon', 'public.finder_retention_run(boolean,integer,integer)', 'EXECUTE') anon_run,
      has_function_privilege('authenticated', 'public.finder_retention_run(boolean,integer,integer)', 'EXECUTE') auth_run,
      has_function_privilege('authenticated', 'public.finder_retention_report()', 'EXECUTE') auth_report,
      has_function_privilege('service_role', 'public.finder_retention_run(boolean,integer,integer)', 'EXECUTE') service_run,
      has_function_privilege('service_role', 'public.finder_retention_report()', 'EXECUTE') service_report,
      has_table_privilege('authenticated', 'public.finder_retention_runs', 'SELECT') auth_runs_select`);
    assert.deepEqual(grants[0], { anon_run: false, auth_run: false, auth_report: false, service_run: true, service_report: true, auth_runs_select: false });
    const fn = await rows<{ prosecdef: boolean; proconfig: string[] }>(db, "select prosecdef, proconfig from pg_proc where oid = 'public.finder_retention_run(boolean,integer,integer)'::regprocedure");
    assert.equal(fn[0].prosecdef, true);
    assert.ok(fn[0].proconfig.includes("search_path=public"));
  } finally { await db.close(); }
});

test("the dry-run report counts eligible and protected rows and the dry run changes nothing", async () => {
  const db = await database();
  try {
    await seed(db);
    const report = await rows<{ table_name: string; action: string; eligible_rows: number; protected_rows: number }>(db, "select table_name, action, eligible_rows::int, protected_rows::int from public.finder_retention_report()");
    const find = (table: string, action: string) => report.find((row) => row.table_name === table && row.action === action);
    assert.equal(find("gallery_request_traces", "delete")?.eligible_rows, 3);
    assert.equal(find("facebook_worker_nonces", "delete")?.eligible_rows, 2, "a nonce expired 10 minutes ago is still inside the 1-hour margin");
    assert.equal(find("collector_scan_batches", "compact_payload")?.eligible_rows, 2);
    assert.equal(find("collector_scan_batches", "delete")?.eligible_rows, 1);
    assert.equal(find("collector_scan_batches", "compact_payload")?.protected_rows, 1, "an in-flight batch is protected");
    assert.equal(find("source_scans", "delete")?.eligible_rows, 2, "scans 1 and 2 only: 3 is membership provenance, 4 has a queued job, 5 is the latest OLX scan");
    assert.equal(find("listing_snapshots", "keep")?.eligible_rows, 0, "price history is never eligible");

    await db.exec("set role service_role");
    const dryRun = await rows<{ table_name: string; affected_rows: number; dry_run: boolean }>(db, "select table_name, affected_rows::int, dry_run from public.finder_retention_run(true, 500, 10)");
    assert.ok(dryRun.every((row) => row.dry_run === true));
    await db.exec("reset role");
    const counts = await rows<Record<string, number>>(db, `select
      (select count(*)::int from public.gallery_request_traces) traces,
      (select count(*)::int from public.facebook_worker_nonces) nonces,
      (select count(*)::int from public.source_scans) scans,
      (select count(*)::int from public.collector_scan_batches where payload ? 'compacted_at') compacted,
      (select count(*)::int from public.finder_retention_runs where dry_run) dry_runs`);
    assert.deepEqual(counts[0], { traces: 4, nonces: 4, scans: 7, compacted: 0, dry_runs: 1 });
  } finally { await db.close(); }
});

test("a real run removes only eligible operational rows, keeps price history, active work and provenance, and aggregates what it deletes", async () => {
  const db = await database();
  try {
    await seed(db);
    const snapshotsBefore = await rows(db, "select id, listing_id, captured_at, price, raw_data from public.listing_snapshots order by captured_at");
    await db.exec("set role service_role");
    const run = await rows<{ table_name: string; action: string; affected_rows: number }>(db, "select table_name, action, affected_rows::int from public.finder_retention_run(false, 500, 10)");
    await db.exec("reset role");
    const affected = (table: string, action: string) => run.find((row) => row.table_name === table && row.action === action)?.affected_rows;
    assert.equal(affected("gallery_request_traces", "delete"), 3);
    assert.equal(affected("facebook_worker_nonces", "delete"), 2);
    assert.equal(affected("olx_worker_nonces", "delete"), 1);
    assert.equal(affected("collector_request_nonces", "delete"), 1);
    assert.equal(affected("source_scans", "delete"), 2);

    assert.deepEqual(await rows(db, "select id, listing_id, captured_at, price, raw_data from public.listing_snapshots order by captured_at"), snapshotsBefore, "price history is byte-for-byte unchanged");
    const nonces = (await rows<{ nonce: string }>(db, "select nonce from public.facebook_worker_nonces order by nonce")).map((row) => row.nonce);
    assert.deepEqual(nonces, ["expired-recent", "valid"]);
    const scans = (await rows<{ id: string }>(db, "select id from public.source_scans order by id")).map((row) => row.id.slice(-1));
    assert.deepEqual(scans, ["3", "4", "5", "6", "7"], "membership provenance, queued job, latest per source, running and recent scans survive");
    const membership = await rows<{ source_scan_id: string }>(db, "select source_scan_id from public.listing_filter_matches");
    assert.equal(membership[0].source_scan_id, "a0000000-0000-4000-8000-000000000003");
    assert.equal((await rows<{ count: number }>(db, "select count(*)::int as count from public.olx_scan_jobs"))[0].count, 1, "an active worker job is never cascaded away");
    const running = await rows<{ filter_snapshot: unknown }>(db, "select filter_snapshot from public.source_scans where status = 'running'");
    assert.deepEqual(running[0].filter_snapshot, { _scanProgress: {} }, "a running scan is never compacted");
    const compactedOld = await rows<{ compacted: boolean }>(db, "select filter_snapshot ? 'compacted_at' as compacted from public.source_scans where id = 'a0000000-0000-4000-8000-000000000003'");
    assert.equal(compactedOld[0].compacted, true, "an old kept scan loses only its bulky JSON diagnostics");
    const recent = await rows<{ filter_snapshot: unknown }>(db, "select filter_snapshot from public.source_scans where id = 'a0000000-0000-4000-8000-000000000007'");
    assert.deepEqual(recent[0].filter_snapshot, { recent: "snapshot" });

    const stats = await rows<{ scans: number; completed: number; failed: number; scanned_count: number }>(db, "select sum(scans)::int scans, sum(completed)::int completed, sum(failed)::int failed, sum(scanned_count)::int scanned_count from public.finder_scan_daily_stats");
    assert.deepEqual(stats[0], { scans: 2, completed: 1, failed: 1, scanned_count: 140 }, "deleted scans are preserved as daily statistics");
    const batches = await rows<{ status: string; compacted: boolean; payload: unknown }>(db, "select status, payload ? 'compacted_at' as compacted, payload from public.collector_scan_batches order by received_at");
    assert.deepEqual(batches.map((row) => [row.status, row.compacted]), [["processing", false], ["completed", true], ["degraded", false]]);
    assert.deepEqual(batches[0].payload, { posts: ["in flight"] }, "an in-flight batch payload is untouched");
    const batchStats = await rows<{ batches: number; captured: number }>(db, "select sum(batches)::int batches, sum(captured_post_count)::int captured from public.finder_collector_batch_daily_stats");
    assert.deepEqual(batchStats[0], { batches: 1, captured: 9 });
    const log = await rows<{ dry_run: boolean; finished: boolean; before: Record<string, number>; after: Record<string, number> }>(db, "select dry_run, finished_at is not null finished, table_bytes_before before, table_bytes_after after from public.finder_retention_runs");
    assert.equal(log[0].dry_run, false);
    assert.equal(log[0].finished, true);
    assert.ok(typeof log[0].before.source_scans === "number" && typeof log[0].after.source_scans === "number", "every run records sizes before and after");

    // Idempotent: a second run finds nothing more to do.
    await db.exec("set role service_role");
    const second = await rows<{ affected_rows: number }>(db, "select affected_rows::int from public.finder_retention_run(false, 500, 10)");
    assert.ok(second.every((row) => row.affected_rows === 0));
  } finally { await db.close(); }
});

test("each run is bounded by batch size and batch count, so a large backlog is removed in small steps", async () => {
  const db = await database();
  try {
    await seed(db);
    await db.exec(`insert into public.gallery_request_traces(listing_id, created_at) select '${LISTING}', now() - interval '40 days' from generate_series(1, 25)`);
    await db.exec("set role service_role");
    const first = await rows<{ table_name: string; affected_rows: number }>(db, "select table_name, affected_rows::int from public.finder_retention_run(false, 5, 2)");
    assert.equal(first.find((row) => row.table_name === "gallery_request_traces")?.affected_rows, 10, "2 batches of 5");
    await db.exec("reset role");
    assert.equal((await rows<{ count: number }>(db, "select count(*)::int as count from public.gallery_request_traces"))[0].count, 4 + 25 - 10);
  } finally { await db.close(); }
});

test("the nonce grant fix lets the application's own cleanup DELETE ... WHERE expires_at run as service_role", async () => {
  const db = await database();
  try {
    await seed(db);
    await db.exec("set role service_role");
    await assert.rejects(db.query("delete from public.facebook_worker_nonces where expires_at < now()"), /permission denied/u, "without SELECT on expires_at the cleanup fails, exactly as observed");
    await db.exec("reset role");
    await db.exec(fs.readFileSync(NONCE_GRANT, "utf8"));
    await db.exec("set role service_role");
    const deleted = await db.query("delete from public.facebook_worker_nonces where expires_at < now()");
    assert.equal(deleted.affectedRows, 3);
    await assert.rejects(db.query("select created_at from public.facebook_worker_nonces"), /permission denied/u, "the grant is column-scoped");
  } finally { await db.close(); }
});
