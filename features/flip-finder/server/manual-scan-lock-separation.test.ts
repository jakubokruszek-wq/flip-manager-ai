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

/**
 * `raceBarrier` lets a test force the exact adversarial interleaving two
 * separate requests/instances would produce on real Postgres: every
 * "is anything already running" read (the SELECT with .limit(1) and no
 * .lt(), i.e. startManualOtodomScan's lock check, as opposed to
 * failStaleScans' own .lt()-qualified read) blocks until `raceBarrier`
 * concurrent callers have all arrived at that exact read, so none of them
 * can observe a write made by another participant of the race. This is a
 * controlled reproduction of the race window, not a sequential test
 * dressed up as concurrent -- natural microtask ordering is not a reliable
 * way to prove or disprove a TOCTOU race.
 *
 * `rpcMode` controls how the fake's .rpc("reserve_source_scans", ...) call
 * behaves, mirroring the two real-world states the draft migration
 * (20261004020000_add_manual_scan_reservation_lock.sql, NOT applied) can be
 * in: "missing" (default) simulates today's actual, unmigrated production --
 * PostgREST's real error for an undefined function -- so every existing test
 * below keeps exercising the exact same fallback path as before, unchanged.
 * "atomic" simulates the function once that migration IS applied: a mutex
 * chain stands in for Postgres's SELECT ... FOR UPDATE row lock, so
 * concurrent callers are strictly serialized (one fully completes its
 * check+insert before the next one's check can run) instead of merely being
 * delayed -- a real guarantee, not a smaller race window. "permission-denied"
 * and "filter-not-found" simulate the RPC existing but returning a real
 * Postgres error of its own (42501 insufficient_privilege if the grant to
 * service_role is ever missing, or the function's own SEARCH_FILTER_NOT_FOUND
 * raise) -- proving the fallback below only ever triggers on the exact
 * "function does not exist" signal, never on a permission or validation
 * error from a function that does exist.
 */
function fakeAdmin(seedSourceScans: Row[] = [], options: { raceBarrier?: number; claimBarrier?: number; claimError?: { code: string; message: string }; rpcMode?: "missing" | "atomic" | "permission-denied" | "filter-not-found" } = {}) {
  const sourceScans: Row[] = seedSourceScans.map((row) => ({ ...row }));
  let idSeq = 1;
  let waitingForRace: Array<() => void> = [];
  let waitingForClaim: Array<() => void> = [];
  let rpcLockQueue: Promise<void> = Promise.resolve();

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
    let isLockCheckRead = false;
    const builder = {
      select: (_cols?: string) => builder,
      insert: (payload: Row | Row[]) => { mode = "insert"; insertPayload = payload; return builder; },
      update: (patch: Row) => { mode = "update"; updatePatch = patch; return builder; },
      eq: (column: string, value: unknown) => { filters.push({ op: "eq", column, value }); return builder; },
      in: (column: string, value: unknown) => { filters.push({ op: "in", column, value }); return builder; },
      lt: (column: string, value: unknown) => { filters.push({ op: "lt", column, value }); return builder; },
      limit: (_n: number) => { isLockCheckRead = true; return builder; },
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
        const isClaimUpdate = mode === "update" && filters.some((filter) => filter.op === "eq" && filter.column === "status" && filter.value === "pending");
        const run = async () => {
          if (mode === "insert" && insertPayload) {
            const payloads = Array.isArray(insertPayload) ? insertPayload : [insertPayload];
            const inserted = payloads.map((payload) => {
              const row: Row = { id: `scan-${idSeq++}`, started_at: new Date().toISOString(), status: "pending", ...payload };
              sourceScans.push(row);
              return { id: row.id, started_at: row.started_at };
            });
            return { data: inserted, error: null };
          }
          // claimBarrier forces two (or more) concurrent claim attempts on the
          // SAME prepared row to both reach this exact point -- the atomic
          // pending->running CAS -- before either is allowed to actually
          // check+mutate, so the race is genuinely forced rather than decided
          // by incidental microtask ordering. Once released, the match+patch
          // below runs with no further await in between, exactly like a
          // single Postgres UPDATE ... WHERE status = 'pending' statement:
          // whichever caller's synchronous turn runs first wins the row, and
          // the loser's own filter (status = 'pending') then matches nothing.
          if (isClaimUpdate && options.claimBarrier && options.claimBarrier > 1) {
            await new Promise<void>((release) => {
              waitingForClaim.push(release);
              if (waitingForClaim.length >= (options.claimBarrier as number)) {
                const toRelease = waitingForClaim;
                waitingForClaim = [];
                toRelease.forEach((fn) => fn());
              }
            });
          }
          if (isClaimUpdate && options.claimError) {
            return { data: null, error: options.claimError };
          }
          if (mode === "update") {
            const matched = sourceScans.filter((row) => matches(row, filters));
            for (const row of matched) Object.assign(row, updatePatch);
            return { data: matched.map((row) => ({ id: row.id, started_at: row.started_at })), error: null };
          }
          if (isLockCheckRead && options.raceBarrier && options.raceBarrier > 1) {
            await new Promise<void>((release) => {
              waitingForRace.push(release);
              if (waitingForRace.length >= (options.raceBarrier as number)) {
                const toRelease = waitingForRace;
                waitingForRace = [];
                toRelease.forEach((fn) => fn());
              }
            });
          }
          return { data: sourceScans.filter((row) => matches(row, filters)), error: null };
        };
        return run().then(resolve, reject);
      },
    };
    return builder;
  }

  async function reserveSourceScansRpc(args: Record<string, unknown>) {
    const sources = Array.isArray(args.p_sources) ? (args.p_sources as string[]) : [];
    const filterId = args.p_search_filter_id as string;
    const runId = args.p_scan_run_id as string;
    const snapshot = args.p_filter_snapshot;
    if (options.rpcMode === "permission-denied") {
      return { data: null, error: { code: "42501", message: "permission denied for function reserve_source_scans" } };
    }
    if (options.rpcMode === "filter-not-found") {
      return { data: null, error: { code: "P0001", message: "SEARCH_FILTER_NOT_FOUND" } };
    }
    if (options.rpcMode !== "atomic") {
      return { data: null, error: { code: "PGRST202", message: `Could not find the function public.reserve_source_scans in the schema cache` } };
    }
    // Stands in for Postgres's SELECT ... FOR UPDATE: whoever is already
    // queued here holds the "lock" until its own check+insert is done, so
    // the next caller's check always sees the previous caller's committed
    // insert -- real serialization, not a narrowed race window.
    const prior = rpcLockQueue;
    let release = () => {};
    rpcLockQueue = new Promise((resolve) => { release = resolve; });
    await prior;
    try {
      const existing = sourceScans.filter((row) => row.search_filter_id === filterId && sources.includes(row.source as string) && (row.status === "pending" || row.status === "running"));
      if (existing.length > 0) {
        return { data: null, error: { code: "P0001", message: "SCAN_ALREADY_RUNNING" } };
      }
      const inserted = sources.map((source) => {
        const row: Row = { id: `scan-${idSeq++}`, search_filter_id: filterId, source, status: "pending", scan_run_id: runId, filter_snapshot: snapshot, started_at: new Date().toISOString() };
        sourceScans.push(row);
        return row;
      });
      return { data: inserted, error: null };
    } finally {
      release();
    }
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
    async rpc(fnName: string, args: Record<string, unknown>) {
      if (fnName !== "reserve_source_scans") throw new Error(`fakeAdmin: unexpected rpc "${fnName}"`);
      return reserveSourceScansRpc(args);
    },
  };
  return { client, sourceScans, touchedTables };
}

let current = fakeAdmin();
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => current.client } });

const olxResumableRuns = new Map<string, string>();
const olxResults = new Map<string, { source: string; status: "pending" | "completed" | "failed"; fetched: number; normalized: number; matched: number; listingsCreated: number; newMatches: number; updated: number; priceDrops: number; rejected: number; durationMs: number; errorCode: string | null; errorMessage: string | null; warnings: string[]; matchDiagnostics: Record<string, number> }>();
const olxEnqueueCalls: string[] = [];
mock.module("@/features/flip-finder/server/olx-jobs", {
  namedExports: {
    resumableOlxRunId: async (filterId: string) => olxResumableRuns.get(filterId) ?? null,
    existingOlxScanResult: async (runId: string) => olxResults.get(runId) ?? null,
    enqueueOlxJob: async (filter: { id: string }, runId: string) => {
      olxEnqueueCalls.push(`${filter.id}:${runId}`);
      olxResumableRuns.set(filter.id, runId);
      olxResults.set(runId, { source: "olx", status: "pending", fetched: 0, normalized: 0, matched: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, durationMs: 0, errorCode: null, errorMessage: "OLX: oczekuje na lokalny worker", warnings: [], matchDiagnostics: { rejectedByPrice: 0, rejectedByPricePerSqm: 0, rejectedByRooms: 0, rejectedByDistrict: 0, rejectedByArea: 0, rejectedByBuildingType: 0, matched: 0 } });
      return { jobId: `job-${runId}`, sourceScanId: `scan-olx-${runId}`, runId, status: "queued" };
    },
  },
});

const facebookOnlyFilter = {
  id: "filter-fb", name: "Facebook only", sources: ["facebook"], city: "Łódź", districts: [],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
  privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const mixedFilter = { ...facebookOnlyFilter, id: "filter-mixed", name: "Otodom + Facebook", sources: ["otodom", "facebook"] };
const olxOnlyFilter = { ...facebookOnlyFilter, id: "filter-olx", name: "OLX only", sources: ["olx"] };

mock.module("@/features/flip-finder/server/search-filters", {
  namedExports: {
    getSearchFilter: async (id: string) => [facebookOnlyFilter, mixedFilter, olxOnlyFilter].find((filter) => filter.id === id) ?? null,
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
// Mutable, reset per-test: lets the duplicate-execution concurrency test
// below count real source.fetch() invocations across two concurrent
// runManualOtodomScan calls sharing the same prepared row, without every
// other test in this file needing to care.
let otodomFetchCalls = 0;
let otodomFetchGate: { entered: Promise<void>; notifyEntered: () => void; release: Promise<void>; open: () => void } | null = null;
const realSourceRegistry = await import("@/features/flip-finder/server/search-source-registry");
mock.module("@/features/flip-finder/server/search-source-registry", {
  namedExports: {
    ...realSourceRegistry,
    activeSources: (filter: { sources: string[] }) => [
      ...(filter.sources.includes("otodom") ? [{ id: "otodom", label: "Otodom", fetch: async () => { otodomFetchCalls += 1; if (otodomFetchGate) { otodomFetchGate.notifyEntered(); await otodomFetchGate.release; } return { listings: [], warnings: [], fetched: 0 }; } }] : []),
      ...(filter.sources.includes("olx") ? [{ id: "olx", label: "OLX", fetch: async () => ({ listings: [], warnings: [], fetched: 0 }) }] : []),
    ],
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

test("background start reserves the Finder row and a second start resumes the same run before the worker runs", async () => {
  current = fakeAdmin();
  const start = await startManualOtodomScan(mixedFilter.id);
  assert.equal(start.status, "running");
  assert.equal(start.background, true);
  assert.equal(current.sourceScans.filter((row) => row.scan_run_id === start.runId && row.source === "otodom").length, 1);
  const resumed = await startManualOtodomScan(mixedFilter.id);
  assert.equal(resumed.runId, start.runId, "a safe pending run must be resumed, never replaced by a new run id");
  assert.equal(current.sourceScans.filter((row) => row.scan_run_id === start.runId && row.source === "otodom").length, 1);
});

test("OLX-only Finder start creates exactly its async queue row and a second click resumes the same run", async () => {
  olxResumableRuns.clear();
  olxResults.clear();
  olxEnqueueCalls.length = 0;
  current = fakeAdmin();
  const start = await startManualOtodomScan(olxOnlyFilter.id);
  assert.equal(start.background, true, "OLX still runs through its asynchronous local worker");
  assert.equal(olxEnqueueCalls.length, 1, "OLX must be queued once before the fast ACK establishes the duplicate guard");
  const resumed = await startManualOtodomScan(olxOnlyFilter.id);
  assert.equal(resumed.runId, start.runId, "a queued OLX run must be resumed, never replaced by a new run id");
  assert.equal(olxEnqueueCalls.length, 1, "a second click must not create a second OLX job");
});

test("two parallel manual starts over one safe pending run return one run id", async () => {
  current = fakeAdmin([{ id: "pending-otodom", search_filter_id: mixedFilter.id, source: "otodom", status: "pending", started_at: new Date().toISOString(), scan_run_id: "run-pending" }]);
  const [first, second] = await Promise.all([startManualOtodomScan(mixedFilter.id), startManualOtodomScan(mixedFilter.id)]);
  assert.equal(first.runId, "run-pending");
  assert.equal(second.runId, "run-pending");
  assert.equal(current.sourceScans.length, 1, "parallel resumes must not reserve another source row");
});

test("resumption processes only pending sources and skips completed or terminally failed rows", async () => {
  otodomFetchCalls = 0;
  current = fakeAdmin([
    { id: "completed-otodom", search_filter_id: mixedFilter.id, source: "otodom", status: "completed", started_at: new Date().toISOString(), scan_run_id: "run-terminal" },
    { id: "failed-otodom", search_filter_id: mixedFilter.id, source: "morizon", status: "failed", started_at: new Date().toISOString(), scan_run_id: "run-terminal" },
    { id: "pending-otodom", search_filter_id: mixedFilter.id, source: "otodom", status: "pending", started_at: new Date().toISOString(), scan_run_id: "run-terminal" },
  ]);
  const start = await startManualOtodomScan(mixedFilter.id);
  const summary = await runManualOtodomScan(mixedFilter.id, { runId: start.runId, usePreparedRows: true, skipLock: true });
  assert.equal(start.runId, "run-terminal");
  assert.equal(otodomFetchCalls, 1, "only the pending Otodom reservation may be fetched");
  assert.equal(summary.sourceResults.filter((result) => result.source === "otodom").length, 1);
  assert.equal(current.sourceScans.find((row) => row.id === "completed-otodom")?.status, "completed");
  assert.equal(current.sourceScans.find((row) => row.id === "failed-otodom")?.status, "failed");
});

test("manual resumption assigns a live lease before fetching an old pending row, so continuation cannot steal it", async () => {
  otodomFetchCalls = 0;
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  otodomFetchGate = { entered: enteredPromise, notifyEntered: entered, release: releasePromise, open: release };
  const oldStartedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  current = fakeAdmin([{ id: "old-pending", search_filter_id: mixedFilter.id, source: "otodom", status: "pending", started_at: oldStartedAt, scan_run_id: "run-old", error_message: "SOURCE_TIMEOUT: waiting", continuation_next_at: new Date(Date.now() - 60_000).toISOString() }]);
  try {
    const start = await startManualOtodomScan(mixedFilter.id);
    const running = runManualOtodomScan(mixedFilter.id, { runId: start.runId, usePreparedRows: true, skipLock: true });
    await enteredPromise;
    const row = current.sourceScans.find((candidate) => candidate.id === "old-pending");
    assert.equal(row?.status, "running");
    assert.equal(typeof row?.continuation_lease_token, "string", "manual ownership must be visible to the continuation claim");
    assert.ok(typeof row?.continuation_lease_until === "string" && Date.parse(String(row.continuation_lease_until)) > Date.now());
    assert.equal(row?.status === "running" && (!row.continuation_lease_until || Date.parse(String(row.continuation_lease_until)) <= Date.now()), false, "the migration's orphan-running rule must not match the manual worker");
    release();
    const summary = await running;
    assert.equal(summary.status, "completed");
    assert.equal(otodomFetchCalls, 1);
  } finally {
    otodomFetchGate = null;
  }
});

test("manual start refuses a row with an active worker lease instead of taking it over", async () => {
  current = fakeAdmin([{
    id: "active-lease",
    search_filter_id: mixedFilter.id,
    source: "otodom",
    status: "running",
    started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    scan_run_id: "run-active",
    continuation_lease_token: "lease-active",
    continuation_lease_until: new Date(Date.now() + 60_000).toISOString(),
  }]);
  await assert.rejects(() => startManualOtodomScan(mixedFilter.id), /Skan tego filtra już trwa/);
  assert.equal(current.sourceScans[0].scan_run_id, "run-active");
  assert.equal(current.sourceScans[0].continuation_lease_token, "lease-active");
});

test("manual start refuses pending reservations split across multiple run ids", async () => {
  current = fakeAdmin([
    { id: "pending-a", search_filter_id: mixedFilter.id, source: "otodom", status: "pending", started_at: new Date().toISOString(), scan_run_id: "run-a" },
    { id: "pending-b", search_filter_id: mixedFilter.id, source: "otodom", status: "pending", started_at: new Date().toISOString(), scan_run_id: "run-b" },
  ]);
  await assert.rejects(() => startManualOtodomScan(mixedFilter.id), /Skan tego filtra już trwa/);
  assert.deepEqual(current.sourceScans.map((row) => row.scan_run_id), ["run-a", "run-b"]);
});

// Issue 1 from the scan-lifecycle review: startManualOtodomScan's reservation
// was a plain SELECT-then-INSERT with no database-level mutual exclusion.
// Confirmed via supabase/migrations: source_scans has no unique constraint on
// (search_filter_id, source) at all, scoped or not -- the table's own
// creation migration (20260719113000) defines only a plain primary key on
// id, and the only atomic "claim" pattern anywhere in this codebase
// (claim_olx_scan_job, in 20260810190000_create_olx_local_worker_queue.sql)
// exists purely because that migration added a dedicated unique column plus
// a security-definer RPC wrapping an UPDATE...RETURNING. No equivalent
// exists, or can be synthesized from the existing schema/RPCs, for
// source_scans, and no generic SQL-execution RPC exists to reach e.g.
// pg_advisory_lock without one either. A JS-level mutex would not help: it
// only protects a single process, while this guarantee must hold across
// separate requests/instances (separate Vercel invocations, separate
// Postgres connections) -- exactly what this barrier-forced race simulates.
//
// reserve_source_scans (supabase/migrations/20261004020000_add_manual_scan_
// reservation_lock.sql) closes this with a SELECT ... FOR UPDATE lock on the
// parent search_filters row, mirroring enqueue_facebook_gallery_job's proven
// pattern. It is a DRAFT, NOT applied by this change (no migrations were run
// or executed) -- manual-scan.ts's reserveSourceScans() only ever calls it
// optimistically and falls back to the pre-existing, unchanged check-then-
// insert the moment Postgres reports the function missing, so today's actual
// (unmigrated) production behavior is completely unaffected by this change.
// The two tests below therefore each prove one half of the honest picture,
// and neither is a `todo`: the first documents that the race genuinely still
// exists today, as-is, until a human reviews and applies that migration; the
// second proves the drafted mechanism itself is correct and ready the moment
// it is.
test("without the reservation migration applied, two concurrent background-scan starts for the same filter+source still both win -- the exact gap reserve_source_scans closes once applied", async () => {
  current = fakeAdmin([], { raceBarrier: 2, rpcMode: "missing" });
  const [a, b] = await Promise.allSettled([startManualOtodomScan(mixedFilter.id), startManualOtodomScan(mixedFilter.id)]);
  const succeeded = [a, b].filter((result) => result.status === "fulfilled");
  assert.equal(succeeded.length, 2, "documents today's actual, unmigrated behavior -- both concurrent starts currently win, which is exactly the gap the draft migration above closes");
  assert.equal(current.sourceScans.filter((row) => row.source === "otodom" && row.search_filter_id === mixedFilter.id).length, 2, "two otodom source_scans rows currently end up active for the same filter after the race");
});

test("once reserve_source_scans exists (migration applied), two truly concurrent background-scan starts for the same filter+source serialize correctly: exactly one wins", async () => {
  current = fakeAdmin([], { rpcMode: "atomic" });
  const [a, b] = await Promise.allSettled([startManualOtodomScan(mixedFilter.id), startManualOtodomScan(mixedFilter.id)]);
  const succeeded = [a, b].filter((result) => result.status === "fulfilled");
  const rejected = [a, b].filter((result) => result.status === "rejected");
  assert.equal(succeeded.length, 1, "exactly one concurrent start must win the reservation for the same filter+source");
  assert.equal(rejected.length, 1, "the other concurrent start must be rejected, never silently also reserve the same source");
  assert.match(String((rejected[0] as PromiseRejectedResult)?.reason?.message), /Skan tego filtra już trwa/);
  assert.equal(current.sourceScans.filter((row) => row.source === "otodom" && row.search_filter_id === mixedFilter.id).length, 1, "only one otodom source_scans row may exist for this filter after the race");
});

// The fallback in reserveSourceScans must trigger on exactly one thing: the
// RPC not existing yet (PGRST202/42883). A permission error (e.g. the grant
// to service_role is ever missing or dropped) or a validation error raised
// by the function itself (e.g. SEARCH_FILTER_NOT_FOUND, its own defensive
// check before even reading source_scans) must surface as a real failure --
// never be silently reinterpreted as "not deployed yet" and routed into the
// legacy check-then-insert, which would both mask a real misconfiguration
// and could still reserve rows under conditions the RPC explicitly rejected.
test("a permission error from an existing reserve_source_scans (e.g. a missing grant) is a real failure, never silently treated as the function being absent", async () => {
  current = fakeAdmin([], { rpcMode: "permission-denied" });
  await assert.rejects(() => startManualOtodomScan(mixedFilter.id), /Nie udało się zarezerwować skanu/);
  assert.equal(current.sourceScans.length, 0, "no fallback insert may run when the RPC exists but is denied by permissions");
});

test("reserve_source_scans' own SEARCH_FILTER_NOT_FOUND validation is a real failure, never silently treated as the function being absent", async () => {
  current = fakeAdmin([], { rpcMode: "filter-not-found" });
  await assert.rejects(() => startManualOtodomScan(mixedFilter.id), /Nie udało się zarezerwować skanu/);
  assert.equal(current.sourceScans.length, 0, "no fallback insert may run when the RPC exists but rejects the call on its own validation");
});

test("prepared background rows become running and finalize through the real scan runner", async () => {
  current = fakeAdmin();
  const start = await startManualOtodomScan(mixedFilter.id);
  const summary = await runManualOtodomScan(mixedFilter.id, { runId: start.runId, usePreparedRows: true, skipLock: true });
  assert.equal(summary.status, "completed");
  const row = current.sourceScans.find((candidate) => candidate.scan_run_id === start.runId && candidate.source === "otodom");
  assert.equal(row?.status, "completed");
});

// Investigated after a Production scan showed 7 of 13 sources' finished_at
// clustered within 17ms despite the sequential for-loop in manual-scan.ts
// -- NOT, on inspection, proof of duplicate execution by itself (see
// scanTimestamp's own doc comment: it encodes "started_at + this source's
// own duration", not wall-clock time, so same-budget timeouts naturally
// cluster near started_at+timeoutMs under purely sequential execution too).
// But the underlying risk the clustering raised is real regardless of
// whether it explains that specific run: route.ts's background callback
// (runAfterResponse -> runManualOtodomScan(..., {usePreparedRows:true,
// skipLock:true})) has no guarantee it is only ever invoked once for a
// given runId -- a platform-level retry or a second after() firing would
// previously have re-run source.fetch() and raced its writes against the
// first execution, since scanSource's old update-by-id alone always
// "succeeded" for both callers. This forces that exact overlap for real
// (both executions reach the claim update before either is released, via
// claimBarrier) rather than relying on incidental microtask ordering.
test("two concurrent executions of the same background callback for the same prepared row: source.fetch() runs exactly once, and the loser never overwrites the winner's result", async () => {
  otodomFetchCalls = 0;
  current = fakeAdmin([], { claimBarrier: 2 });
  const start = await startManualOtodomScan(mixedFilter.id);
  const [a, b] = await Promise.allSettled([
    runManualOtodomScan(mixedFilter.id, { runId: start.runId, usePreparedRows: true, skipLock: true }),
    runManualOtodomScan(mixedFilter.id, { runId: start.runId, usePreparedRows: true, skipLock: true }),
  ]);
  assert.equal(otodomFetchCalls, 1, "source.fetch() must run exactly once across both concurrent executions of the same prepared row");

  const summaries = [a, b].map((outcome) => {
    assert.equal(outcome.status, "fulfilled", "neither execution may throw -- the loser must resolve with a clean per-source failure, not crash the whole run");
    return (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof runManualOtodomScan>>>).value;
  });
  const otodomOutcomes = summaries.map((summary) => summary.sourceResults.find((result) => result.source === "otodom"));
  const claimed = otodomOutcomes.filter((result) => result?.errorCode === "SCAN_ALREADY_CLAIMED");
  const real = otodomOutcomes.filter((result) => result?.errorCode !== "SCAN_ALREADY_CLAIMED");
  assert.equal(claimed.length, 1, "exactly one execution must find its row already claimed by the other");
  assert.equal(real.length, 1, "exactly one execution must have actually won the claim and run the source");
  assert.equal(real[0]?.status, "completed", "the winner's own result must be unaffected by the loser");

  const row = current.sourceScans.find((candidate) => candidate.source === "otodom" && candidate.search_filter_id === mixedFilter.id);
  assert.equal(row?.status, "completed", "the final row must reflect only the winner's finalize -- the loser never reached finalizeSourceScan, so it cannot have overwritten this");
});

// Independent review finding on the CAS commit (0aac7d9): the original code
// relabeled ANY falsy-scan outcome from the claim update as
// SCAN_ALREADY_CLAIMED for the prepared-row path, including a genuine
// transport/DB error (which PostgREST never reports as zero rows + no
// error -- only a lost CAS does that). A real outage or permissions problem
// must surface as SCAN_CREATE_FAILED, the same code this path already used
// before the CAS existed, never be silently reinterpreted as "someone else
// won the race".
test("a genuine database error on the claim update is reported as SCAN_CREATE_FAILED, never relabeled as SCAN_ALREADY_CLAIMED", async () => {
  current = fakeAdmin([], { claimError: { code: "57014", message: "canceling statement due to statement timeout" } });
  const start = await startManualOtodomScan(mixedFilter.id);
  const summary = await runManualOtodomScan(mixedFilter.id, { runId: start.runId, usePreparedRows: true, skipLock: true });
  const otodomResult = summary.sourceResults.find((result) => result.source === "otodom");
  assert.equal(otodomResult?.errorCode, "SCAN_CREATE_FAILED", "a real database error must never be reported as SCAN_ALREADY_CLAIMED");
  assert.notEqual(otodomResult?.errorCode, "SCAN_ALREADY_CLAIMED");
});

// Issue 4 from the scan-lifecycle review: usePreparedRows trusts that
// startManualOtodomScan already reserved a "pending" row for every source it
// is about to run. If that assumption is ever violated -- the reservation
// row was never created, was deleted, or belongs to a different run id --
// the worker must report that source as a clean, terminal failure rather
// than silently skipping it or crashing the whole run.
test("a source missing its reserved row under usePreparedRows fails cleanly with SCAN_RESERVATION_MISSING, never silently skipped or crashing the run", async () => {
  current = fakeAdmin();
  const summary = await runManualOtodomScan(mixedFilter.id, { runId: "run-without-reservation", usePreparedRows: true, skipLock: true });
  const otodomResult = summary.sourceResults.find((result) => result.source === "otodom");
  assert.ok(otodomResult, "the otodom source must still appear in sourceResults, not be dropped");
  assert.equal(otodomResult?.status, "failed");
  assert.equal(otodomResult?.errorCode, "SCAN_RESERVATION_MISSING");
  assert.equal(summary.status, "partial", "a missing reservation is a per-source failure, not a reason to crash or hang the whole run");
  assert.equal(current.sourceScans.length, 0, "no source_scans row may be created or mutated for a source that was never actually reserved");
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
