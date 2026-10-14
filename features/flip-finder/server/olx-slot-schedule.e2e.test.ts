import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SearchFilter } from "@/features/flip-finder";

/**
 * Whole path, end to end: the real runFinderScanScheduler every 5 minutes
 * (pg_cron), the real slot decision and scheduled claim in PGlite, and a
 * simulated Cloudflare Worker that claims every 15 minutes with a usage
 * report and finishes each job a few minutes later. Includes a Cloudflare
 * outage day. The other portals' cadence is checked on the same ticks.
 */

mock.module("server-only", { defaultExport: {} });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => ({}) } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { listActiveSearchFiltersForScheduler: async () => [] } });
mock.module("@/features/flip-finder/server/manual-scan", { namedExports: { startFinderScanForFilter: async () => { throw new Error("injected"); }, runManualOtodomScan: async () => { throw new Error("injected"); } } });

const { runFinderScanScheduler } = await import("./finder-scheduler.ts");
const { scheduleFinderOlxJob } = await import("./finder-olx-schedule.ts");
const { database, onlyActive, FLIP, OTHER } = await import("./finder-olx-schedule.fixture.ts");

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const CLAIM = read("supabase/migrations/20261015120000_add_scheduled_olx_claim.sql");
const SLOTS = read("supabase/migrations/20261016120000_olx_slot_schedule_and_radar_olx_removal.sql");
const ENABLE = read("scripts/olx-cloud-scheduled.enable.sql");
const START = Date.parse("2026-10-20T06:00:00.000Z"); // 08:00 Warsaw (CEST)

function filter(id: string, lastScannedAt: string | null) {
  return {
    id, name: id, sources: ["otodom", "olx"], city: "Łódź", districts: [], priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
    excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null, privateOnly: false, maxPricePerSqm: null,
    requiredKeywords: [], excludedKeywords: [], minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 5,
    finderScanIntervalMinutes: 300, finderOlxScanIntervalMinutes: 720, finderOlxStartTime: "08:00", isActive: true, lastScannedAt,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  } as never as SearchFilter;
}

function rpcClient(db: PGlite) {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      const result = db.query<{ r: unknown }>(`select public.enqueue_scheduled_finder_olx_job($1, $2, $3, $4::jsonb, $5, $6) as r`,
        [args.p_filter_id, args.p_run_id, args.p_request_url, JSON.stringify(args.p_filter_snapshot), args.p_shared_limit, args.p_dry_run])
        .then((value) => ({ data: value.rows[0].r, error: null }), (error: Error) => ({ data: null, error: { code: "P0001", message: error.message } }));
      assert.equal(name, "enqueue_scheduled_finder_olx_job");
      return { abortSignal: () => result };
    },
  } as never;
}

/** Time passes: every stored timestamp moves back (the database clock stays). */
async function elapse(db: PGlite, minutes: number) {
  await db.exec(`
    alter table public.search_filters disable trigger search_filters_finder_olx_anchor;
    update public.search_filters set finder_olx_schedule_anchor = finder_olx_schedule_anchor - interval '${minutes} minutes';
    alter table public.search_filters enable trigger search_filters_finder_olx_anchor;
    update public.olx_scan_jobs set idempotency_key = idempotency_key || ':past-' || gen_random_uuid() where idempotency_key like '%:olx-slot:%' and idempotency_key not like '%:past-%';
    update public.olx_scan_jobs set created_at = created_at - interval '${minutes} minutes', started_at = started_at - interval '${minutes} minutes',
      finished_at = finished_at - interval '${minutes} minutes', leased_until = leased_until - interval '${minutes} minutes';
    update public.source_scans set started_at = started_at - interval '${minutes} minutes';
    update public.finder_olx_slots set slot_at = slot_at - interval '${minutes} minutes', decided_at = decided_at - interval '${minutes} minutes';
    update public.olx_cloud_budget set reported_at = reported_at - interval '${minutes} minutes';
  `);
}

async function setup(filters: string[]) {
  const db = await database();
  await db.exec(CLAIM);
  await db.exec(SLOTS);
  await db.exec(ENABLE);
  await db.exec(`update public.olx_automation_control set max_claims_24h = 2`);
  await onlyActive(db, ...filters);
  // Schedule: 12 h at 08:00 Warsaw; the first slot is exactly now (08:00).
  await db.exec(`alter table public.search_filters disable trigger search_filters_finder_olx_anchor`);
  await db.query(`update public.search_filters set finder_olx_scan_interval_minutes = 720, finder_olx_schedule_anchor = date_trunc('minute', now() at time zone 'Europe/Warsaw') where id = any($1::uuid[])`, [filters]);
  await db.exec(`alter table public.search_filters enable trigger search_filters_finder_olx_anchor`);
  return db;
}

async function simulate(db: PGlite, filters: string[], hours: number, cloudflareDown: (minute: number) => boolean) {
  const last = new Map<string, string | null>(filters.map((id) => [id, null]));
  const portalStarts: number[] = [];
  const info = mock.method(console, "info", () => undefined);
  const warn = mock.method(console, "warn", () => undefined);
  try {
    for (let minute = 0; minute < hours * 60; minute += 5) {
      const now = new Date(START + minute * 60_000);
      await runFinderScanScheduler(now, {
        listFilters: async () => filters.map((id) => filter(id, last.get(id) ?? null)),
        hasRunningScan: async () => false,
        claimFilter: async (candidate, at) => { if (last.get(candidate.id) !== candidate.lastScannedAt) return false; last.set(candidate.id, at.toISOString()); return true; },
        revertClaim: async () => undefined,
        startScan: async (candidate) => { portalStarts.push(minute); return { runId: `${candidate.id}-${minute}`, status: "running", background: true, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0 }; },
        runScan: async (_candidate, start) => ({ runId: start.runId, status: "completed", sourcesRun: 1, sourcesCompleted: 1, sourcesFailed: 0, fetched: 0, normalized: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, actualErrors: 0, sourceResults: [], matchDiagnostics: { rejectedByPrice: 0, rejectedByPricePerSqm: 0, rejectedByRooms: 0, rejectedByDistrict: 0, rejectedByArea: 0, rejectedByBuildingType: 0, matched: 0 }, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0, warnings: [] }),
        scheduleOlx: (candidate) => scheduleFinderOlxJob(rpcClient(db), candidate),
        expireOlx: async () => { await db.query(`select public.expire_stale_scheduled_finder_olx_jobs()`); return null; },
      });
      // Cloudflare Worker: Cron every 15 min, one claim with its usage report; the job
      // (heartbeat every 30 s) finishes within ~4 min, i.e. before the next 5-minute tick.
      if (minute % 15 === 0 && !cloudflareDown(minute)) {
        const usage = { accountBrowserMs: 0, workerBrowserMs: 0, safeBudgetMs: 120_000, jobEstimateMs: 45_000 };
        await db.query(`select public.claim_scheduled_finder_olx_job('cloudflare-olx-scheduled', 120, $1::jsonb)`, [JSON.stringify(usage)]);
        // As completeOlxJob does: the job and its source_scans row are completed together.
        await db.exec(`update public.source_scans set status = 'completed' where id in (select source_scan_id from public.olx_scan_jobs where status = 'running' and requested_by = 'scheduler');
          update public.olx_scan_jobs set status = 'completed', finished_at = now(), leased_until = null where status = 'running' and requested_by = 'scheduler'`);
      }
      await elapse(db, 5);
    }
  } finally {
    info.mock.restore();
    warn.mock.restore();
  }
  return { portalStarts };
}

test("12 h at 08:00 for 3 days: jobs at 08:00 and 20:00 Warsaw, claimed within 15 min, portals every 300 min", async () => {
  const db = await setup([FLIP]);
  const { portalStarts } = await simulate(db, [FLIP], 72, () => false);
  const jobs = (await db.query<{ status: string; waited: number }>(`select status, extract(epoch from started_at - created_at)::int as waited from public.olx_scan_jobs order by created_at`)).rows;
  assert.equal(jobs.length, 6, "2 per day for 3 days");
  assert.ok(jobs.every((job) => job.status === "completed" && job.waited <= 15 * 60), JSON.stringify(jobs));
  const slots = (await db.query<{ status: string; offset_minutes: number }>(`select status, (extract(epoch from (slot_at - (select min(slot_at) from public.finder_olx_slots))) / 60)::int as offset_minutes from public.finder_olx_slots order by slot_at`)).rows;
  assert.deepEqual(slots.map((slot) => slot.offset_minutes), [0, 720, 1440, 2160, 2880, 3600], "fixed planned times, not 'finish + 12 h'");
  assert.deepEqual(portalStarts, [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600, 3900, 4200], "the other portals are unchanged");
});

test("Cloudflare down for a day: those slots end as diagnosed failures (no retry), nothing piles up, recovery takes the next slot only", async () => {
  const db = await setup([FLIP]);
  // Down from 07:30 on day 2 until 07:30 on day 3.
  await simulate(db, [FLIP], 72, (minute) => minute >= 1410 && minute < 2850);
  const jobs = (await db.query<{ status: string; error_code: string | null }>(`select status, error_code from public.olx_scan_jobs order by created_at`)).rows;
  const failed = jobs.filter((job) => job.error_code === "OLX_SCHEDULED_JOB_NOT_CLAIMED");
  assert.ok(failed.length >= 1, "an unclaimed job is failed with an explicit code after 6 h");
  assert.ok(jobs.length <= 6, "never more jobs than slots");
  assert.equal((await db.query(`select 1 from public.olx_scan_jobs where status in ('queued','running')`)).rows.length, 0, "no backlog at the end");
  const lastTwo = jobs.slice(-2).map((job) => job.status);
  assert.deepEqual(lastTwo, ["completed", "completed"], "after the outage the next slots run normally");
  const skipped = (await db.query<{ status: string; reason: string }>(`select status, reason from public.finder_olx_slots where status = 'missed'`)).rows;
  assert.ok(skipped.every((slot) => slot.reason === "OLX_JOB_IN_FLIGHT"), "a slot blocked by the stuck job is recorded once, with its cause");
});

test("two filters, 12 h each, global limit 2: never more than 2 automatic jobs in any 24 h", async () => {
  const db = await setup([FLIP, OTHER]);
  await simulate(db, [FLIP, OTHER], 48, () => false);
  const created = (await db.query<{ t: Date }>(`select created_at as t from public.olx_scan_jobs order by created_at`)).rows.map((row) => new Date(row.t).getTime());
  for (const at of created) assert.ok(created.filter((other) => other > at - 24 * 3_600_000 && other <= at).length <= 2);
  assert.equal(created.length, 4, "2 per 24 h over 48 h, shared by both filters");
  const missed = (await db.query<{ reason: string }>(`select reason from public.finder_olx_slots where status = 'missed'`)).rows;
  assert.ok(missed.length > 0 && missed.every((slot) => ["AUTOMATIC_DAILY_BUDGET_USED", "SHARED_DAILY_BUDGET_USED", "ANOTHER_FILTER_FIRST", "OLX_JOB_IN_FLIGHT"].includes(slot.reason)), JSON.stringify(missed));
});
