import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Independent verification of finder-scheduler.ts's REAL, unexported
 * claimFinderFilter/hasRunningFinderScan DB queries -- not the injected-
 * dependency happy-path tests in finder-scheduler.test.ts, which replace
 * claimFilter/hasRunningScan entirely with trivial stubs and therefore
 * never exercise the actual CAS SQL at all. This file drives
 * runFinderScanScheduler() through its DEFAULT dependencies (no
 * `overrides`), against a local, in-memory fake of the two Supabase tables
 * those functions touch (search_filters, source_scans). No real network
 * call, no .env.local, no Production: createAdminClient() itself is
 * mocked (once, at module scope -- node's test runner forbids re-mocking
 * the same specifier twice in one file) to return a mutable fake client
 * each test reconfigures via the `current*` indirection below.
 */

type Row = Record<string, unknown>;

function searchFiltersUpdateBuilder(rows: Row[]) {
  const filters: Array<(row: Row) => boolean> = [];
  let payload: Row | null = null;
  let applied = false;
  // The real CAS: only a row matching every WHERE clause is mutated, and
  // only ONE row (by id) can ever match in practice. Two "concurrent" calls
  // against the SAME pre-claim row therefore cannot both succeed: whichever
  // applies its filters against the row first sees the pre-claim value and
  // wins; the row is mutated immediately (synchronously, same as a
  // committed Postgres UPDATE), so the second call's filters are evaluated
  // against the ALREADY-ADVANCED value and match zero rows. Idempotent
  // (`applied` guard) because claimFinderFilter awaits `.maybeSingle()`
  // while revertFinderFilterClaim awaits the builder directly (no terminal
  // call) -- both must apply the mutation exactly once, however it is
  // eventually awaited.
  function apply(): Row | null {
    if (applied) return null;
    applied = true;
    const match = rows.find((row) => filters.every((predicate) => predicate(row)));
    if (!match || !payload) return null;
    Object.assign(match, payload);
    return match;
  }
  const builder = {
    update(value: Row) { payload = value; return builder; },
    eq(key: string, value: unknown) { filters.push((row) => row[key] === value); return builder; },
    is(key: string, value: unknown) { filters.push((row) => (value === null ? row[key] === null || row[key] === undefined : row[key] === value)); return builder; },
    select() { return builder; },
    abortSignal() { return builder; },
    async maybeSingle() {
      const match = apply();
      return { data: match ? { id: match.id } : null, error: null };
    },
    then(resolve: (value: unknown) => unknown) {
      apply();
      return Promise.resolve({ data: null, error: null }).then(resolve);
    },
  };
  return builder;
}

function sourceScansSelectBuilder(rows: Row[]) {
  const filters: Array<(row: Row) => boolean> = [];
  const builder = {
    select() { return builder; },
    eq(key: string, value: unknown) { filters.push((row) => row[key] === value); return builder; },
    in(key: string, values: unknown[]) { filters.push((row) => values.includes(row[key])); return builder; },
    limit() { return builder; },
    abortSignal() { return builder; },
    then(resolve: (value: unknown) => unknown) {
      const data = rows.filter((row) => filters.every((predicate) => predicate(row)));
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return builder;
}

function fakeSchedulerSupabase(searchFiltersRows: Row[], sourceScansRows: Row[] = []) {
  return {
    from(table: string) {
      if (table === "search_filters") return searchFiltersUpdateBuilder(searchFiltersRows);
      if (table === "source_scans") return sourceScansSelectBuilder(sourceScansRows);
      throw new Error(`unexpected table in this fake: ${table}`);
    },
  };
}

function filter(overrides: Record<string, unknown> = {}): Row {
  return {
    id: "filter-1", name: "Finder", sources: ["otodom"], city: "Łódź", districts: [],
    priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
    excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
    privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
    minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 5, finderScanIntervalMinutes: 60, isActive: true,
    lastScannedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides,
  };
}

let currentSupabase: unknown = fakeSchedulerSupabase([]);
let currentListFilters: () => Promise<Row[]> = async () => [];
let currentStartFinderScanForFilter: () => Promise<unknown> = async () => { throw new Error("not configured for this test"); };
let currentRunManualOtodomScan: () => Promise<unknown> = async () => { throw new Error("not configured for this test"); };

mock.module("server-only", { defaultExport: {} });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => currentSupabase } });
mock.module("@/features/flip-finder/server/search-filters", {
  namedExports: { listActiveSearchFiltersForScheduler: () => currentListFilters() },
});
mock.module("@/features/flip-finder/server/manual-scan", {
  namedExports: {
    startFinderScanForFilter: () => currentStartFinderScanForFilter(),
    runManualOtodomScan: () => currentRunManualOtodomScan(),
  },
});

const { runFinderScanScheduler } = await import("./finder-scheduler.ts");

const now = new Date("2026-10-04T12:00:00.000Z");

test("the real CAS: two concurrent scheduler ticks claiming the SAME due filter -- exactly one wins, the other is skipped, never two runs", async () => {
  const dueFilter = filter({ id: "race-1", lastScannedAt: null });
  const searchFiltersRows: Row[] = [{ id: "race-1", last_scanned_at: null }];
  currentSupabase = fakeSchedulerSupabase(searchFiltersRows, []);
  let listCalls = 0;
  currentListFilters = async () => { listCalls += 1; return [dueFilter]; };
  let startCalls = 0;
  currentStartFinderScanForFilter = async () => { startCalls += 1; return { runId: "run-a", status: "running", background: true, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0 }; };
  currentRunManualOtodomScan = async () => ({ runId: "run-a", status: "completed", sourcesRun: 1, sourcesCompleted: 1, sourcesFailed: 0, fetched: 0, normalized: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, actualErrors: 0, sourceResults: [], matchDiagnostics: { rejectedByPrice: 0, rejectedByPricePerSqm: 0, rejectedByRooms: 0, rejectedByDistrict: 0, rejectedByArea: 0, rejectedByBuildingType: 0, matched: 0 }, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0, warnings: [] });

  // Both "instances" read the filter list (and therefore filter.lastScannedAt
  // = null) BEFORE either claims -- the real race window -- then both race
  // to claim it via the real, unexported claimFinderFilter.
  const [first, second] = await Promise.all([runFinderScanScheduler(now), runFinderScanScheduler(now)]);

  assert.equal(startCalls, 1, "only ONE of the two concurrent ticks may ever start a scan for the same filter");
  const totalStarted = first.started + second.started;
  assert.equal(totalStarted, 1, "exactly one tick must report having started a run; the CAS loser must report zero");
  const totalSkipped = first.skippedRunning + second.skippedRunning;
  assert.equal(totalSkipped, 1, "the CAS loser must be accounted for as skipped, not silently dropped or duplicated");
  assert.equal(listCalls, 2, "sanity check: both ticks really did run independently against the same fake row");
});

test("a transient (non-'already running') failure in startScan, after a successful claim, does not permanently delay the next automatic attempt", async () => {
  const dueFilter = filter({ id: "transient-fail", lastScannedAt: null });
  const searchFiltersRows: Row[] = [{ id: "transient-fail", last_scanned_at: null }];
  currentSupabase = fakeSchedulerSupabase(searchFiltersRows, []);
  currentListFilters = async () => [dueFilter];
  // Simulates a genuinely transient failure (a DB timeout, a dropped
  // connection) -- NOT "Skan tego filtra już trwa.", so isRunningScanError
  // must be false and this must surface as a real, reported error.
  currentStartFinderScanForFilter = async () => { throw new Error("DB_TIMEOUT: connection reset"); };
  currentRunManualOtodomScan = async () => { throw new Error("must not run"); };

  const result = await runFinderScanScheduler(now);

  assert.equal(result.status, "partial", "a genuine, non-lock failure must be surfaced, not swallowed as a clean 'completed' run");
  assert.equal(result.errors.length, 1);

  const rowAfter = searchFiltersRows.find((row) => row.id === "transient-fail");
  assert.equal(
    rowAfter?.last_scanned_at,
    null,
    "claimFinderFilter must not leave last_scanned_at permanently advanced when the scan it claimed for never actually started -- " +
    "otherwise a single transient DB error silently delays the next automatic attempt by a full finder_scan_interval_minutes, " +
    "even though the five-minute scheduler trigger could have retried it on its very next tick",
  );
});
