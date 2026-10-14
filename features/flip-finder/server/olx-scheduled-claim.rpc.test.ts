/**
 * claim_scheduled_finder_olx_job / expire_stale_scheduled_finder_olx_jobs in
 * PGlite on top of the real OLX queue, the PR #15 schedule migration and the
 * new scheduled-claim migration. Time passes by shifting stored timestamps.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";

import { database, elapseMinutes, onlyActive, FLIP, OTHER, OWNER, URL } from "./finder-olx-schedule.fixture.ts";

const CLAIM = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20261015120000_add_scheduled_olx_claim.sql"), "utf8");
const ROLLBACK = fs.readFileSync(path.join(process.cwd(), "scripts/olx-cloud-scheduled.rollback.sql"), "utf8");
const STOP = fs.readFileSync(path.join(process.cwd(), "scripts/olx-cloud-scheduled.stop.sql"), "utf8");
const ENABLE = fs.readFileSync(path.join(process.cwd(), "scripts/olx-cloud-scheduled.enable.sql"), "utf8");

type Claim = { job: Record<string, unknown> | null; reason: string | null };

async function db(enabled = true): Promise<PGlite> {
  const instance = await database();
  await onlyActive(instance, FLIP, OTHER);
  await instance.exec(CLAIM);
  if (enabled) await instance.exec(ENABLE);
  return instance;
}

async function schedule(instance: PGlite, filter = FLIP) {
  return (await instance.query<{ r: Record<string, unknown> }>(`select public.enqueue_scheduled_finder_olx_job($1, gen_random_uuid(), $2, '{}'::jsonb, 5, false) as r`, [filter, URL])).rows[0].r;
}

async function claim(instance: PGlite, worker = "cloudflare-olx-scheduled"): Promise<Claim> {
  return (await instance.query<{ r: Claim }>(`select public.claim_scheduled_finder_olx_job($1, 120) as r`, [worker])).rows[0].r;
}

async function manualJob(instance: PGlite, filter = FLIP, status = "queued") {
  const scan = (await instance.query<{ id: string }>(`insert into public.source_scans (search_filter_id, source, status) values ($1, 'olx', 'pending') returning id`, [filter])).rows[0].id;
  return (await instance.query<{ id: string }>(`insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key, status)
    values (gen_random_uuid(), $1, $2, $3, gen_random_uuid()::text, $4) returning id`, [scan, filter, URL, status])).rows[0].id;
}

async function jobs(instance: PGlite) {
  return (await instance.query<{ id: string; status: string; requested_by: string | null; attempts: number; error_code: string | null; worker_id: string | null }>(
    `select id, status, requested_by, attempts, error_code, worker_id from public.olx_scan_jobs order by created_at`)).rows;
}

test("created disabled: nothing is handed out until the database switch is on", async () => {
  const instance = await db(false);
  await schedule(instance);
  assert.deepEqual(await claim(instance), { job: null, reason: "AUTOMATION_DISABLED" });
  assert.equal((await jobs(instance))[0].status, "queued");
  await instance.exec(ENABLE);
  assert.equal((await claim(instance)).job?.status, "running");
});

test("claims only the automatic Finder job, with a lease like the regular claim, and its source scan starts", async () => {
  const instance = await db();
  const manual = await manualJob(instance, OTHER);
  const run = "44444444-4444-4444-8444-444444444444";
  await instance.exec(`insert into public.price_radar_runs (id) values ('${run}')`);
  await instance.query(`insert into public.olx_scan_jobs (scan_run_id, context_type, radar_owner_id, radar_run_id, radar_lease_token, request_url, idempotency_key)
    values ($1, 'price_radar', $2, $1, gen_random_uuid(), $3, 'radar')`, [run, OWNER, URL]);
  await schedule(instance);
  const result = await claim(instance);
  assert.equal(result.reason, null);
  assert.equal(result.job?.requested_by, "scheduler");
  assert.equal(result.job?.worker_id, "cloudflare-olx-scheduled");
  assert.equal(result.job?.attempts, 1);
  assert.ok(result.job?.lease_token && result.job?.leased_until);
  const rows = await jobs(instance);
  assert.equal(rows.find((row) => row.id === manual)?.status, "queued", "manual Finder job is never taken");
  assert.equal(rows.filter((row) => row.requested_by === null && row.status === "queued").length, 2, "Radar and manual jobs untouched");
  const scan = (await instance.query<{ status: string }>(`select s.status from public.source_scans s join public.olx_scan_jobs j on j.source_scan_id = s.id where j.id = $1`, [result.job?.id])).rows[0];
  assert.equal(scan.status, "running");
});

test("one claim per rolling 24 h; nothing in parallel; no duplicate from concurrent calls", async () => {
  const instance = await db();
  await schedule(instance, FLIP);
  const results = await Promise.all([claim(instance), claim(instance), claim(instance)]);
  assert.equal(results.filter((result) => result.job).length, 1);
  assert.ok(results.some((result) => result.reason === "OLX_JOB_RUNNING"), "the others see the running job");
  // Another due automatic job while the first runs (forced in to test the guard).
  await instance.exec(`update public.olx_scan_jobs set status = 'completed', leased_until = null where status = 'running'`);
  await elapseMinutes(instance, 5);
  const forcedScan = (await instance.query<{ id: string }>(`insert into public.source_scans (search_filter_id, source, status) values ($1, 'olx', 'pending') returning id`, [OTHER])).rows[0].id;
  await instance.query(`insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key, requested_by)
    values (gen_random_uuid(), $1, $2, $3, 'forced', 'scheduler')`, [forcedScan, OTHER, URL]);
  assert.equal((await claim(instance)).reason, "DAILY_CLAIM_USED");
  await elapseMinutes(instance, 24 * 60);
  assert.equal((await claim(instance)).reason, "NO_DUE_JOB", "the forced job aged out with the clock; nothing else is due");
});

test("a running job of any context (Radar, manual, local worker) blocks the scheduled claim", async () => {
  const instance = await db();
  await schedule(instance);
  const manual = await manualJob(instance, OTHER, "running");
  await instance.query(`update public.olx_scan_jobs set leased_until = now() + interval '2 minutes', worker_id = 'local-windows' where id = $1`, [manual]);
  assert.equal((await claim(instance)).reason, "OLX_JOB_RUNNING");
  await instance.query(`update public.olx_scan_jobs set leased_until = now() - interval '1 minute' where id = $1`, [manual]);
  assert.ok((await claim(instance)).job, "an expired lease no longer blocks, and it is not recovered by this claim");
  assert.equal((await jobs(instance)).find((row) => row.id === manual)?.status, "running", "no lease recovery on other rows");
});

test("never retries: a job with attempts > 0, a paused filter or a filter without OLX is not handed out", async () => {
  const instance = await db();
  await schedule(instance);
  await instance.exec(`update public.olx_scan_jobs set attempts = 1`);
  assert.equal((await claim(instance)).reason, "NO_DUE_JOB");
  await instance.exec(`update public.olx_scan_jobs set attempts = 0; update public.search_filters set is_active = false where id = '${FLIP}'`);
  assert.equal((await claim(instance)).reason, "NO_DUE_JOB");
  await instance.exec(`update public.search_filters set is_active = true, sources = '["otodom"]' where id = '${FLIP}'`);
  assert.equal((await claim(instance)).reason, "NO_DUE_JOB");
});

test("orphans are diagnosed, not deleted: unclaimed after 6 h and dead leases become failed with a code", async () => {
  const instance = await db(false); // worker OFF: nothing claims
  await onlyActive(instance, FLIP);
  await schedule(instance);
  const expire = async () => (await instance.query<{ r: Record<string, number> }>(`select public.expire_stale_scheduled_finder_olx_jobs() as r`)).rows[0].r;
  assert.deepEqual(await expire(), { unclaimed_expired: 0, lease_expired: 0, expiry_minutes: 360 });
  await elapseMinutes(instance, 361);
  assert.equal((await expire()).unclaimed_expired, 1);
  const [row] = await jobs(instance);
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "OLX_SCHEDULED_JOB_NOT_CLAIMED");
  const scans = (await instance.query<{ status: string; error_message: string }>(`select status, error_message from public.source_scans`)).rows;
  assert.equal(scans[0].status, "failed");
  assert.equal((await jobs(instance)).length, 1, "history kept");

  // Dead lease of a claimed automatic job.
  await instance.exec(ENABLE);
  await elapseMinutes(instance, 24 * 60);
  await schedule(instance);
  const claimed = await claim(instance);
  assert.ok(claimed.job);
  await instance.exec(`update public.olx_scan_jobs set leased_until = now() - interval '11 minutes' where status = 'running'`);
  assert.equal((await expire()).lease_expired, 1);
  assert.equal((await jobs(instance)).find((item) => item.id === claimed.job?.id)?.error_code, "OLX_SCHEDULED_JOB_LEASE_EXPIRED");
  // Manual jobs are never expired by this function.
  const manual = await manualJob(instance);
  await elapseMinutes(instance, 2000);
  await expire();
  assert.equal((await jobs(instance)).find((item) => item.id === manual)?.status, "queued");
});

test("STOP script disables instantly; the control table rejects unsafe values", async () => {
  const instance = await db();
  await schedule(instance);
  await instance.exec(STOP);
  assert.equal((await claim(instance)).reason, "AUTOMATION_DISABLED");
  await assert.rejects(instance.exec(`update public.olx_automation_control set max_claims_24h = 2`));
  await assert.rejects(instance.exec(`update public.olx_automation_control set unclaimed_expiry_minutes = 5`));
  await assert.rejects(instance.exec(`insert into public.olx_automation_control (id) values (2)`));
});

test("only service_role may execute; rollback removes only this migration and keeps jobs", async () => {
  const instance = await db();
  const grants = (await instance.query<{ grantee: string }>(`select grantee from information_schema.routine_privileges where routine_name in ('claim_scheduled_finder_olx_job','expire_stale_scheduled_finder_olx_jobs')`)).rows.map((row) => row.grantee);
  assert.ok(grants.includes("service_role"));
  assert.ok(!grants.some((grantee) => ["anon", "authenticated", "PUBLIC"].includes(grantee)));
  await schedule(instance);
  await instance.exec(ROLLBACK);
  assert.equal((await instance.query(`select 1 from pg_proc where proname in ('claim_scheduled_finder_olx_job','expire_stale_scheduled_finder_olx_jobs')`)).rows.length, 0);
  assert.equal((await jobs(instance)).length, 1);
  assert.equal((await instance.query(`select 1 from pg_proc where proname = 'enqueue_scheduled_finder_olx_job'`)).rows.length, 1, "PR #15 schedule untouched");
  await instance.exec(CLAIM); // re-apply after rollback
  await instance.exec(CLAIM); // idempotent
});
