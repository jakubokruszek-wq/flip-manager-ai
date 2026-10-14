import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SearchFilter } from "@/features/flip-finder";

/**
 * Separate OLX schedule end to end: the real runFinderScanScheduler and the
 * real scheduleFinderOlxJob, talking to the real enqueue_scheduled_finder_olx_job
 * in PGlite. The scheduler is called every 5 minutes (pg_cron after the change);
 * each tick moves the database clock 5 minutes by shifting stored timestamps.
 */

mock.module("server-only", { defaultExport: {} });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => ({}) } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { listActiveSearchFiltersForScheduler: async () => [] } });
mock.module("@/features/flip-finder/server/manual-scan", { namedExports: { startFinderScanForFilter: async () => { throw new Error("injected per test"); }, runManualOtodomScan: async () => { throw new Error("injected per test"); } } });

const { runFinderScanScheduler } = await import("./finder-scheduler.ts");
const { scheduleFinderOlxJob, runFinderOlxSchedulerPhase, parseDecision, olxScheduleNote } = await import("./finder-olx-schedule.ts");
const { database, elapseMinutes, onlyActive, FLIP, OTHER } = await import("./finder-olx-schedule.fixture.ts");

const START = Date.parse("2026-10-13T07:30:00.000Z");
const TICK_MS = 5 * 60_000;

function filter(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, name: id === FLIP ? "Flip" : "Inny", sources: ["otodom", "olx"], city: "Łódź", districts: [],
    priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
    excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
    privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
    minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 5, finderScanIntervalMinutes: 300,
    finderOlxScanIntervalMinutes: 1440, isActive: true, lastScannedAt: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  } as never;
}

/** A Supabase-shaped client whose rpc() runs the real SQL function in PGlite. */
function rpcClient(db: PGlite, calls: { count: number }) {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      calls.count += 1;
      assert.equal(name, "enqueue_scheduled_finder_olx_job");
      const result = db.query<{ result: unknown }>(
        `select public.enqueue_scheduled_finder_olx_job($1, $2, $3, $4::jsonb, $5, $6) as result`,
        [args.p_filter_id, args.p_run_id, args.p_request_url, JSON.stringify(args.p_filter_snapshot), args.p_shared_limit, args.p_dry_run],
      ).then((value) => ({ data: value.rows[0].result, error: null }), (error: Error) => ({ data: null, error: { code: "P0001", message: error.message } }));
      return { abortSignal: () => result };
    },
  } as never;
}

function summary(runId: string, warnings: string[] = []) {
  return { runId, status: "completed" as const, sourcesRun: 1, sourcesCompleted: 1, sourcesFailed: 0, fetched: 0, normalized: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, actualErrors: 0, sourceResults: [], matchDiagnostics: { rejectedByPrice: 0, rejectedByPricePerSqm: 0, rejectedByRooms: 0, rejectedByDistrict: 0, rejectedByArea: 0, rejectedByBuildingType: 0, matched: 0 }, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0, warnings };
}

/** Portals' cadence clock with the same compare-and-swap rule as claimFinderFilter. */
function portalStore(ids: string[]) {
  const last = new Map<string, string | null>(ids.map((id) => [id, null]));
  const starts: Array<{ id: string; at: number }> = [];
  const notes: string[] = [];
  return {
    starts, notes, last,
    deps: (now: Date) => ({
      hasRunningScan: async () => false,
      claimFilter: async (candidate: { id: string; lastScannedAt: string | null }, at: Date) => {
        if (last.get(candidate.id) !== candidate.lastScannedAt) return false;
        last.set(candidate.id, at.toISOString());
        return true;
      },
      revertClaim: async () => undefined,
      startScan: async (candidate: { id: string }) => {
        starts.push({ id: candidate.id, at: now.getTime() });
        return { runId: `run-${candidate.id}-${now.getTime()}`, status: "running" as const, background: true, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0 };
      },
      runScan: async (_candidate: unknown, start: { runId: string }, context?: { olxNote: string | null }) => {
        if (context?.olxNote) notes.push(context.olxNote);
        return summary(start.runId, context?.olxNote ? [context.olxNote] : []);
      },
    }),
  };
}

async function olxJobs(db: PGlite) {
  return (await db.query<{ search_filter_id: string; requested_by: string | null; status: string; age_minutes: number }>(
    `select search_filter_id, requested_by, status, round(extract(epoch from (now() - created_at)) / 60)::int as age_minutes from public.olx_scan_jobs order by created_at`)).rows;
}

test("72 h of 5-minute ticks: portals every 300 min, OLX every 1440 min, OLX completing 12 h late moves nothing", async () => {
  const db = await database();
  await onlyActive(db, FLIP);
  const calls = { count: 0 };
  const store = portalStore([FLIP]);
  const info = mock.method(console, "info", () => undefined);
  let ticks = 0;
  try {
    for (let at = START; at < START + 72 * 60 * 60_000; at += TICK_MS) {
      const now = new Date(at);
      const flip = filter(FLIP, { lastScannedAt: store.last.get(FLIP) });
      await runFinderScanScheduler(now, {
        listFilters: async () => [flip],
        ...store.deps(now),
        scheduleOlx: (candidate: SearchFilter) => scheduleFinderOlxJob(rpcClient(db, calls), candidate),
      } as never);
      ticks += 1;
      // The OLX worker finishes each job 12 h after it was ordered (13.10: 07:30 -> 20:06).
      await db.exec(`update public.olx_scan_jobs set status = 'completed', finished_at = now() where status = 'queued' and created_at <= now() - interval '12 hours';
        update public.source_scans set status = 'completed' where source = 'olx' and status = 'pending' and started_at <= now() - interval '12 hours';`);
      await elapseMinutes(db, 5);
    }
  } finally {
    info.mock.restore();
  }
  assert.equal(ticks, 864, "3 days x 288 scheduler calls (was 3 x 1440 every minute)");
  assert.deepEqual(store.starts.map((start) => (start.at - START) / 60_000), [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600, 3900, 4200], "portals keep their 300-minute rhythm");
  const jobs = await olxJobs(db);
  assert.equal(jobs.length, 3, "one automatic OLX job per 24 h");
  assert.deepEqual(jobs.map((job) => job.age_minutes), [4320, 2880, 1440], "ordered at 07:30 each day, not after the late completion");
  assert.ok(jobs.every((job) => job.requested_by === "scheduler"));
  assert.equal(calls.count, 864, "one bounded database decision per tick, no retries");
  assert.ok(store.notes.some((note) => note.startsWith("olx: OLX_SCHEDULED:")));
  assert.ok(store.notes.some((note) => note.startsWith("olx: OLX_SKIPPED_OLX_JOB_IN_FLIGHT:")));
  assert.ok(store.notes.some((note) => note.startsWith("olx: OLX_SKIPPED_OLX_INTERVAL_NOT_ELAPSED:") && note.includes("następny dopuszczalny termin")));
});

test("two filters on one Cloudflare account share one automatic OLX job per 24 h", async () => {
  const db = await database();
  await onlyActive(db, FLIP, OTHER);
  const calls = { count: 0 };
  const store = portalStore([FLIP, OTHER]);
  const info = mock.method(console, "info", () => undefined);
  try {
    for (let at = START; at < START + 48 * 60 * 60_000; at += TICK_MS) {
      const now = new Date(at);
      await db.exec(`update public.olx_scan_jobs set status = 'completed' where status = 'queued'; update public.source_scans set status = 'completed' where status = 'pending';`);
      await runFinderScanScheduler(now, {
        listFilters: async () => [filter(FLIP, { lastScannedAt: store.last.get(FLIP) }), filter(OTHER, { lastScannedAt: store.last.get(OTHER) })],
        ...store.deps(now),
        scheduleOlx: (candidate: SearchFilter) => scheduleFinderOlxJob(rpcClient(db, calls), candidate),
      } as never);
      await elapseMinutes(db, 5);
    }
  } finally {
    info.mock.restore();
  }
  const jobs = await olxJobs(db);
  assert.equal(jobs.length, 2, "48 h -> two automatic OLX jobs in total, not two per filter");
  assert.deepEqual(new Set(jobs.map((job) => job.search_filter_id)), new Set([FLIP, OTHER]), "the filters take turns");
});

test("concurrent scheduler invocations (pg_cron + GitHub Actions) queue one OLX job and start the portals once", async () => {
  const db = await database();
  const calls = { count: 0 };
  const store = portalStore([FLIP]);
  const now = new Date(START);
  const info = mock.method(console, "info", () => undefined);
  try {
    const run = () => runFinderScanScheduler(now, {
      listFilters: async () => [filter(FLIP, { lastScannedAt: null })],
      ...store.deps(now),
      scheduleOlx: (candidate: SearchFilter) => scheduleFinderOlxJob(rpcClient(db, calls), candidate),
    } as never);
    const results = await Promise.all([run(), run(), run()]);
    assert.equal(results.reduce((sum, result) => sum + result.olx.enqueued, 0), 1);
    assert.equal(results.reduce((sum, result) => sum + result.started, 0), 1);
  } finally {
    info.mock.restore();
  }
  assert.equal((await olxJobs(db)).length, 1);
  assert.equal(store.starts.length, 1);
});

test("an OLX failure never stops the portals: RPC error, missing function, timeout, garbage, unknown interval", async () => {
  const failures: Array<[string, () => unknown]> = [
    ["OLX_SCHEDULE_UNAVAILABLE", () => Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })],
    ["OLX_SCHEDULE_CHECK_FAILED", () => Promise.resolve({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } })],
    ["OLX_SCHEDULE_CHECK_FAILED", () => Promise.reject(new Error("AbortError: timeout"))],
    ["OLX_SCHEDULE_CHECK_FAILED", () => Promise.resolve({ data: { decision: "enqueued", reason: null }, error: null })],
    ["OLX_SCHEDULE_CHECK_FAILED", () => Promise.resolve({ data: { decision: "maybe" }, error: null })],
  ];
  const warn = mock.method(console, "warn", () => undefined);
  const info = mock.method(console, "info", () => undefined);
  try {
    for (const [reason, answer] of failures) {
      const store = portalStore([FLIP]);
      const now = new Date(START);
      const client = { rpc: () => ({ abortSignal: answer }) } as never;
      const result = await runFinderScanScheduler(now, {
        listFilters: async () => [filter(FLIP)],
        ...store.deps(now),
        scheduleOlx: (candidate: SearchFilter) => scheduleFinderOlxJob(client, candidate),
      } as never);
      assert.equal(result.started, 1, `${reason}: the portals start`);
      assert.equal(result.status, "completed");
      assert.equal(result.olx.enqueued, 0);
      assert.equal(result.olx.decisions[0].reason, reason);
      assert.ok(store.notes[0].startsWith(`olx: OLX_SKIPPED_${reason}:`), store.notes[0]);
    }
    // The column is not readable yet (migration not applied): no database call at all.
    let rpcCalls = 0;
    const store = portalStore([FLIP]);
    const now = new Date(START);
    const result = await runFinderScanScheduler(now, {
      listFilters: async () => [filter(FLIP, { finderOlxScanIntervalMinutes: null })],
      ...store.deps(now),
      scheduleOlx: (candidate: SearchFilter) => scheduleFinderOlxJob({ rpc: () => { rpcCalls += 1; throw new Error("unexpected"); } } as never, candidate),
    } as never);
    assert.equal(rpcCalls, 0);
    assert.equal(result.olx.decisions[0].reason, "OLX_INTERVAL_UNAVAILABLE");
    assert.equal(result.started, 1);
    // A scheduleOlx that throws outright is contained as well.
    const throwing = await runFinderScanScheduler(now, {
      listFilters: async () => [filter(FLIP)],
      ...portalStore([FLIP]).deps(now),
      scheduleOlx: async () => { throw new Error("boom"); },
    } as never);
    assert.equal(throwing.started, 1);
    assert.equal(throwing.olx.decisions[0].reason, "OLX_SCHEDULE_CHECK_FAILED");
  } finally {
    warn.mock.restore();
    info.mock.restore();
  }
});

test("a budget reason does not end the tick (every open slot is evaluated); a missing function does; at most one job per tick", async () => {
  const asked: string[] = [];
  const decide = (reason: string | null, decision = "skipped") => async (candidate: { id: string }) => {
    asked.push(candidate.id);
    return parseDecision(candidate.id, { decision, reason, job_id: decision === "enqueued" ? "job" : null, run_id: decision === "enqueued" ? "run" : null }, 1);
  };
  const info = mock.method(console, "info", () => undefined);
  try {
    const filters = [filter(FLIP), filter(OTHER)];
    await runFinderOlxSchedulerPhase(filters, decide("AUTOMATIC_DAILY_BUDGET_USED") as never);
    assert.deepEqual(asked, [FLIP, OTHER]);
    asked.length = 0;
    await runFinderOlxSchedulerPhase(filters, decide("OLX_SCHEDULE_UNAVAILABLE") as never);
    assert.deepEqual(asked, [FLIP]);
    asked.length = 0;
    await runFinderOlxSchedulerPhase(filters, decide(null, "enqueued") as never);
    assert.deepEqual(asked, [FLIP]);
    asked.length = 0;
    await runFinderOlxSchedulerPhase(filters, decide("OLX_INTERVAL_NOT_ELAPSED") as never);
    assert.deepEqual(asked, [FLIP, OTHER], "a per-filter reason lets the next filter be checked");
    asked.length = 0;
    await runFinderOlxSchedulerPhase([filter(FLIP, { sources: ["otodom"] }), filter(OTHER, { isActive: false }), filter("fb", { sources: ["facebook"] })], decide(null, "enqueued") as never);
    assert.deepEqual(asked, [], "filters without OLX, paused filters and Facebook-only filters never touch the OLX schedule");
  } finally {
    info.mock.restore();
  }
});

test("an OLX-only filter gets OLX from its own schedule and never starts an empty portals' run", async () => {
  const db = await database();
  const calls = { count: 0 };
  const store = portalStore([FLIP]);
  const now = new Date(START);
  const info = mock.method(console, "info", () => undefined);
  try {
    const result = await runFinderScanScheduler(now, {
      listFilters: async () => [filter(FLIP, { sources: ["olx"] })],
      ...store.deps(now),
      scheduleOlx: (candidate: SearchFilter) => scheduleFinderOlxJob(rpcClient(db, calls), candidate),
    } as never);
    assert.equal(result.olx.enqueued, 1);
    assert.equal(result.due, 0);
    assert.equal(store.starts.length, 0);
  } finally {
    info.mock.restore();
  }
});

test("Finder reports the OLX decision in readable Polish", () => {
  assert.match(olxScheduleNote(undefined), /^olx: OLX_SEPARATE_SCHEDULE:/);
  const skipped = parseDecision(FLIP, { decision: "skipped", reason: "SHARED_DAILY_BUDGET_USED", next_allowed_at: "2026-10-14T07:30:00+00:00", shared_limit: 1, total_jobs_in_window: 1 }, 1);
  assert.equal(olxScheduleNote(skipped), "olx: OLX_SKIPPED_SHARED_DAILY_BUDGET_USED: wykorzystany wspólny budżet OLX na 24 h (razem z ręcznymi skanami Findera); następny dopuszczalny termin: 2026-10-14T07:30:00+00:00.");
  const budget = parseDecision(FLIP, { decision: "skipped", reason: "BROWSER_BUDGET_INSUFFICIENT", start_time: "08:00", slot_at: "2026-10-14T06:00:00+00:00", browser_budget: { remaining_ms: 30_000, fits_one_job: false } }, 1);
  assert.match(olxScheduleNote(budget), /^olx: OLX_SKIPPED_BROWSER_BUDGET_INSUFFICIENT: brak dziennego budżetu przeglądarki Cloudflare/);
  assert.equal(budget.browserBudget?.remainingMs, 30_000);
  assert.equal(budget.schedule?.startTime, "08:00");
  assert.equal(skipped.budget?.totalJobs, 1);
  assert.equal(parseDecision(FLIP, { decision: "skipped", reason: "SOMETHING_NEW" }, 1).reason, "OLX_SCHEDULE_CHECK_FAILED", "an unknown reason is not trusted");
});

test("orphaned automatic jobs are expired first on every tick; an expiry failure never stops OLX or the portals", async () => {
  const order: string[] = [];
  const store = portalStore([FLIP]);
  const now = new Date(START);
  const info = mock.method(console, "info", () => undefined);
  const warn = mock.method(console, "warn", () => undefined);
  try {
    const result = await runFinderScanScheduler(now, {
      listFilters: async () => [filter(FLIP)],
      ...store.deps(now),
      expireOlx: async () => { order.push("expire"); return { unclaimedExpired: 1, leaseExpired: 0 }; },
      scheduleOlx: async (candidate: SearchFilter) => { order.push("schedule"); return parseDecision(candidate.id, { decision: "skipped", reason: "OLX_INTERVAL_NOT_ELAPSED" }, 1); },
    } as never);
    assert.deepEqual(order, ["expire", "schedule"]);
    assert.deepEqual(result.olx.expired, { unclaimedExpired: 1, leaseExpired: 0 });
    assert.ok(warn.mock.calls.some((call) => call.arguments[0] === "FINDER_OLX_SCHEDULED_JOBS_EXPIRED"));
    const failing = await runFinderScanScheduler(now, {
      listFilters: async () => [filter(FLIP)],
      ...portalStore([FLIP]).deps(now),
      expireOlx: async () => { throw new Error("db down"); },
      scheduleOlx: async (candidate: SearchFilter) => parseDecision(candidate.id, { decision: "skipped", reason: "OLX_INTERVAL_NOT_ELAPSED" }, 1),
    } as never);
    assert.equal(failing.started, 1);
    assert.equal(failing.olx.expired, null);
    assert.equal(failing.olx.decisions.length, 1);
  } finally {
    info.mock.restore();
    warn.mock.restore();
  }
});
