/**
 * Migration 20261017120000 (claim coordination) and the STOP semantics, in
 * PGlite on the full chain of real migrations (Production's plus PR #16):
 * who may claim an automatic job, what happens to an expired lease, that an
 * automatic job is never retried or revived, and what STOP does to slots and
 * queued jobs. The genuinely concurrent cases (two connections blocking on
 * the shared lock) are in olx-claim-coordination.race.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { CHAIN_FLIP, CHAIN_OTHER, CHAIN_URL, ENABLE_AUTOMATION, PR16_MIGRATIONS, USAGE_OK, chainDatabase, jobSql, migration, script } from "./olx-migration-chain.fixture.ts";

type Claim = { job: Record<string, unknown> | null; reason: string | null };
type Decision = Record<string, unknown> & { decision: string; reason: string | null; blocker: string | null };

const regular = async (db: PGlite, worker = "local-worker") =>
  (await db.query<{ idempotency_key: string }>(`select idempotency_key from public.claim_olx_scan_job($1, 120)`, [worker])).rows.map((row) => row.idempotency_key);
const selective = async (db: PGlite, key: string) =>
  (await db.query<{ idempotency_key: string }>(`select idempotency_key from public.claim_olx_scan_job_selective('cloudflare-olx-stage2', (select id from public.olx_scan_jobs where idempotency_key = $1), 120)`, [key])).rows.map((row) => row.idempotency_key);
const scheduled = async (db: PGlite) =>
  (await db.query<{ r: Claim }>(`select public.claim_scheduled_finder_olx_job('cloudflare-olx-scheduled', 120, $1::jsonb) as r`, [USAGE_OK])).rows[0].r;
const job = async (db: PGlite, key: string) =>
  (await db.query<{ status: string; attempts: number; worker_id: string | null; error_code: string | null; leased_until: Date | null }>(
    `select status, attempts, worker_id, error_code, leased_until from public.olx_scan_jobs where idempotency_key = $1`, [key])).rows[0];
const expire = async (db: PGlite) => (await db.query<{ r: Record<string, unknown> }>(`select public.expire_stale_scheduled_finder_olx_jobs() as r`)).rows[0].r;

async function enabled(): Promise<PGlite> {
  const db = await chainDatabase();
  await db.exec(ENABLE_AUTOMATION);
  return db;
}

/** Puts the filter's current slot `minutesAgo` minutes in the past (24 h interval). */
async function slotStartedAgo(db: PGlite, filter: string, minutesAgo: number) {
  await db.exec(`alter table public.search_filters disable trigger search_filters_finder_olx_anchor`);
  await db.query(`update public.search_filters set is_active = (id = $1), finder_olx_scan_interval_minutes = 1440,
      finder_olx_schedule_anchor = date_trunc('minute', now() at time zone 'Europe/Warsaw') - make_interval(mins => $2)`, [filter, minutesAgo]);
  await db.exec(`alter table public.search_filters enable trigger search_filters_finder_olx_anchor`);
}

const decide = async (db: PGlite, filter = CHAIN_FLIP, dryRun = false) =>
  (await db.query<{ r: Decision }>(`select public.enqueue_scheduled_finder_olx_job($1, gen_random_uuid(), $2, '{}'::jsonb, 1, $3) as r`, [filter, CHAIN_URL, dryRun])).rows[0].r;

// ----------------------------------------------------------- who claims what
test("regular and selective claims never take an automatic job (oldest, only one, automation on or off); manual jobs as before", async () => {
  const db = await enabled();
  try {
    await db.exec(jobSql({ key: "s1-auto", requestedBy: "scheduler", ageMinutes: 60 }));
    assert.deepEqual(await regular(db), [], "the only queued job is automatic: the regular worker gets nothing");
    assert.deepEqual(await selective(db, "s1-auto"), [], "naming the automatic job does not help");
    await db.exec(`update public.olx_automation_control set scheduled_claim_enabled = false`);
    assert.deepEqual(await regular(db), []);
    await db.exec(jobSql({ key: "m1-manual", requestedBy: "manual", ageMinutes: 5 }) + jobSql({ key: "m2-null", requestedBy: null, ageMinutes: 4 }));
    assert.deepEqual(await regular(db), ["m1-manual"], "manual jobs: oldest first, unchanged");
    assert.deepEqual(await selective(db, "m2-null"), ["m2-null"]);
    assert.equal((await job(db, "s1-auto")).status, "queued", "the automatic job is untouched");
  } finally {
    await db.close();
  }
});

test("while an automatic job holds a live lease the regular and selective claims hand out nothing; afterwards everything resumes", async () => {
  const db = await enabled();
  try {
    await db.exec(jobSql({ key: "s1-auto", requestedBy: "scheduler", ageMinutes: 10 }) + jobSql({ key: "m1-manual", requestedBy: "manual", ageMinutes: 5 }) + jobSql({ key: "m2-manual", requestedBy: "manual", ageMinutes: 4 }));
    assert.equal((await scheduled(db)).job?.idempotency_key, "s1-auto");
    assert.deepEqual(await regular(db), []);
    assert.deepEqual(await selective(db, "m2-manual"), []);
    await db.exec(`update public.olx_scan_jobs set status = 'completed', finished_at = now(), leased_until = null where idempotency_key = 's1-auto'`);
    assert.deepEqual(await regular(db), ["m1-manual"]);
    assert.equal((await scheduled(db)).reason, "OLX_JOB_RUNNING", "and the scheduled claim waits for the manual job in turn");
  } finally {
    await db.close();
  }
});

// ------------------------------------------------- expired lease, no retries
test("expired lease of an automatic job: not requeued by the regular claim, not retaken, not revived; closed as LEASE_EXPIRED after 10 min", async () => {
  const db = await enabled();
  try {
    await db.exec(jobSql({ key: "s1-auto", requestedBy: "scheduler", status: "running", ageMinutes: 20, leasedForSeconds: -60, workerId: "cloudflare-olx-scheduled" })
      + jobSql({ key: "m-expired", requestedBy: "manual", status: "running", ageMinutes: 20, leasedForSeconds: -60, workerId: "local-old" }));
    // The regular claim still recovers the expired MANUAL job (unchanged) and takes it, but never the automatic one.
    assert.deepEqual(await regular(db, "local-new"), ["m-expired"]);
    const auto = await job(db, "s1-auto");
    assert.deepEqual([auto.status, auto.attempts, auto.worker_id], ["running", 1, "cloudflare-olx-scheduled"]);
    await db.exec(`update public.olx_scan_jobs set status = 'completed', leased_until = null where idempotency_key = 'm-expired'`);
    assert.equal((await scheduled(db)).reason, "NO_DUE_JOB", "attempts 1: the scheduled claim never takes it again");

    // A late heartbeat (the same update heartbeatOlxJob makes) cannot revive the lease.
    await assert.rejects(db.exec(`update public.olx_scan_jobs set leased_until = now() + interval '2 minutes', heartbeat_at = now() where idempotency_key = 's1-auto' and status = 'running'`), /OLX_SCHEDULED_JOB_LEASE_EXPIRED/);
    // No path may retry it: back to queued, or a second attempt.
    await assert.rejects(db.exec(`update public.olx_scan_jobs set status = 'queued', available_at = now(), leased_until = null, lease_token = null, worker_id = null where idempotency_key = 's1-auto'`), /OLX_SCHEDULED_JOB_NO_RETRY/);
    await assert.rejects(db.exec(`update public.olx_scan_jobs set attempts = 2 where idempotency_key = 's1-auto'`), /OLX_SCHEDULED_JOB_NO_RETRY/);

    assert.deepEqual(await expire(db), { stopped: 0, unclaimed_expired: 0, lease_expired: 0, expiry_minutes: 360, automation_enabled: true }, "within 10 min the Worker may still finish it");
    await db.exec(`update public.olx_scan_jobs set leased_until = now() - interval '11 minutes' where idempotency_key = 's1-auto'`);
    assert.equal((await expire(db)).lease_expired, 1);
    const closed = await job(db, "s1-auto");
    assert.deepEqual([closed.status, closed.error_code, closed.attempts], ["failed", "OLX_SCHEDULED_JOB_LEASE_EXPIRED", 1]);
    assert.deepEqual(await regular(db), [], "and it never comes back");
    assert.equal((await scheduled(db)).reason, "NO_DUE_JOB");
  } finally {
    await db.close();
  }
});

test("a live automatic lease is renewed normally and the job completes; manual jobs keep their old lease rules (revival allowed)", async () => {
  const db = await enabled();
  try {
    await db.exec(jobSql({ key: "s1-auto", requestedBy: "scheduler", ageMinutes: 1 }) + jobSql({ key: "m-late", requestedBy: "manual", status: "running", ageMinutes: 30, leasedForSeconds: -30, workerId: "local" }));
    await db.exec(`update public.olx_scan_jobs set status = 'completed', leased_until = null where idempotency_key = 'm-late'`);
    assert.equal((await scheduled(db)).job?.idempotency_key, "s1-auto");
    await db.exec(`update public.olx_scan_jobs set leased_until = now() + interval '2 minutes', heartbeat_at = now() where idempotency_key = 's1-auto' and status = 'running'`);
    await db.exec(`update public.olx_scan_jobs set status = 'completed', finished_at = now(), leased_until = null where idempotency_key = 's1-auto'`);
    assert.equal((await job(db, "s1-auto")).status, "completed");
    // Unchanged for manual jobs: a late heartbeat of an expired manual lease is accepted as before.
    await db.exec(jobSql({ key: "m-slow", requestedBy: "manual", status: "running", ageMinutes: 5, leasedForSeconds: -30, workerId: "local" }));
    await db.exec(`update public.olx_scan_jobs set leased_until = now() + interval '2 minutes' where idempotency_key = 'm-slow'`);
    assert.equal((await job(db, "m-slow")).status, "running");
  } finally {
    await db.close();
  }
});

// ------------------------------------------------------------------- STOP
test("STOP: the slot queues nothing (AUTOMATION_DISABLED), uses no budget, and past the grace is recorded once as missed with that reason", async () => {
  const db = await chainDatabase();
  try {
    await slotStartedAgo(db, CHAIN_FLIP, 0);
    const stopped = await decide(db);
    assert.equal(stopped.decision, "skipped");
    assert.equal(stopped.reason, "AUTOMATION_DISABLED");
    assert.equal(stopped.automation_enabled, false);
    assert.equal((await db.query(`select 1 from public.olx_scan_jobs`)).rows.length, 0, "no job that could only end as NOT_CLAIMED");
    assert.equal((await db.query(`select 1 from public.finder_olx_slots`)).rows.length, 0, "the slot stays open while it is within its grace");
    assert.equal(stopped.automatic_jobs_in_window, 0);
    assert.ok(stopped.next_allowed_at, "UI shows when it could still run");

    await slotStartedAgo(db, CHAIN_FLIP, 181);
    assert.equal((await decide(db)).reason, "SLOT_MISSED");
    assert.equal((await decide(db)).reason, "SLOT_ALREADY_HANDLED", "recorded once");
    const slots = (await db.query<{ status: string; reason: string }>(`select status, reason from public.finder_olx_slots`)).rows;
    assert.deepEqual(slots, [{ status: "missed", reason: "AUTOMATION_DISABLED" }]);
    const last = (await decide(db, CHAIN_FLIP, true)).last_slot as Record<string, unknown>;
    assert.equal(last.reason, "AUTOMATION_DISABLED", "the missed slot and its cause are diagnosable");
  } finally {
    await db.close();
  }
});

test("STOP lifted within the grace: the same slot still runs (late, never twice)", async () => {
  const db = await chainDatabase();
  try {
    await slotStartedAgo(db, CHAIN_FLIP, 30);
    assert.equal((await decide(db)).reason, "AUTOMATION_DISABLED");
    await db.exec(ENABLE_AUTOMATION);
    const late = await decide(db);
    assert.equal(late.decision, "enqueued", "30 min late, within the 3 h grace");
    assert.equal((await db.query(`select 1 from public.olx_scan_jobs where requested_by = 'scheduler'`)).rows.length, 1);
  } finally {
    await db.close();
  }
});

test("STOP with a queued automatic job: retired at once as OLX_SCHEDULED_JOB_STOPPED (not after 6 h); a running one finishes; manual jobs untouched", async () => {
  const db = await enabled();
  try {
    await db.exec(jobSql({ key: "s-queued", requestedBy: "scheduler", ageMinutes: 5 })
      + jobSql({ key: "s-running", requestedBy: "scheduler", status: "running", ageMinutes: 30, leasedForSeconds: 100, workerId: "cloudflare-olx-scheduled", filter: CHAIN_OTHER })
      + jobSql({ key: "m-queued", requestedBy: "manual", ageMinutes: 5 }));
    assert.equal((await expire(db)).stopped, 0, "nothing is retired while the automation is on");
    await db.exec(script("olx-cloud-scheduled.stop.sql"));
    const result = await expire(db);
    assert.equal(result.stopped, 1);
    assert.equal(result.automation_enabled, false);
    const retired = await job(db, "s-queued");
    assert.deepEqual([retired.status, retired.error_code, retired.attempts], ["failed", "OLX_SCHEDULED_JOB_STOPPED", 0]);
    assert.equal((await db.query<{ status: string }>(`select s.status from public.source_scans s join public.olx_scan_jobs j on j.source_scan_id = s.id where j.idempotency_key = 's-queued'`)).rows[0].status, "failed");
    assert.equal((await job(db, "s-running")).status, "running", "the job already in the Worker's hands is not cut off");
    assert.equal((await job(db, "m-queued")).status, "queued");
    assert.equal((await db.query(`select 1 from public.olx_scan_jobs`)).rows.length, 3, "nothing deleted");
    assert.equal((await expire(db)).stopped, 0, "idempotent");
  } finally {
    await db.close();
  }
});

// ------------------------------------------------------------ rollback, grants
test("rollback restores the three functions byte for byte and drops the guard; jobs stay; the migration re-applies", async () => {
  const before = await chainDatabase(PR16_MIGRATIONS.filter((file) => !file.startsWith("20261017")));
  const after = await chainDatabase();
  try {
    const definitions = async (db: PGlite) => (await db.query<{ name: string; def: string }>(`select p.proname as name, pg_get_functiondef(p.oid) as def from pg_proc p
      where p.proname in ('claim_olx_scan_job','claim_olx_scan_job_selective','expire_stale_scheduled_finder_olx_jobs','claim_scheduled_finder_olx_job') order by 1, 2`)).rows;
    const original = await definitions(before);
    assert.notDeepEqual(await definitions(after), original);
    await after.exec(jobSql({ key: "kept", requestedBy: "scheduler", ageMinutes: 1 }));
    await after.exec(script("olx-claim-coordination.rollback.sql"));
    assert.deepEqual(await definitions(after), original);
    assert.equal((await after.query(`select 1 from pg_trigger where tgname = 'olx_scan_jobs_guard_scheduled'`)).rows.length, 0);
    assert.equal((await after.query(`select 1 from public.olx_scan_jobs`)).rows.length, 1);
    await after.exec(migration("20261017120000_coordinate_olx_claims.sql"));
    assert.deepEqual(await regular(after), [], "re-applied: the automatic job is protected again");
  } finally {
    await before.close();
    await after.close();
  }
});

test("only service_role may execute the claims and the expiry", async () => {
  const db = await chainDatabase();
  try {
    for (const signature of ["claim_olx_scan_job(text,integer)", "claim_olx_scan_job_selective(text,uuid,integer)", "expire_stale_scheduled_finder_olx_jobs()"]) {
      const row = (await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(`select has_function_privilege('anon','public.${signature}','EXECUTE') as anon,
        has_function_privilege('authenticated','public.${signature}','EXECUTE') as authenticated, has_function_privilege('service_role','public.${signature}','EXECUTE') as service`)).rows[0];
      assert.deepEqual(row, { anon: false, authenticated: false, service: true }, signature);
    }
  } finally {
    await db.close();
  }
});

test("the read-only check script runs on the full chain, reports the coordination, and changes nothing", async () => {
  const db = await enabled();
  try {
    await db.exec(jobSql({ key: "s1-auto", requestedBy: "scheduler", ageMinutes: 1 }));
    const snapshot = async () => (await db.query(`select id, status, attempts, updated_at from public.olx_scan_jobs order by id`)).rows;
    const before = await snapshot();
    const results = await db.exec(script("olx-cloud-scheduled.check.sql"));
    assert.deepEqual(await snapshot(), before);
    const coordination = results.find((result) => result.fields.some((field) => field.name === "uses_shared_lock"));
    assert.deepEqual(coordination?.rows.map((row) => [row.proname, row.uses_shared_lock, row.excludes_automatic_jobs]), [
      ["claim_olx_scan_job", true, true], ["claim_olx_scan_job_selective", true, true],
      ["claim_scheduled_finder_olx_job", true, true], ["claim_scheduled_finder_olx_job", true, true],
    ]);
  } finally {
    await db.close();
  }
});

test("full rollback in the documented order (20261017 -> 20261016 -> 20261015) leaves exactly Production's functions and triggers", async () => {
  const production = await chainDatabase([]);
  const rolledBack = await chainDatabase();
  try {
    const shape = async (db: PGlite) => ({
      functions: (await db.query<{ def: string }>(`select pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'public'::regnamespace order by p.proname, 1`)).rows.map((row) => row.def),
      triggers: (await db.query<{ tgname: string }>(`select tgname from pg_trigger where not tgisinternal order by 1`)).rows.map((row) => row.tgname),
    });
    await rolledBack.exec(jobSql({ key: "history", requestedBy: "scheduler", status: "completed", ageMinutes: 60 }));
    for (const file of ["olx-claim-coordination.rollback.sql", "olx-slot-schedule.rollback.sql", "olx-cloud-scheduled.rollback.sql"]) await rolledBack.exec(script(file));
    assert.deepEqual(await shape(rolledBack), await shape(production));
    assert.equal((await rolledBack.query(`select 1 from public.olx_scan_jobs`)).rows.length, 1, "history kept");
  } finally {
    await production.close();
    await rolledBack.close();
  }
});
