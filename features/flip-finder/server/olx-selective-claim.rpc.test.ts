/**
 * claim_olx_scan_job_selective in embedded PostgreSQL (PGlite), on top of the
 * real queue migration and the olx_scan_jobs columns Radar adds. The controlled
 * test claim must take only the named Finder job and leave every other row —
 * an older Radar job, an older job of another filter, an expired lease the
 * regular claim would recover — byte-for-byte unchanged.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const QUEUE = fs.readFileSync(path.join(MIGRATIONS, "20260810190000_create_olx_local_worker_queue.sql"), "utf8");
const RADAR = fs.readFileSync(path.join(MIGRATIONS, "20261008000000_create_price_radar.sql"), "utf8");
const SELECTIVE = fs.readFileSync(path.join(MIGRATIONS, "20261013180000_add_selective_olx_claim.sql"), "utf8");

const TEST_FILTER = "22222222-2222-4222-8222-222222222222";
const OTHER_FILTER = "33333333-3333-4333-8333-333333333333";
const OWNER = "00000000-0000-4000-8000-000000000001";

// The exact olx_scan_jobs changes made by the Radar migration, applied below.
const RADAR_QUEUE_CHANGES = [
  "alter column source_scan_id drop not null",
  "alter column search_filter_id drop not null",
  "add column if not exists context_type text not null default 'finder'",
  "add column if not exists radar_owner_id uuid",
  "add column if not exists radar_run_id uuid",
  "add column if not exists radar_lease_token uuid",
];

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users (id uuid primary key);
    insert into auth.users (id) values ('${OWNER}');
    create table public.search_filters (id uuid primary key);
    insert into public.search_filters (id) values ('${TEST_FILTER}'), ('${OTHER_FILTER}');
    create table public.source_scans (
      id uuid primary key default gen_random_uuid(),
      search_filter_id uuid not null references public.search_filters(id),
      status text not null default 'pending' constraint source_scans_status_check check (status in ('running','completed','failed','partial')),
      finished_at timestamptz, error_message text
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
  await db.exec(SELECTIVE);
  return db;
}

async function seed(db: PGlite) {
  const radarRun = "44444444-4444-4444-8444-444444444444";
  await db.exec(`insert into public.price_radar_runs (id) values ('${radarRun}')`);
  const scan = async (filter: string) => (await db.query<{ id: string }>(`insert into public.source_scans (search_filter_id) values ($1) returning id`, [filter])).rows[0].id;
  const insert = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows[0].id;
  const radar = await insert(`insert into public.olx_scan_jobs (scan_run_id, context_type, radar_owner_id, radar_run_id, radar_lease_token, request_url, idempotency_key, created_at)
    values ($1, 'price_radar', $2, $1, gen_random_uuid(), 'https://www.olx.pl/radar/', 'radar', now() - interval '3 minutes') returning id`, [radarRun, OWNER]);
  const other = await insert(`insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key, created_at)
    values (gen_random_uuid(), $1, $2, 'https://www.olx.pl/inny/', 'other', now() - interval '2 minutes') returning id`, [await scan(OTHER_FILTER), OTHER_FILTER]);
  // A job whose worker died: the REGULAR claim would re-queue it. The selective claim must not.
  const expired = await insert(`insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key, status, attempts, lease_token, leased_until, created_at)
    values (gen_random_uuid(), $1, $2, 'https://www.olx.pl/wygasly/', 'expired', 'running', 1, gen_random_uuid(), now() - interval '5 minutes', now() - interval '10 minutes') returning id`, [await scan(OTHER_FILTER), OTHER_FILTER]);
  const testScan = await scan(TEST_FILTER);
  const target = await insert(`insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key, created_at)
    values (gen_random_uuid(), $1, $2, 'https://www.olx.pl/test/', 'test', now()) returning id`, [testScan, TEST_FILTER]);
  // Another queued job of the SAME filter: naming one job id must not take the other one.
  const sibling = await insert(`insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key, created_at)
    values (gen_random_uuid(), $1, $2, 'https://www.olx.pl/siostra/', 'sibling', now() - interval '1 minute') returning id`, [await scan(TEST_FILTER), TEST_FILTER]);
  return { radar, other, expired, target, sibling, testScan };
}

async function snapshot(db: PGlite, ids: string[]) {
  return (await db.query(`select to_jsonb(j) as row from public.olx_scan_jobs j where id = any($1::uuid[]) order by created_at`, [ids])).rows;
}

const claim = (db: PGlite, jobId: string | null) => db.query<{ id: string; status: string; attempts: number; worker_id: string; lease_token: string | null }>(
  `select * from public.claim_olx_scan_job_selective('cloudflare-olx-stage2', $1::uuid, 120)`, [jobId]);

test("the Radar migration still makes exactly the olx_scan_jobs changes this test reproduces", () => {
  const normalized = RADAR.replace(/\s+/g, " ").toLowerCase();
  for (const change of RADAR_QUEUE_CHANGES) assert.ok(normalized.includes(change), change);
});

test("selective claim by job id: only that Finder job is leased; Radar, other-filter, same-filter and expired jobs stay untouched", async () => {
  const db = await database();
  try {
    const jobs = await seed(db);
    const others = [jobs.radar, jobs.other, jobs.expired, jobs.sibling];
    const before = await snapshot(db, others);
    const claimed = await claim(db, jobs.target);
    assert.equal(claimed.rows.length, 1);
    assert.deepEqual({ id: claimed.rows[0].id, status: claimed.rows[0].status, attempts: claimed.rows[0].attempts, worker: claimed.rows[0].worker_id }, { id: jobs.target, status: "running", attempts: 1, worker: "cloudflare-olx-stage2" });
    assert.ok(claimed.rows[0].lease_token);
    assert.deepEqual(await snapshot(db, others), before, "no other row changed");
    const scan = await db.query<{ status: string }>(`select status from public.source_scans where id = $1`, [jobs.testScan]);
    assert.equal(scan.rows[0].status, "running");

    // Re-running the test (e.g. a repeated workflow) claims nothing and still touches nothing.
    assert.equal((await claim(db, jobs.target)).rows.length, 0);
    assert.deepEqual(await snapshot(db, others), before);
  } finally {
    await db.close();
  }
});

test("Radar jobs, running jobs, exhausted jobs and unknown ids are never claimed", async () => {
  const db = await database();
  try {
    const jobs = await seed(db);
    const all = [jobs.radar, jobs.other, jobs.expired, jobs.target, jobs.sibling];
    const before = await snapshot(db, all);
    assert.equal((await claim(db, jobs.radar)).rows.length, 0, "Radar job named explicitly");
    assert.equal((await claim(db, jobs.expired)).rows.length, 0, "a running job (even with an expired lease)");
    assert.equal((await claim(db, "55555555-5555-4555-8555-555555555555")).rows.length, 0, "unknown id");
    assert.deepEqual(await snapshot(db, all), before);
    await db.query(`update public.olx_scan_jobs set attempts = max_attempts where id = $1`, [jobs.other]);
    assert.equal((await claim(db, jobs.other)).rows.length, 0, "no attempts left");
    await db.query(`update public.olx_scan_jobs set available_at = now() + interval '1 hour' where id = $1`, [jobs.sibling]);
    assert.equal((await claim(db, jobs.sibling)).rows.length, 0, "not yet available");
  } finally {
    await db.close();
  }
});

test("for comparison: the regular claim recovers other leases and takes the OLDEST job — why the test cannot use it", async () => {
  const db = await database();
  try {
    const jobs = await seed(db);
    const first = await db.query<{ id: string }>(`select * from public.claim_olx_scan_job('local-worker', 120)`);
    assert.equal(first.rows[0].id, jobs.expired, "it re-queued another worker's job and took it");
    const second = await db.query<{ id: string }>(`select * from public.claim_olx_scan_job('local-worker', 120)`);
    assert.equal(second.rows[0].id, jobs.radar);
  } finally {
    await db.close();
  }
});

test("input validation, and EXECUTE only for service_role", async () => {
  const db = await database();
  try {
    await assert.rejects(claim(db, null), /job_id is required/);
    await assert.rejects(db.query(`select * from public.claim_olx_scan_job_selective('x', gen_random_uuid(), 120)`), /worker_id is required/);
    await assert.rejects(db.query(`select * from public.claim_olx_scan_job_selective('cloudflare-olx-stage2', gen_random_uuid(), 5)`), /lease_seconds/);
    const privileges = await db.query<Record<string, boolean>>(`
      select has_function_privilege('anon','public.claim_olx_scan_job_selective(text,uuid,integer)','EXECUTE') as anon,
             has_function_privilege('authenticated','public.claim_olx_scan_job_selective(text,uuid,integer)','EXECUTE') as authenticated,
             has_function_privilege('service_role','public.claim_olx_scan_job_selective(text,uuid,integer)','EXECUTE') as service`);
    assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service: true });
  } finally {
    await db.close();
  }
});

test("the migration is additive: only one CREATE FUNCTION plus its grants", () => {
  const statements = SELECTIVE.replace(/--.*$/gm, "").replace(/\$\$[\s\S]*?\$\$/g, "$$BODY$$").split(";").map((part) => part.trim().toLowerCase()).filter(Boolean);
  assert.deepEqual(statements.map((statement) => statement.split(/\s+/).slice(0, 2).join(" ")), ["begin", "create or", "revoke all", "grant execute", "commit"]);
  assert.doesNotMatch(SELECTIVE.toLowerCase(), /\b(drop|alter table|truncate|delete from)\b/);
});
