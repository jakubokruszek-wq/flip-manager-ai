import assert from "node:assert/strict";
import test, { mock } from "node:test";

mock.module("server-only", { defaultExport: {} });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => ({}) } });
mock.module("@/features/flip-finder/server/search-filters", {
  namedExports: { listActiveSearchFiltersForScheduler: async () => [] },
});
mock.module("@/features/flip-finder/server/manual-scan", {
  namedExports: {
    startFinderScanForFilter: async () => ({ runId: "unused", status: "running", background: true, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0 }),
    runManualOtodomScan: async () => ({ runId: "unused", status: "completed", sourcesRun: 0, sourcesCompleted: 0, sourcesFailed: 0, fetched: 0, normalized: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, actualErrors: 0, sourceResults: [], matchDiagnostics: { rejectedByPrice: 0, rejectedByPricePerSqm: 0, rejectedByRooms: 0, rejectedByDistrict: 0, rejectedByArea: 0, rejectedByBuildingType: 0, matched: 0 }, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0, warnings: [] }),
  },
});

const { dueFinderFilters, finderFilterCanRun, finderScanIntervalMinutes, isFinderScanDue, runFinderScanScheduler } = await import("./finder-scheduler.ts");

function filter(overrides: Record<string, unknown> = {}) {
  return {
    id: "filter-1", name: "Finder", sources: ["otodom"], city: "Łódź", districts: [],
    priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
    excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
    privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
    minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 5, finderScanIntervalMinutes: 60, isActive: true,
    lastScannedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides,
  } as never;
}

const now = new Date("2026-10-04T12:00:00.000Z");

test("Finder uses the persisted per-filter interval and waits until it elapses", () => {
  assert.equal(finderScanIntervalMinutes(30), 30);
  assert.equal(finderScanIntervalMinutes("not-a-number"), 60);
  assert.equal(isFinderScanDue({ isActive: true, lastScannedAt: null, scanIntervalMinutes: 30, now }), true);
  assert.equal(isFinderScanDue({ isActive: true, lastScannedAt: "2026-10-04T11:31:00.000Z", scanIntervalMinutes: 30, now }), false);
  assert.equal(isFinderScanDue({ isActive: true, lastScannedAt: "2026-10-04T11:30:00.000Z", scanIntervalMinutes: 30, now }), true);
  assert.equal(isFinderScanDue({ isActive: false, lastScannedAt: null, scanIntervalMinutes: 30, now }), false);
});

test("Finder cadence is independent from the legacy global Watcher interval", () => {
  const candidate = filter({
    id: "finder-cadence",
    scanIntervalMinutes: 5,
    finderScanIntervalMinutes: 60,
    lastScannedAt: "2026-10-04T11:31:00.000Z",
  });
  assert.deepEqual(dueFinderFilters([candidate], now), [], "the Watcher value must not trigger a Finder run");
});

test("only active filters with an approved Finder source are due", () => {
  const filters = [
    filter({ id: "due", lastScannedAt: null }),
    filter({ id: "facebook-only", sources: ["facebook"], lastScannedAt: null }),
    filter({ id: "unavailable", sources: ["bezposrednio"], lastScannedAt: null }),
    filter({ id: "paused", isActive: false, lastScannedAt: null }),
  ];
  assert.equal(finderFilterCanRun(filters[0]), true);
  assert.equal(finderFilterCanRun(filters[1]), true, "Facebook-only filters are reconciled from saved Watcher listings; no Facebook acquisition is started");
  assert.equal(finderFilterCanRun(filters[2]), false);
  assert.deepEqual(dueFinderFilters(filters, now).map((item) => item.id), ["due", "facebook-only"]);
});

test("scheduler starts due filters, skips an existing run, and preserves the returned run id", async () => {
  const due = [filter({ id: "already-running" }), filter({ id: "new-run" })];
  const started: string[] = [];
  const runIds: string[] = [];
  const result = await runFinderScanScheduler(now, {
    listFilters: async () => due,
    hasRunningScan: async (candidate) => candidate.id === "already-running",
    claimFilter: async () => true,
    startScan: async (candidate) => {
      started.push(candidate.id);
      return { runId: `run-${candidate.id}`, status: "running", background: true, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0 };
    },
    runScan: async (candidate, start) => {
      runIds.push(start.runId);
      return { runId: start.runId, status: "completed", sourcesRun: 1, sourcesCompleted: 1, sourcesFailed: 0, fetched: 1, normalized: 1, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, actualErrors: 0, sourceResults: [], matchDiagnostics: { rejectedByPrice: 0, rejectedByPricePerSqm: 0, rejectedByRooms: 0, rejectedByDistrict: 0, rejectedByArea: 0, rejectedByBuildingType: 0, matched: 0 }, scannedCount: 1, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0, warnings: [] };
    },
  });
  assert.deepEqual(started, ["new-run"]);
  assert.deepEqual(runIds, ["run-new-run"]);
  assert.equal(result.skippedRunning, 1);
  assert.equal(result.started, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.status, "completed");
});

test("a running-scan response from the reservation is treated as a skip, not a second run", async () => {
  let runCount = 0;
  const result = await runFinderScanScheduler(now, {
    listFilters: async () => [filter({ id: "race" })],
    hasRunningScan: async () => false,
    claimFilter: async () => true,
    startScan: async () => { throw Object.assign(new Error("Skan tego filtra już trwa."), { status: 429 }); },
    runScan: async () => { runCount += 1; throw new Error("must not run"); },
  });
  assert.equal(result.skippedRunning, 1);
  assert.equal(runCount, 0);
  assert.equal(result.errors.length, 0);
});

test("an atomic cadence claim losing a race skips the filter without starting a run", async () => {
  let started = 0;
  const result = await runFinderScanScheduler(now, {
    listFilters: async () => [filter({ id: "claim-race" })],
    hasRunningScan: async () => false,
    claimFilter: async () => false,
    startScan: async () => { started += 1; throw new Error("must not start"); },
    runScan: async () => { throw new Error("must not run"); },
  });
  assert.equal(started, 0);
  assert.equal(result.skippedRunning, 1);
  assert.equal(result.errors.length, 0);
});
