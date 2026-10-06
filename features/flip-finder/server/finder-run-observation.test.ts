import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;
const filterId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const watcherId = "33333333-3333-4333-8333-333333333333";
let sourceRows: Row[] = [];
let calls: Array<{ table: string; op: string; args: unknown[] }> = [];
let authorized = true;
let readError = false;

// Executes the real readers/routes, and rejects ANY mutation/RPC or Watcher
// queue access. Unlike a final table-state assertion this catches attempts.
function readOnlyDb() {
  return {
    from(table: string) {
      calls.push({ table, op: "from", args: [] });
      assert.ok(["source_scans", "olx_scan_jobs"].includes(table));
      let selected = table === "source_scans" ? [...sourceRows] : [];
      const orders: Array<{ column: string; ascending: boolean }> = [];
      let count = Infinity;
      const result = () => {
        const data = [...selected].sort((a, b) => {
          for (const order of orders) {
            const cmp = String(a[order.column]).localeCompare(String(b[order.column]));
            if (cmp) return order.ascending ? cmp : -cmp;
          }
          return 0;
        }).slice(0, count);
        return { data, error: readError ? { message: "offline read failed" } : null };
      };
      const builder = {
        select(columns: string) { calls.push({ table, op: "select", args: [columns] }); return builder; },
        eq(column: string, value: unknown) { selected = selected.filter((row) => row[column] === value); return builder; },
        neq(column: string, value: unknown) { selected = selected.filter((row) => row[column] !== value); return builder; },
        not(column: string, op: string, value: unknown) { assert.equal(op, "is"); assert.equal(value, null); selected = selected.filter((row) => row[column] != null); return builder; },
        order(column: string, options: { ascending: boolean }) { orders.push({ column, ...options }); return builder; },
        limit(value: number) { count = value; calls.push({ table, op: "limit", args: [value] }); return builder; },
        abortSignal() { return builder; },
        update() { assert.fail("observation must not update source/job state"); },
        insert() { assert.fail("observation must not enqueue"); },
        delete() { assert.fail("observation must not delete"); },
        async maybeSingle() { return { ...result(), data: result().data[0] ?? null }; },
        then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return builder;
    },
    rpc() { assert.fail("observation must not claim/enqueue/recover a run"); },
  };
}
mock.module("@/features/facebook-watcher/supabase-admin", { namedExports: { createFacebookWatcherAdminClient: readOnlyDb } });
mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { if (!authorized) throw new Error("unauthorized"); },
  operatorAuthorizationResponse: () => Response.json({ error: "unauthorized" }, { status: 401 }),
} });
const { getLatestFinderRun } = await import("./latest-finder-run.ts");
const { getScanProgress } = await import("./scan-progress.ts");
const { GET: latestGET } = await import("../../../app/api/flip-finder/search-filters/[id]/latest-run/route.ts");
const { GET: progressGET } = await import("../../../app/api/flip-finder/scans/[runId]/route.ts");

function source(id: string, status: string, extra: Row = {}): Row {
  return { id, source: "otodom", scan_run_id: runId, search_filter_id: filterId, status,
    started_at: "2026-10-05T12:00:00.000Z", finished_at: status === "completed" ? "2026-10-05T12:00:02.000Z" : null,
    scanned_count: 7, matched_count: 2, listings_created: 1, ...extra };
}
function seed(rows: Row[]) { sourceRows = rows; calls = []; readError = false; authorized = true; }

test("discovery selects Finder's latest run for this filter, skips newer Watcher and unrelated filter, and reads only one ID", async () => {
  seed([source("a", "completed"), source("b", "pending", { source: "facebook", scan_run_id: watcherId, started_at: "2026-10-06T12:00:00Z" }), source("c", "running", { search_filter_id: watcherId, scan_run_id: watcherId, started_at: "2026-10-07T12:00:00Z" })]);
  assert.deepEqual(await getLatestFinderRun(filterId), { runId });
  assert.deepEqual(calls.filter((call) => call.op === "select").map((call) => call.args), [["scan_run_id"]]);
  assert.deepEqual(calls.filter((call) => call.op === "limit").map((call) => call.args), [[1]]);
});

test("real observation GET groups completed and pending sources by run ID, waits for continuation and does zero writes", async () => {
  seed([source("a", "completed"), source("b", "pending", { source: "morizon", error_message: "SOURCE_TIMEOUT: waiting for next portion", continuation_next_at: "2026-10-05T12:05:00Z" })]);
  const before = structuredClone(sourceRows);
  const response = await progressGET(new Request(`http://localhost/api/flip-finder/scans/${runId}?observe=1&filterId=${filterId}`), { params: Promise.resolve({ runId }) });
  assert.equal(response.status, 200);
  const progress = await response.json();
  assert.equal(progress.runId, runId);
  assert.equal(progress.status, "partial");
  assert.deepEqual(progress.overall, { completedUnits: 1, totalUnits: 2, percent: 50, failedUnits: 0, remainingUnits: 1, waitingUnits: 1 });
  assert.equal(progress.totals.scanned, 14);
  assert.equal(progress.facebook.totalGroups, 0);
  assert.deepEqual(sourceRows, before);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("all terminal sources with one 403 produce terminal partial with errors, rather than a completed-source status", async () => {
  seed([source("a", "completed"), source("b", "failed", { source: "szybko", error_message: "SOURCE_FORBIDDEN: HTTP 403", finished_at: "2026-10-05T12:00:03Z" })]);
  const progress = await getScanProgress(runId, { finderFilterId: filterId });
  assert.equal(progress.status, "partial");
  assert.equal(progress.overall.remainingUnits, 0);
  assert.equal(progress.overall.failedUnits, 1);
  assert.equal(progress.overall.waitingUnits, 0);
  assert.equal(progress.overall.percent, 100);
  assert.deepEqual(progress.errors, ["SOURCE_FORBIDDEN: HTTP 403"]);
});

test("Finder observation refuses Watcher/mixed runs and a run belonging to another filter before queue access", async () => {
  for (const rows of [[source("fb", "running", { source: "facebook" })], [source("a", "completed"), source("fb", "running", { source: "facebook" })], [source("other", "running", { search_filter_id: watcherId })]]) {
    seed(rows);
    await assert.rejects(getScanProgress(runId, { finderFilterId: filterId }), /SCAN_RUN_NOT_FOUND/);
    assert.deepEqual(calls.filter((call) => call.op === "from").map((call) => call.table), ["source_scans"]);
  }
});

test("discovery returns no run for a Watcher-only filter; read errors are not represented as an idle run", async () => {
  seed([source("fb", "running", { source: "facebook" })]);
  assert.deepEqual(await getLatestFinderRun(filterId), { runId: null });
  readError = true;
  await assert.rejects(getLatestFinderRun(filterId), /FINDER_RUN_READ_FAILED/);
});

test("both GET routes refuse anonymous access without touching any DB table", async () => {
  seed([]); authorized = false;
  assert.equal((await latestGET(new Request("http://localhost/latest-run"), { params: Promise.resolve({ id: filterId }) })).status, 401);
  assert.equal((await progressGET(new Request(`http://localhost/scans/${runId}?observe=1&filterId=${filterId}`), { params: Promise.resolve({ runId }) })).status, 401);
  assert.deepEqual(calls, []);
  authorized = true;
});
