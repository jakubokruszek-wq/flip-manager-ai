import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Second Finder/Watcher separation bug, proven live on Production: clicking
 * "Skanuj" on a Facebook-enabled filter returned 429 "Skan tego filtra już
 * trwa." while the Watcher's own scheduler had a genuinely active
 * source_scans row (source="facebook") for that SAME filter. Root cause:
 * runManualOtodomScan's lock/staleness check queried source_scans by
 * (search_filter_id, source, status) with no concept of who created the
 * row -- and every source_scans row with source="facebook" is written
 * exclusively by the Watcher's scheduler (features/facebook-worker/jobs.ts),
 * never by Finder itself (activeSources() never returns "facebook"; Finder's
 * own facebook step is the synchronous reconcileFacebookFromCanonicalListings,
 * which never touches source_scans at all).
 *
 * This drives the real runManualOtodomScan() against a controllable fake
 * source_scans table seeded with rows exactly as the Watcher would create
 * them, proving: a Watcher-owned active facebook row never blocks Finder,
 * a Finder-owned active otodom row still correctly blocks a second Finder
 * scan of the same filter, and a stale (>15min) Finder-owned row is still
 * recovered exactly as before.
 */

type Row = Record<string, unknown>;

function fakeAdmin(seedSourceScans: Row[] = []) {
  const sourceScans: Row[] = seedSourceScans.map((row) => ({ ...row }));
  let idSeq = 1;

  function matches(row: Row, filters: Array<{ op: "eq" | "in" | "lt"; column: string; value: unknown }>): boolean {
    return filters.every(({ op, column, value }) => {
      if (op === "eq") return row[column] === value;
      if (op === "in") return Array.isArray(value) && value.includes(row[column]);
      if (op === "lt") return typeof row[column] === "string" && typeof value === "string" && (row[column] as string) < value;
      return false;
    });
  }

  function sourceScansTable() {
    const filters: Array<{ op: "eq" | "in" | "lt"; column: string; value: unknown }> = [];
    let mode: "select" | "update" | "insert" = "select";
    let updatePatch: Row = {};
    let insertPayload: Row | Row[] | null = null;
    const builder = {
      select: (_cols?: string) => builder,
      insert: (payload: Row | Row[]) => { mode = "insert"; insertPayload = payload; return builder; },
      update: (patch: Row) => { mode = "update"; updatePatch = patch; return builder; },
      eq: (column: string, value: unknown) => { filters.push({ op: "eq", column, value }); return builder; },
      in: (column: string, value: unknown) => { filters.push({ op: "in", column, value }); return builder; },
      lt: (column: string, value: unknown) => { filters.push({ op: "lt", column, value }); return builder; },
      limit: (_n: number) => builder,
      order: () => builder,
      abortSignal: () => builder,
      async single() {
        if (mode === "insert" && insertPayload) {
          const row: Row = { id: `scan-${idSeq++}`, started_at: new Date().toISOString(), status: "running", ...(Array.isArray(insertPayload) ? insertPayload[0] : insertPayload) };
          sourceScans.push(row);
          return { data: { id: row.id, started_at: row.started_at }, error: null };
        }
        if (mode === "update") {
          const found = sourceScans.find((row) => matches(row, filters));
          return { data: found ? { id: found.id, started_at: found.started_at } : null, error: null };
        }
        return { data: null, error: null };
      },
      async maybeSingle() {
        const found = sourceScans.find((row) => matches(row, filters));
        return { data: found ?? null, error: null };
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        if (mode === "insert" && insertPayload) {
          const payloads = Array.isArray(insertPayload) ? insertPayload : [insertPayload];
          for (const payload of payloads) sourceScans.push({ id: `scan-${idSeq++}`, started_at: new Date().toISOString(), status: "pending", ...payload });
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        if (mode === "update") {
          for (const row of sourceScans) if (matches(row, filters)) Object.assign(row, updatePatch);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        const found = sourceScans.filter((row) => matches(row, filters));
        return Promise.resolve({ data: found, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const touchedTables: string[] = [];
  const client = {
    from(table: string) {
      touchedTables.push(table);
      if (table === "source_scans") return sourceScansTable();
      if (table === "search_filters") {
        return { update: () => ({ eq: () => ({ abortSignal: async () => ({ error: null }) }) }) };
      }
      throw new Error(`fakeAdmin: unexpected table "${table}"`);
    },
  };
  return { client, sourceScans, touchedTables };
}

let current = fakeAdmin();
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => current.client } });

const facebookOnlyFilter = {
  id: "filter-fb", name: "Facebook only", sources: ["facebook"], city: "Łódź", districts: [],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
  privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const mixedFilter = { ...facebookOnlyFilter, id: "filter-mixed", name: "Otodom + Facebook", sources: ["otodom", "facebook"] };

mock.module("@/features/flip-finder/server/search-filters", {
  namedExports: {
    getSearchFilter: async (id: string) => [facebookOnlyFilter, mixedFilter].find((filter) => filter.id === id) ?? null,
  },
});

const recalculateResult: unknown = { evaluated: 1, matchesAfter: 1, addedMatches: 1, rejectedByPricePerSqm: 0, rejectedByOtherCriteria: 0 };
mock.module("@/features/flip-finder/server/filter-match-recalculation", {
  namedExports: { recalculateFilterMatches: async () => recalculateResult },
});

// The mixed (otodom+facebook) fixture below never needs a real Otodom fetch
// -- only the source_scans lock/staleness behavior around it is under test.
// Other exports of this module (slugifyCity, etc.) are used by sibling
// modules (e.g. olx-jobs.ts) that manual-scan.ts also imports, so the real
// module is loaded first and everything except activeSources is passed
// through unchanged.
const realSourceRegistry = await import("@/features/flip-finder/server/search-source-registry");
mock.module("@/features/flip-finder/server/search-source-registry", {
  namedExports: {
    ...realSourceRegistry,
    activeSources: (filter: { sources: string[] }) =>
      filter.sources.includes("otodom")
        ? [{ id: "otodom", label: "Otodom", fetch: async () => ({ listings: [], warnings: [], fetched: 0 }) }]
        : [],
  },
});

const { runManualOtodomScan, startManualOtodomScan } = await import("./manual-scan.ts");

function watcherOwnedFacebookScan(filterId: string, overrides: Row = {}): Row {
  return { id: "watcher-scan-1", search_filter_id: filterId, source: "facebook", status: "running", started_at: new Date().toISOString(), scan_run_id: "watcher-run-1", ...overrides };
}

test("a genuinely active Watcher-owned facebook source_scans row never blocks Finder's own scan of the same filter", async () => {
  current = fakeAdmin([watcherOwnedFacebookScan(facebookOnlyFilter.id)]);
  const summary = await runManualOtodomScan(facebookOnlyFilter.id);
  assert.equal(summary.status, "completed", "Finder's own scan must run to completion, never blocked by the Watcher's active run");
  assert.equal(current.touchedTables.includes("source_scans"), false, "a facebook-only Finder scan must never even query source_scans -- every row there belongs exclusively to the Watcher");
  // The Watcher's own row must be completely untouched -- Finder never
  // "recovers" or otherwise mutates a row it does not own.
  const watcherRow = current.sourceScans.find((row) => row.id === "watcher-scan-1");
  assert.equal(watcherRow?.status, "running", "the Watcher's own active row must be left exactly as-is");
});

test("a stale (long-abandoned) Watcher-owned facebook row is also left untouched by Finder -- staleness recovery for facebook is exclusively the Watcher's own concern", async () => {
  const staleStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  current = fakeAdmin([watcherOwnedFacebookScan(facebookOnlyFilter.id, { started_at: staleStartedAt })]);
  const summary = await runManualOtodomScan(facebookOnlyFilter.id);
  assert.equal(summary.status, "completed");
  const watcherRow = current.sourceScans.find((row) => row.id === "watcher-scan-1");
  assert.equal(watcherRow?.status, "running", "Finder must never mark a Watcher-owned row as failed, no matter how old it is -- that is the Watcher's own repairOrphanedCycleScans job");
});

test("a genuinely active FINDER-owned otodom scan still correctly blocks a second Finder click for the same mixed filter", async () => {
  current = fakeAdmin([{ id: "finder-scan-1", search_filter_id: mixedFilter.id, source: "otodom", status: "running", started_at: new Date().toISOString() }]);
  await assert.rejects(() => runManualOtodomScan(mixedFilter.id), /Skan tego filtra już trwa/, "Finder's own in-flight otodom scan must still block a second click -- this protection is unrelated to the Watcher-isolation fix");
});

test("background start reserves the Finder row and a second start is rejected before the worker runs", async () => {
  current = fakeAdmin();
  const start = await startManualOtodomScan(mixedFilter.id);
  assert.equal(start.status, "running");
  assert.equal(start.background, true);
  assert.equal(current.sourceScans.filter((row) => row.scan_run_id === start.runId && row.source === "otodom").length, 1);
  await assert.rejects(() => startManualOtodomScan(mixedFilter.id), /Skan tego filtra już trwa/);
});

test("prepared background rows become running and finalize through the real scan runner", async () => {
  current = fakeAdmin();
  const start = await startManualOtodomScan(mixedFilter.id);
  const summary = await runManualOtodomScan(mixedFilter.id, { runId: start.runId, usePreparedRows: true, skipLock: true });
  assert.equal(summary.status, "completed");
  const row = current.sourceScans.find((candidate) => candidate.scan_run_id === start.runId && candidate.source === "otodom");
  assert.equal(row?.status, "completed");
});

test("a mixed filter's active Watcher-owned facebook row never blocks Finder, even though the same filter also has otodom", async () => {
  current = fakeAdmin([watcherOwnedFacebookScan(mixedFilter.id)]);
  const summary = await runManualOtodomScan(mixedFilter.id);
  assert.equal(summary.status, "completed", "an active Watcher facebook row must never block Finder's own otodom+facebook scan of the same filter");
  const otodomResult = summary.sourceResults.find((result) => result.source === "otodom");
  assert.ok(otodomResult, "Finder's own otodom step must still have run");
});

test("a stale (>15min) FINDER-owned otodom scan is recovered exactly as before, unaffected by the Watcher-isolation fix", async () => {
  const staleStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  current = fakeAdmin([{ id: "finder-scan-stale", search_filter_id: mixedFilter.id, source: "otodom", status: "running", started_at: staleStartedAt }]);
  const summary = await runManualOtodomScan(mixedFilter.id);
  assert.equal(summary.status, "completed", "a stale Finder-owned row must be recovered, not treated as a genuine lock");
  const recovered = current.sourceScans.find((row) => row.id === "finder-scan-stale");
  assert.equal(recovered?.status, "failed", "the stale Finder-owned row must be marked failed by failStaleScans");
});

// Exact reported production shape: the Watcher's last facebook source_scan
// failed with error_code COLLECTOR_UPLOAD_422 and scanned_count=0 (a real
// collector-side upload rejection, unrelated to Finder). Finder clicking
// "Skanuj" for this same filter must neither read this row's failure as its
// own, nor be blocked/affected by it in any way -- it must not even query
// source_scans, since this row is exclusively the Watcher's.
test("a Watcher-owned facebook source_scan that already failed with COLLECTOR_UPLOAD_422/scanned_count=0 is never read by Finder's own scan", async () => {
  current = fakeAdmin([watcherOwnedFacebookScan(facebookOnlyFilter.id, { status: "failed", finished_at: new Date().toISOString(), error_message: "COLLECTOR_UPLOAD_422", scanned_count: 0 })]);
  const summary = await runManualOtodomScan(facebookOnlyFilter.id);
  assert.equal(summary.status, "completed", "a failed Watcher scan must never block or fail Finder's own recalculation");
  assert.equal(current.touchedTables.includes("source_scans"), false, "Finder must never even query source_scans for a facebook-only filter -- the failed row is exclusively the Watcher's own history");
  const facebookResult = summary.sourceResults.find((result) => result.source === "facebook");
  assert.equal(facebookResult?.status, "completed", "Finder's own facebook step must complete normally, never inheriting the Watcher's COLLECTOR_UPLOAD_422 failure");
  assert.equal(facebookResult?.errorCode, null, "Finder's own result must carry no error at all from the unrelated Watcher failure");
});
