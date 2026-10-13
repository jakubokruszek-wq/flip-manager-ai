import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Production incident, 13.10.2026: filter "Flip" (12 sources, interval 300
 * min) started at 07:30 UTC. Eleven portals finished; OLX's source_scans row
 * stayed "pending" in the separate OLX queue until a manual Cloudflare
 * stage-2 test completed it at 20:06. hasRunningFinderScan counted that OLX
 * row, so no further cycle of the other portals started for 12 hours.
 *
 * This replays the day tick by tick (every 5 minutes, the pg_cron cadence
 * after this change) through the real runFinderScanScheduler, the real
 * hasRunningFinderScan query and the real claimFinderFilter CAS, against an
 * in-memory source_scans/search_filters store.
 */

mock.module("server-only", { defaultExport: {} });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => ({}) } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { listActiveSearchFiltersForScheduler: async () => [] } });
mock.module("@/features/flip-finder/server/manual-scan", { namedExports: { startFinderScanForFilter: async () => { throw new Error("injected per test"); }, runManualOtodomScan: async () => { throw new Error("injected per test"); } } });

const { runFinderScanScheduler, hasRunningFinderScan, claimFinderFilter, finderSchedulerLockSources, FINDER_SCHEDULER_INDEPENDENT_SOURCES } = await import("./finder-scheduler.ts");

const PORTALS = ["otodom", "gratka", "morizon", "allegro_lokalnie", "domiporta", "nieruchomosci_online", "sprzedajemy", "adresowo", "oferty_net", "domy", "official_cooperative"];
const SOURCES = [...PORTALS, "olx"];

type Row = Record<string, unknown>;
type Store = { filter: { id: string; last_scanned_at: string | null }; scans: Row[]; olxJobs: Row[]; runs: number };

function baseFilter(store: Store) {
  return {
    id: store.filter.id, name: "Flip", sources: SOURCES, city: "Łódź", districts: [],
    priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
    excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
    privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
    minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 5, finderScanIntervalMinutes: 300, isActive: true,
    lastScannedAt: store.filter.last_scanned_at, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  } as never;
}

/** Supabase query builder subset used by hasRunningFinderScan and claimFinderFilter. */
function fakeDb(store: Store) {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let patch: Row | null = null;
      const rows = () => (table === "search_filters" ? [store.filter as Row] : store.scans);
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (value: Row) => { patch = value; return builder; },
        eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return builder; },
        is: (column: string, value: unknown) => { filters.push((row) => (value === null ? row[column] == null : row[column] === value)); return builder; },
        in: (column: string, values: unknown[]) => { filters.push((row) => values.includes(row[column])); return builder; },
        limit: () => builder,
        abortSignal: () => builder,
        // Single-statement CAS, as Postgres executes UPDATE ... WHERE: check and write in one step.
        maybeSingle: async () => {
          const matched = rows().filter((row) => filters.every((filter) => filter(row)));
          if (patch) for (const row of matched) Object.assign(row, patch);
          return { data: matched[0] ? { id: matched[0].id } : null, error: null };
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: rows().filter((row) => filters.every((filter) => filter(row))), error: null }).then(resolve, reject),
      };
      return builder;
    },
  };
}

/** One scheduler tick with the real lock query and CAS; the scan itself is simulated. */
async function tick(store: Store, at: string, options: { countOlxAsLock?: boolean } = {}) {
  const db = fakeDb(store) as never;
  return runFinderScanScheduler(new Date(at), {
    listFilters: async () => [baseFilter(store)],
    hasRunningScan: options.countOlxAsLock
      // The pre-fix query: every active source, OLX included.
      ? async (filter) => store.scans.some((row) => row.search_filter_id === (filter as { id: string }).id && SOURCES.includes(String(row.source)) && (row.status === "pending" || row.status === "running"))
      : (filter) => hasRunningFinderScan(db, filter),
    claimFilter: (filter, now) => claimFinderFilter(db, filter, now),
    revertClaim: async () => undefined,
    startScan: async () => {
      const runId = `run-${++store.runs}`;
      for (const source of PORTALS) store.scans.push({ id: `${runId}-${source}`, search_filter_id: store.filter.id, source, status: "pending", scan_run_id: runId });
      // The OLX queue keeps at most one job per filter in flight (proven in manual-scan-olx-isolation.test.ts).
      if (!store.olxJobs.some((job) => job.status === "queued" || job.status === "running")) {
        store.olxJobs.push({ id: `olx-${runId}`, scan_run_id: runId, status: "queued" });
        store.scans.push({ id: `${runId}-olx`, search_filter_id: store.filter.id, source: "olx", status: "pending", scan_run_id: runId });
      }
      return { runId, status: "running", background: true, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0 };
    },
    runScan: async (_filter, start) => {
      for (const row of store.scans) if (row.scan_run_id === start.runId && row.source !== "olx") row.status = "completed";
      return { runId: start.runId, status: "running", sourcesRun: 12, sourcesCompleted: 11, sourcesFailed: 0, sourceResults: [{ source: "olx", status: "pending" }] } as never;
    },
  });
}

function store(): Store {
  return { filter: { id: "flip", last_scanned_at: "2026-10-13T02:30:00.000Z" }, scans: [], olxJobs: [], runs: 0 };
}

function* ticks(from: string, to: string) {
  for (let at = Date.parse(from); at <= Date.parse(to); at += 5 * 60_000) yield new Date(at).toISOString();
}

/** OLX completes late, through completeOlxJob, which no longer touches search_filters.last_scanned_at. */
function completeOlx(state: Store) {
  for (const job of state.olxJobs) if (job.status === "queued") job.status = "completed";
  for (const row of state.scans) if (row.source === "olx" && row.status === "pending") row.status = "completed";
}

test("13.10 regression: with the pre-fix lock, a pending OLX row blocks every other portal for 12 hours", async () => {
  const state = store();
  const starts: string[] = [];
  for (const at of ticks("2026-10-13T07:30:00.000Z", "2026-10-13T20:05:00.000Z")) {
    if ((await tick(state, at, { countOlxAsLock: true })).started) starts.push(at);
  }
  assert.deepEqual(starts, ["2026-10-13T07:30:00.000Z"], "only the 07:30 cycle ever starts");
});

test("OLX waits 12 hours; the other portals still run every 300 minutes, every 5-minute tick in between skips as not due", async () => {
  const state = store();
  const starts: string[] = [];
  let notDueTicks = 0;
  for (const at of ticks("2026-10-13T07:30:00.000Z", "2026-10-13T22:35:00.000Z")) {
    if (at === "2026-10-13T20:05:00.000Z") completeOlx(state); // completed 20:06 in Production
    const summary = await tick(state, at);
    if (summary.started) starts.push(at);
    else if (summary.skippedNotDue) notDueTicks += 1;
    assert.equal(summary.errors.length, 0, at);
  }
  assert.deepEqual(starts, ["2026-10-13T07:30:00.000Z", "2026-10-13T12:30:00.000Z", "2026-10-13T17:30:00.000Z", "2026-10-13T22:30:00.000Z"]);
  assert.ok(notDueTicks > 150, "the 5-minute ticks between cycles do nothing");
  // The late OLX completion did not move the cadence: 22:30 = 17:30 + 300 min, not 20:06 + 300 min.
  assert.equal(state.filter.last_scanned_at, "2026-10-13T22:30:00.000Z");
  // One OLX job while the first was queued; the next one only after it completed.
  assert.deepEqual(state.olxJobs.map((job) => job.scan_run_id), ["run-1", "run-4"]);
});

test("a pending or running row of another portal still blocks the next cycle (no duplicate portal scan)", async () => {
  const state = store();
  state.scans.push({ id: "old-otodom", search_filter_id: "flip", source: "otodom", status: "pending", scan_run_id: "run-old" });
  const blocked = await tick(state, "2026-10-13T07:30:00.000Z");
  assert.equal(blocked.started, 0);
  assert.equal(blocked.skippedRunning, 1);
  assert.equal(state.filter.last_scanned_at, "2026-10-13T02:30:00.000Z", "a blocked filter keeps its clock");
  state.scans[0].status = "running";
  assert.equal((await tick(state, "2026-10-13T07:35:00.000Z")).started, 0);
  state.scans[0].status = "completed";
  assert.equal((await tick(state, "2026-10-13T07:40:00.000Z")).started, 1, "the next tick after the portal finished starts the cycle");
});

test("two concurrent scheduler invocations claim the filter once", async () => {
  const state = store();
  const [first, second] = await Promise.all([tick(state, "2026-10-13T07:30:00.000Z"), tick(state, "2026-10-13T07:30:00.000Z")]);
  assert.equal(first.started + second.started, 1);
  assert.equal(first.skippedRunning + second.skippedRunning, 1);
  assert.equal(state.runs, 1);
  assert.equal(state.olxJobs.length, 1);
});

test("only OLX is independent; Facebook Watcher rows were never Finder locks and stay so", async () => {
  assert.deepEqual([...FINDER_SCHEDULER_INDEPENDENT_SOURCES], ["olx"]);
  const state = store();
  const lockSources = finderSchedulerLockSources(baseFilter(state));
  assert.deepEqual(lockSources.sort(), [...PORTALS].sort());
  state.scans.push({ id: "fb", search_filter_id: "flip", source: "facebook", status: "running", scan_run_id: "watcher" });
  state.scans.push({ id: "olx", search_filter_id: "flip", source: "olx", status: "running", scan_run_id: "run-old" });
  assert.equal(await hasRunningFinderScan(fakeDb(state) as never, baseFilter(state)), false);
});

test("scheduler logs the cycle start, skips with a reason, the portion result and failures", async () => {
  const state = store();
  const logs: Array<[string, unknown]> = [];
  const info = mock.method(console, "info", (event: string, payload: unknown) => { logs.push([event, payload]); });
  const error = mock.method(console, "error", (event: string, payload: unknown) => { logs.push([event, payload]); });
  try {
    await tick(state, "2026-10-13T07:30:00.000Z");
    state.scans.push({ id: "busy", search_filter_id: "flip", source: "gratka", status: "running", scan_run_id: "run-1" });
    await tick(state, "2026-10-13T12:30:00.000Z");
    state.scans.pop();
    const failed = await runFinderScanScheduler(new Date("2026-10-13T17:30:00.000Z"), {
      listFilters: async () => [baseFilter(state)], hasRunningScan: async () => false, claimFilter: async () => true, revertClaim: async () => undefined,
      startScan: async () => { throw new Error("FINDER_RESERVE_TIMEOUT"); }, runScan: async () => { throw new Error("unreachable"); },
    });
    assert.equal(failed.status, "partial");
  } finally {
    info.mock.restore();
    error.mock.restore();
  }
  const events = logs.map(([event]) => event);
  assert.ok(events.includes("FINDER_SCHEDULER_CYCLE_START"));
  const result = logs.find(([event]) => event === "FINDER_SCHEDULER_RUN_RESULT")?.[1] as Record<string, unknown>;
  assert.deepEqual({ runId: result.runId, status: result.status, sourcesCompleted: result.sourcesCompleted, pendingSources: result.pendingSources }, { runId: "run-1", status: "running", sourcesCompleted: 11, pendingSources: ["olx"] });
  assert.deepEqual(logs.find(([event]) => event === "FINDER_SCHEDULER_SKIPPED")?.[1], { filterId: "flip", reason: "SOURCE_SCAN_IN_PROGRESS" });
  assert.deepEqual(logs.find(([event]) => event === "FINDER_SCHEDULER_FILTER_FAILED")?.[1], { filterId: "flip", cause: "FINDER_RESERVE_TIMEOUT" });
  assert.doesNotMatch(JSON.stringify(logs), /Bearer|secret|token/i, "no credentials in scheduler logs");
});
