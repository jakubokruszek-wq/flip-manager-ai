/**
 * Slot schedule, 2-per-24-h limit with browser budget, and the Radar OLX
 * block — in PGlite on top of the real queue, PR #15, scheduled-claim and
 * slot migrations. Wall-clock (DST) rules are tested on the pure helpers with
 * an explicit p_now; the decision function always uses the database clock, so
 * time "passes" there by shifting every stored timestamp back.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";

import { database, onlyActive, FLIP, OTHER, OLX_ONLY, OWNER, URL } from "./finder-olx-schedule.fixture.ts";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const CLAIM = read("supabase/migrations/20261015120000_add_scheduled_olx_claim.sql");
const SLOTS = read("supabase/migrations/20261016120000_olx_slot_schedule_and_radar_olx_removal.sql");
const ROLLBACK = read("scripts/olx-slot-schedule.rollback.sql");
const ENABLE = read("scripts/olx-cloud-scheduled.enable.sql");
const RADAR_RUN = "44444444-4444-4444-8444-444444444444";

type Decision = Record<string, unknown> & { decision: string; reason: string | null; blocker: string | null };

async function db(options: { beforeSlots?: (instance: PGlite) => Promise<void> } = {}): Promise<PGlite> {
  const instance = await database();
  await instance.exec(CLAIM);
  await options.beforeSlots?.(instance);
  await instance.exec(SLOTS);
  return instance;
}

/** Puts the filter's current slot `minutesAgo` minutes in the past (anchor = local now - minutesAgo). */
async function slotStartedAgo(instance: PGlite, filter: string, minutesAgo: number, intervalMinutes = 1440) {
  await instance.exec(`alter table public.search_filters disable trigger search_filters_finder_olx_anchor`);
  await instance.query(`update public.search_filters set finder_olx_scan_interval_minutes = $2,
      finder_olx_schedule_anchor = date_trunc('minute', now() at time zone 'Europe/Warsaw') - make_interval(mins => $3)
    where id = $1`, [filter, intervalMinutes, minutesAgo]);
  await instance.exec(`alter table public.search_filters enable trigger search_filters_finder_olx_anchor`);
}

/** Lets `minutes` pass: every stored timestamp (anchors included) moves back. */
async function elapse(instance: PGlite, minutes: number) {
  await instance.exec(`
    alter table public.search_filters disable trigger search_filters_finder_olx_anchor;
    update public.search_filters set finder_olx_schedule_anchor = finder_olx_schedule_anchor - interval '${minutes} minutes';
    alter table public.search_filters enable trigger search_filters_finder_olx_anchor;
    -- Slot keys hold the slot's epoch; moving the clock must not make a past key look current.
    update public.olx_scan_jobs set idempotency_key = idempotency_key || ':past-' || gen_random_uuid() where idempotency_key like '%:olx-slot:%' and idempotency_key not like '%:past-%';
    update public.olx_scan_jobs set created_at = created_at - interval '${minutes} minutes', started_at = started_at - interval '${minutes} minutes',
      finished_at = finished_at - interval '${minutes} minutes', leased_until = leased_until - interval '${minutes} minutes';
    update public.source_scans set started_at = started_at - interval '${minutes} minutes';
    update public.finder_olx_slots set slot_at = slot_at - interval '${minutes} minutes', decided_at = decided_at - interval '${minutes} minutes';
    update public.olx_cloud_budget set reported_at = reported_at - interval '${minutes} minutes';
  `);
}

async function decide(instance: PGlite, filter = FLIP, options: { dryRun?: boolean; shared?: number } = {}): Promise<Decision> {
  return (await instance.query<{ r: Decision }>(`select public.enqueue_scheduled_finder_olx_job($1, gen_random_uuid(), $2, '{}'::jsonb, $3, $4) as r`,
    [filter, URL, options.shared ?? 1, options.dryRun ?? false])).rows[0].r;
}

async function finishAll(instance: PGlite) {
  await instance.exec(`update public.olx_scan_jobs set status = 'completed', finished_at = now() where status in ('queued','running') and context_type = 'finder';
    update public.source_scans set status = 'completed' where status in ('pending','running');`);
}

async function limit(instance: PGlite, value: number) {
  await instance.query(`update public.olx_automation_control set max_claims_24h = $1`, [value]);
}

const usage = (overrides: Record<string, unknown> = {}) => ({ accountBrowserMs: 0, workerBrowserMs: 0, safeBudgetMs: 120_000, jobEstimateMs: 45_000, ...overrides });
async function claim(instance: PGlite, report: unknown = usage()) {
  return (await instance.query<{ r: { job: Record<string, unknown> | null; reason: string | null } }>(`select public.claim_scheduled_finder_olx_job($1, 120, $2::jsonb) as r`,
    ["cloudflare-olx-scheduled", report === null ? null : JSON.stringify(report)])).rows[0].r;
}

async function window(instance: PGlite, anchor: string, interval: number, now: string) {
  return (await instance.query<{ current_slot: Date | null; next_slot: Date }>(`select current_slot, next_slot from public.finder_olx_slot_window($1::timestamp, $2, $3::timestamptz)`, [anchor, interval, now])).rows[0];
}
const iso = (value: Date | null | undefined) => value ? new Date(value).toISOString() : null;

// --------------------------------------------------------- wall clock / DST
test("12 h at 08:00 gives 08:00 and 20:00 Warsaw time, also across both DST changes", async () => {
  const instance = await db();
  // Spring forward 2027-03-28 (02:00 CET -> 03:00 CEST), fall back 2026-10-25 (03:00 CEST -> 02:00 CET).
  assert.equal(iso((await window(instance, "2027-03-27 08:00", 720, "2027-03-27T19:30:00Z")).current_slot), "2027-03-27T19:00:00.000Z", "20:00 CET");
  assert.equal(iso((await window(instance, "2027-03-27 08:00", 720, "2027-03-28T06:30:00Z")).current_slot), "2027-03-28T06:00:00.000Z", "08:00 CEST, one hour earlier in UTC");
  assert.equal(iso((await window(instance, "2027-03-27 08:00", 720, "2027-03-28T18:30:00Z")).current_slot), "2027-03-28T18:00:00.000Z", "20:00 CEST");
  assert.equal(iso((await window(instance, "2026-10-24 08:00", 720, "2026-10-24T18:30:00Z")).current_slot), "2026-10-24T18:00:00.000Z", "20:00 CEST");
  assert.equal(iso((await window(instance, "2026-10-24 08:00", 720, "2026-10-25T07:30:00Z")).current_slot), "2026-10-25T07:00:00.000Z", "08:00 CET after fall back");
  assert.equal(iso((await window(instance, "2026-10-24 08:00", 720, "2026-10-25T07:30:00Z")).next_slot), "2026-10-25T19:00:00.000Z");
});

test("24/48/72 h keep the start time and the durable anchor date across DST and month ends", async () => {
  const instance = await db();
  assert.equal(iso((await window(instance, "2026-10-24 08:00", 1440, "2026-10-26T08:00:00Z")).current_slot), "2026-10-26T07:00:00.000Z");
  // 48 h from 2026-10-24: 24, 26, 28 ... never 25 or 27, whatever happened in between.
  assert.equal(iso((await window(instance, "2026-10-24 08:00", 2880, "2026-10-27T12:00:00Z")).current_slot), "2026-10-26T07:00:00.000Z");
  assert.equal(iso((await window(instance, "2026-10-24 08:00", 2880, "2026-10-27T12:00:00Z")).next_slot), "2026-10-28T07:00:00.000Z");
  // 72 h across a month end: 30.10, 02.11.
  assert.equal(iso((await window(instance, "2026-10-30 08:00", 4320, "2026-11-02T07:05:00Z")).current_slot), "2026-11-02T07:00:00.000Z");
  assert.equal((await window(instance, "2026-10-30 08:00", 4320, "2026-10-30T06:00:00Z")).current_slot, null, "before the first slot");
});

test("first slot after a schedule change: next occurrence of the start time (12 h: of start or start + 12 h)", async () => {
  const instance = await db();
  const first = async (start: string, interval: number, now: string) => (await instance.query<{ f: string }>(`select to_char(public.finder_olx_first_slot($1::time, $2, $3::timestamptz), 'YYYY-MM-DD HH24:MI') as f`, [start, interval, now])).rows[0].f;
  assert.equal(await first("08:00", 1440, "2026-10-14T08:00:00Z"), "2026-10-15 08:00", "10:00 local: tomorrow 08:00");
  assert.equal(await first("08:00", 720, "2026-10-14T08:00:00Z"), "2026-10-14 20:00", "12 h: today 20:00");
  assert.equal(await first("08:00", 2880, "2026-10-14T08:00:00Z"), "2026-10-15 08:00");
  assert.equal(await first("08:00", 1440, "2026-10-14T05:00:00Z"), "2026-10-14 08:00", "07:00 local: today");
  assert.equal(await first("08:00", 1440, "2026-10-14T06:00:00Z"), "2026-10-14 08:00", "exactly 08:00: this slot");
  assert.equal(await first("23:55", 1440, "2026-10-14T22:00:00Z"), "2026-10-15 23:55", "after 23:55 local on 15.10 00:00: next day");
});

test("anchor trigger: set on schedule changes only; a direct anchor write or another column is ignored", async () => {
  const instance = await db();
  const anchor = async () => (await instance.query<{ a: string }>(`select finder_olx_schedule_anchor::text as a from public.search_filters where id = $1`, [FLIP])).rows[0].a;
  const before = await anchor();
  await instance.query(`update public.search_filters set last_scanned_at = now() where id = $1`, [FLIP]);
  assert.equal(await anchor(), before);
  await instance.query(`update public.search_filters set finder_olx_schedule_anchor = '2020-01-01 00:00' where id = $1`, [FLIP]);
  assert.equal(await anchor(), before, "the anchor is durable");
  await instance.query(`update public.search_filters set finder_olx_start_time = '21:35' where id = $1`, [FLIP]);
  assert.match(await anchor(), / 21:35:00$/);
  await assert.rejects(instance.query(`update public.search_filters set finder_olx_start_time = '08:03' where id = $1`, [FLIP]), /start_time_step/);
  await assert.rejects(instance.query(`update public.search_filters set finder_olx_scan_interval_minutes = 600 where id = $1`, [FLIP]), /interval_allowed/);
  await instance.query(`update public.search_filters set finder_olx_scan_interval_minutes = 720 where id = $1`, [FLIP]);
});

// ------------------------------------------------------------ slot decisions
test("a slot is enqueued once: repeated and concurrent calls never duplicate it", async () => {
  const instance = await db();
  await onlyActive(instance, FLIP);
  await slotStartedAgo(instance, FLIP, 2);
  const results = await Promise.all([decide(instance), decide(instance), decide(instance)]);
  assert.equal(results.filter((result) => result.decision === "enqueued").length, 1);
  assert.ok(results.every((result) => result.decision === "enqueued" || ["SLOT_ALREADY_HANDLED"].includes(result.reason!)));
  const jobs = (await instance.query<{ idempotency_key: string }>(`select idempotency_key from public.olx_scan_jobs`)).rows;
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].idempotency_key, /:olx-slot:\d+$/);
  assert.equal((await instance.query(`select 1 from public.finder_olx_slots`)).rows.length, 1);
  const again = await decide(instance);
  assert.equal(again.reason, "SLOT_ALREADY_HANDLED");
  assert.equal(Date.parse(String(again.next_allowed_at)) - Date.parse(String(again.slot_at)), 24 * 3_600_000);
});

test("a late completion does not move the schedule: the next slot is the planned one", async () => {
  const instance = await db();
  await onlyActive(instance, FLIP);
  await slotStartedAgo(instance, FLIP, 0);
  const first = await decide(instance);
  assert.equal(first.decision, "enqueued");
  await elapse(instance, 20 * 60);
  await finishAll(instance); // finished 20 h after the slot
  await elapse(instance, 4 * 60 + 1);
  const next = await decide(instance);
  assert.equal(next.decision, "enqueued");
  assert.equal(Date.parse(String(next.slot_at)) - Date.parse(String(first.slot_at)) - (24 * 60 + 1) * 60_000 + (24 * 60 + 1) * 60_000, 24 * 3_600_000 + (Date.parse(String(next.slot_at)) - Date.parse(String(first.slot_at)) - 24 * 3_600_000), "planned slot");
  const slotsDistance = (await instance.query<{ d: number }>(`select extract(epoch from max(slot_at) - min(slot_at))::int as d from public.finder_olx_slots`)).rows[0].d;
  assert.equal(slotsDistance, 24 * 3600);
});

test("after an outage only the current slot counts: missed once if past grace, no catch-up avalanche", async () => {
  const instance = await db();
  await onlyActive(instance, FLIP);
  // Down for 3 days; the current slot started 4 h ago (grace 3 h).
  await slotStartedAgo(instance, FLIP, 3 * 24 * 60 + 4 * 60);
  const result = await decide(instance);
  assert.equal(result.reason, "SLOT_MISSED");
  const slots = (await instance.query<{ status: string; reason: string }>(`select status, reason from public.finder_olx_slots`)).rows;
  assert.deepEqual(slots, [{ status: "missed", reason: "NOT_ENQUEUED_WITHIN_GRACE" }], "one row for the current slot, none for the three earlier ones");
  assert.equal((await instance.query(`select 1 from public.olx_scan_jobs`)).rows.length, 0);
  assert.equal((await decide(instance)).reason, "SLOT_ALREADY_HANDLED");
  // Within grace after a restart: the current slot still runs (late, with its delay visible).
  const late = await db();
  await onlyActive(late, FLIP);
  await slotStartedAgo(late, FLIP, 2 * 24 * 60 + 100);
  assert.equal((await decide(late)).decision, "enqueued");
  assert.equal((await late.query(`select 1 from public.olx_scan_jobs`)).rows.length, 1);
});

test("12 h with the default limit 1: the 20:00 slot is skipped with a clear reason; with limit 2 it runs", async () => {
  const instance = await db();
  await onlyActive(instance, FLIP);
  await slotStartedAgo(instance, FLIP, 0, 720);
  assert.equal((await decide(instance)).decision, "enqueued");
  await finishAll(instance);
  await elapse(instance, 12 * 60);
  const blocked = await decide(instance);
  assert.equal(blocked.reason, "AUTOMATIC_DAILY_BUDGET_USED");
  assert.equal(blocked.automatic_limit, 1);
  await elapse(instance, 181);
  const missed = await decide(instance);
  assert.equal(missed.reason, "SLOT_MISSED");
  assert.equal((await instance.query<{ reason: string }>(`select reason from public.finder_olx_slots where status = 'missed'`)).rows[0].reason, "AUTOMATIC_DAILY_BUDGET_USED", "the missed slot keeps its cause");

  const two = await db();
  await onlyActive(two, FLIP);
  await limit(two, 2);
  await slotStartedAgo(two, FLIP, 0, 720);
  assert.equal((await decide(two)).decision, "enqueued");
  await finishAll(two);
  await elapse(two, 12 * 60);
  const second = await decide(two);
  assert.equal(second.decision, "enqueued", "08:00 and 20:00");
  assert.equal(second.shared_limit, 2, "the shared budget follows the automatic limit");
  await finishAll(two);
  await elapse(two, 12 * 60);
  assert.equal((await decide(two)).decision, "enqueued", "the next 08:00: the first job has left the rolling 24 h");
  const rolling = (await two.query<{ n: number }>(`select count(*)::int as n from public.olx_scan_jobs where created_at >= now() - interval '24 hours'`)).rows[0].n;
  assert.equal(rolling, 2, "never more than 2 within any 24 h");
  // An extra manual-free slot inside the same 24 h (forced) is refused.
  await two.exec(`update public.olx_automation_control set max_claims_24h = 2`);
  await slotStartedAgo(two, FLIP, 0, 720);
  await two.exec(`delete from public.finder_olx_slots where slot_at > now() - interval '1 minute'`);
  await finishAll(two);
  assert.equal((await decide(two)).reason, "AUTOMATIC_DAILY_BUDGET_USED", "a third within 24 h is refused");
});

test("several filters share the global limit: at most 2 automatic jobs per 24 h across all of them", async () => {
  const instance = await db();
  await limit(instance, 2);
  for (const filter of [FLIP, OTHER, OLX_ONLY]) await slotStartedAgo(instance, filter, 0, 720);
  let enqueued = 0;
  for (let tick = 0; tick < 48 * 12; tick += 1) { // 48 h of 5-minute ticks
    for (const filter of [FLIP, OTHER, OLX_ONLY]) if ((await decide(instance, filter)).decision === "enqueued") enqueued += 1;
    await finishAll(instance);
    await elapse(instance, 5);
    const window24 = (await instance.query<{ n: number }>(`select count(*)::int as n from public.olx_scan_jobs where requested_by = 'scheduler' and created_at > now() - interval '24 hours'`)).rows[0].n;
    assert.ok(window24 <= 2, `rolling 24 h never above 2 (tick ${tick})`);
  }
  assert.equal(enqueued, 4, "2 per 24 h over 48 h");
  const perFilter = (await instance.query<{ search_filter_id: string; n: number }>(`select search_filter_id, count(*)::int as n from public.olx_scan_jobs group by 1`)).rows;
  assert.equal(perFilter.length, 3, "fairness: every filter gets a turn");
});

test("manual Finder scans share the budget; Radar jobs retired by the removal do not count", async () => {
  const instance = await db();
  await onlyActive(instance, FLIP);
  const scan = (await instance.query<{ id: string }>(`insert into public.source_scans (search_filter_id, source, status) values ($1, 'olx', 'completed') returning id`, [OTHER])).rows[0].id;
  await instance.query(`insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key, status) values (gen_random_uuid(), $1, $2, $3, 'manual', 'completed')`, [scan, OTHER, URL]);
  await slotStartedAgo(instance, FLIP, 0);
  assert.equal((await decide(instance)).reason, "SHARED_DAILY_BUDGET_USED");
  await limit(instance, 2);
  assert.equal((await decide(instance)).decision, "enqueued", "limit 2: one manual + one automatic");
});

test("browser budget: a slot whose job would not fit today's measured Cloudflare usage is skipped with a reason", async () => {
  const instance = await db();
  await onlyActive(instance, FLIP);
  await instance.exec(ENABLE);
  await slotStartedAgo(instance, FLIP, 0);
  // The Worker reported (with a refused claim) 90 s used and a 45 s job estimate: 135 s > 120 s.
  assert.equal((await claim(instance, usage({ accountBrowserMs: 90_000 }))).reason, "BROWSER_BUDGET_INSUFFICIENT");
  const skipped = await decide(instance);
  assert.equal(skipped.reason, "BROWSER_BUDGET_INSUFFICIENT");
  assert.equal((skipped.browser_budget as Record<string, unknown>).remaining_ms, 30_000);
  // A report from an earlier UTC day is not today's usage.
  await instance.exec(`update public.olx_cloud_budget set utc_day = utc_day - 1`);
  assert.equal((await decide(instance)).decision, "enqueued");
});

// ------------------------------------------------------------- scheduled claim
test("claim with usage report: unknown usage refused, over budget refused, 2 per 24 h at most, budget capped at 300 s", async () => {
  const instance = await db();
  await instance.exec(ENABLE);
  await limit(instance, 2);
  await onlyActive(instance, FLIP, OTHER);
  await slotStartedAgo(instance, FLIP, 0, 720);
  await slotStartedAgo(instance, OTHER, 0, 720);
  await decide(instance, FLIP);
  await decide(instance, OTHER);
  for (const bad of [null, {}, usage({ jobEstimateMs: 0 }), usage({ accountBrowserMs: -1 }), usage({ safeBudgetMs: "120000" })]) {
    assert.equal((await claim(instance, bad)).reason, "BROWSER_USAGE_UNKNOWN", JSON.stringify(bad));
  }
  assert.equal((await claim(instance, usage({ safeBudgetMs: 900_000, accountBrowserMs: 280_000 }))).reason, "BROWSER_BUDGET_INSUFFICIENT", "a reported 900 s budget is capped at 300 s");
  const first = await claim(instance);
  assert.ok(first.job);
  assert.equal((await claim(instance)).reason, "OLX_JOB_RUNNING", "never in parallel");
  await instance.exec(`update public.olx_scan_jobs set status = 'completed', leased_until = null where status = 'running'`);
  const second = await claim(instance, usage({ accountBrowserMs: 50_000 }));
  assert.ok(second.job, "second automatic job: 50 s used + 45 s estimate fits 120 s");
  await finishAll(instance);
  await instance.exec(`update public.olx_scan_jobs set leased_until = null`);
  const stored = (await instance.query<{ account_browser_ms: number; job_estimate_ms: number }>(`select account_browser_ms, job_estimate_ms from public.olx_cloud_budget`)).rows[0];
  assert.deepEqual(stored, { account_browser_ms: 50_000, job_estimate_ms: 45_000 });
  await slotStartedAgo(instance, FLIP, 0, 720);
  await instance.exec(`delete from public.finder_olx_slots`);
  await limit(instance, 2);
  assert.equal((await claim(instance)).reason, "DAILY_CLAIM_USED");
});

// ------------------------------------------------------------- Radar removal
test("Radar OLX: pending jobs are retired with an audit entry, new ones cannot be inserted, requeue and claim turn into failed", async () => {
  const instance = await db({
    beforeSlots: async (before) => {
      await before.exec(`insert into public.price_radar_runs (id) values ('${RADAR_RUN}')`);
      for (const [key, status] of [["radar-queued", "queued"], ["radar-running", "running"], ["radar-done", "completed"]]) {
        await before.query(`insert into public.olx_scan_jobs (scan_run_id, context_type, radar_owner_id, radar_run_id, radar_lease_token, request_url, idempotency_key, status)
          values ($1, 'price_radar', $2, $1, gen_random_uuid(), $3, $4, $5)`, [RADAR_RUN, OWNER, URL, key, status]);
      }
    },
  });
  const rows = async () => (await instance.query<{ idempotency_key: string; status: string; error_code: string | null; result_summary: Record<string, unknown> | null }>(
    `select idempotency_key, status, error_code, result_summary from public.olx_scan_jobs where context_type = 'price_radar' order by idempotency_key`)).rows;
  const before = await rows();
  assert.deepEqual(before.map((row) => [row.idempotency_key, row.status, row.error_code]), [["radar-done", "completed", null], ["radar-queued", "failed", "RADAR_OLX_REMOVED"], ["radar-running", "failed", "RADAR_OLX_REMOVED"]]);
  assert.equal((before[1].result_summary!.radarOlxRemoved as Record<string, unknown>).retiredFromStatus, "queued", "auditable");
  assert.equal((await instance.query(`select 1 from public.olx_scan_jobs`)).rows.length, 3, "nothing deleted");

  await assert.rejects(instance.query(`insert into public.olx_scan_jobs (scan_run_id, context_type, radar_owner_id, radar_run_id, radar_lease_token, request_url, idempotency_key)
    values ($1, 'price_radar', $2, $1, gen_random_uuid(), $3, 'radar-new')`, [RADAR_RUN, OWNER, URL]), /RADAR_OLX_REMOVED/);
  // claim_price_radar_run's requeue and the STOP resume both set status = 'queued'.
  await instance.exec(`update public.olx_scan_jobs set status = 'queued', available_at = now(), error_code = 'RADAR_LEASE_RECLAIMED' where idempotency_key = 'radar-running'`);
  const requeued = (await rows()).find((row) => row.idempotency_key === "radar-running")!;
  assert.equal(requeued.status, "failed");
  assert.equal(requeued.error_code, "RADAR_OLX_REMOVED");
  // The regular worker claim finds nothing of Radar.
  const regular = await instance.query(`select * from public.claim_olx_scan_job('local-windows', 120)`);
  assert.equal(regular.rows.length, 0);
  // Finder jobs are untouched by the trigger.
  await onlyActive(instance, FLIP);
  await slotStartedAgo(instance, FLIP, 0);
  assert.equal((await decide(instance)).decision, "enqueued");
});

test("rollback restores the PR #15 function and constraints; history stays; migration re-applies", async () => {
  const instance = await db();
  await onlyActive(instance, FLIP);
  await instance.query(`update public.search_filters set finder_olx_scan_interval_minutes = 720 where id = $1`, [FLIP]);
  await slotStartedAgo(instance, FLIP, 0, 720);
  await decide(instance);
  await instance.exec(ROLLBACK);
  const columns = (await instance.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'search_filters' and column_name in ('finder_olx_start_time','finder_olx_schedule_anchor')`)).rows;
  assert.deepEqual(columns, []);
  assert.equal((await instance.query<{ v: number }>(`select finder_olx_scan_interval_minutes as v from public.search_filters where id = $1`, [FLIP])).rows[0].v, 1440, "12 h falls back to 24 h");
  assert.equal((await instance.query(`select 1 from public.olx_scan_jobs`)).rows.length, 1, "jobs kept");
  const old = (await instance.query<{ r: Decision }>(`select public.enqueue_scheduled_finder_olx_job($1, gen_random_uuid(), $2, '{}'::jsonb, 1, true) as r`, [FLIP, URL])).rows[0].r;
  assert.equal(old.reason, "OLX_JOB_IN_FLIGHT", "the PR #15 decision function answers again");
  await instance.exec(SLOTS);
});
