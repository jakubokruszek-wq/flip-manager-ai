/**
 * claim_olx_scan_job_selective in embedded PostgreSQL (PGlite), on top of the
 * real queue migration (20260810190000) and Radar's olx_scan_jobs columns.
 * The trial claim must take only the named Finder job and leave every other
 * row — including an older Radar job, an older job of another filter and an
 * expired lease the regular claim would recover — byte-for-byte unchanged.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const ROOT = new URL("../../../", import.meta.url);
const QUEUE = readFileSync(new URL("supabase/migrations/20260810190000_create_olx_local_worker_queue.sql", ROOT), "utf8");
const SELECTIVE = readFileSync(new URL("supabase/migrations/20261013150000_add_selective_olx_claim.sql", ROOT), "utf8");

const TEST_FILTER = "22222222-2222-4222-8222-222222222222";
const OTHER_FILTER = "33333333-3333-4333-8333-333333333333";
const OWNER = "00000000-0000-4000-8000-000000000001";

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
  // Radar's changes to olx_scan_jobs (20261008000000_create_price_radar.sql).
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
  // A job whose worker died: the REGULAR claim would recover it (status -> queued). The trial must not.
  const expired = await insert(`insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key, status, attempts, lease_token, leased_until, created_at)
    values (gen_random_uuid(), $1, $2, 'https://www.olx.pl/wygasly/', 'expired', 'running', 1, gen_random_uuid(), now() - interval '5 minutes', now() - interval '10 minutes') returning id`, [await scan(OTHER_FILTER), OTHER_FILTER]);
  const testScan = await scan(TEST_FILTER);
  const target = await insert(`insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key, created_at)
    values (gen_random_uuid(), $1, $2, 'https://www.olx.pl/test/', 'test', now()) returning id`, [testScan, TEST_FILTER]);
  return { radar, other, expired, target, testScan };
}

async function snapshot(db: PGlite, ids: string[]) {
  return (await db.query(`select to_jsonb(j) as row from public.olx_scan_jobs j where id = any($1::uuid[]) order by created_at`, [ids])).rows;
}

for (const selector of ["filter", "job"] as const) {
  test(`selective claim by ${selector}: only the test job is leased; older Radar/other-filter/expired jobs stay untouched`, async () => {
    const db = await database();
    try {
      const jobs = await seed(db);
      const before = await snapshot(db, [jobs.radar, jobs.other, jobs.expired]);
      const claimed = await db.query<{ id: string; status: string; attempts: number; worker_id: string; lease_token: string | null }>(
        `select * from public.claim_olx_scan_job_selective('cloudflare-olx-1', $1::uuid, $2::uuid, 120)`,
        selector === "job" ? [jobs.target, null] : [null, TEST_FILTER],
      );
      assert.equal(claimed.rows.length, 1);
      assert.deepEqual({ id: claimed.rows[0].id, status: claimed.rows[0].status, attempts: claimed.rows[0].attempts, worker: claimed.rows[0].worker_id }, { id: jobs.target, status: "running", attempts: 1, worker: "cloudflare-olx-1" });
      assert.ok(claimed.rows[0].lease_token);
      assert.deepEqual(await snapshot(db, [jobs.radar, jobs.other, jobs.expired]), before, "no other row changed");
      const scan = await db.query<{ status: string }>(`select status from public.source_scans where id = $1`, [jobs.testScan]);
      assert.equal(scan.rows[0].status, "running");

      const again = await db.query(`select * from public.claim_olx_scan_job_selective('cloudflare-olx-1', $1::uuid, $2::uuid, 120)`, selector === "job" ? [jobs.target, null] : [null, TEST_FILTER]);
      assert.equal(again.rows.length, 0, "the same job cannot be claimed twice");
      assert.deepEqual(await snapshot(db, [jobs.radar, jobs.other, jobs.expired]), before);
    } finally {
      await db.close();
    }
  });
}

test("selective claim never takes a Radar job or a job of another filter, even when named explicitly", async () => {
  const db = await database();
  try {
    const jobs = await seed(db);
    const before = await snapshot(db, [jobs.radar, jobs.other, jobs.expired, jobs.target]);
    for (const [jobId, filterId] of [[jobs.radar, null], [null, "55555555-5555-4555-8555-555555555555"]] as const) {
      const result = await db.query(`select * from public.claim_olx_scan_job_selective('cloudflare-olx-1', $1::uuid, $2::uuid, 120)`, [jobId, filterId]);
      assert.equal(result.rows.length, 0);
    }
    assert.deepEqual(await snapshot(db, [jobs.radar, jobs.other, jobs.expired, jobs.target]), before);
  } finally {
    await db.close();
  }
});

test("for comparison: the regular claim recovers other leases and takes the OLDEST job — why the trial cannot use it", async () => {
  const db = await database();
  try {
    const jobs = await seed(db);
    // It first re-queues the other worker's expired job, then takes the oldest queued job (that one), then Radar.
    const first = await db.query<{ id: string }>(`select * from public.claim_olx_scan_job('local-worker', 120)`);
    assert.equal(first.rows[0].id, jobs.expired);
    const second = await db.query<{ id: string }>(`select * from public.claim_olx_scan_job('local-worker', 120)`);
    assert.equal(second.rows[0].id, jobs.radar);
  } finally {
    await db.close();
  }
});

test("selective claim validates its input and is executable only by service_role", async () => {
  const db = await database();
  try {
    await assert.rejects(db.query(`select * from public.claim_olx_scan_job_selective('cloudflare-olx-1', null, null, 120)`), /exactly one of job_id or search_filter_id/);
    await assert.rejects(db.query(`select * from public.claim_olx_scan_job_selective('cloudflare-olx-1', gen_random_uuid(), gen_random_uuid(), 120)`), /exactly one/);
    await assert.rejects(db.query(`select * from public.claim_olx_scan_job_selective('x', gen_random_uuid(), null, 120)`), /worker_id is required/);
    const privileges = await db.query<Record<string, boolean>>(`
      select has_function_privilege('anon','public.claim_olx_scan_job_selective(text,uuid,uuid,integer)','EXECUTE') as anon,
             has_function_privilege('authenticated','public.claim_olx_scan_job_selective(text,uuid,uuid,integer)','EXECUTE') as authenticated,
             has_function_privilege('service_role','public.claim_olx_scan_job_selective(text,uuid,uuid,integer)','EXECUTE') as service`);
    assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service: true });
  } finally {
    await db.close();
  }
});
