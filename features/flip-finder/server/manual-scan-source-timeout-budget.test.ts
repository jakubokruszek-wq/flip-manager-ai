import assert from "node:assert/strict";
import test from "node:test";

import { SCHEMA_READY_SOURCE_IDS } from "@/features/flip-finder/source-availability";

/**
 * Issue 2 from the scan-lifecycle review: the worker's sequential per-source
 * loop used a fixed 75s timeout per source regardless of how many sources a
 * filter has active. SCHEMA_READY_SOURCE_IDS now has 14 entries (13 run
 * through this sequential loop; OLX is dispatched to its own async queue),
 * so a filter with most/all of them active could need up to 13 x 75s = 975s
 * -- more than three times the scan route's own `maxDuration = 300` -- and
 * the platform would kill the worker mid-run regardless of what the
 * heartbeat watchdog can recover afterwards. sourceTimeoutBudgetMs() shrinks
 * the per-source abort window as the active source count grows, so the
 * worst case can never exceed the worker's own lifetime. No source is
 * disabled or skipped -- every active source still runs, just with a
 * smaller fetch window when many share one invocation.
 */
const { sourceTimeoutBudgetMs, scanSource } = await import("./manual-scan.ts");

const WORKER_MAX_DURATION_MS = 300_000;
const WORKER_OVERHEAD_RESERVE_MS = 45_000;
const SOURCE_TIMEOUT_CEILING_MS = 75_000;
const MIN_SOURCE_TIMEOUT_MS = 10_000;
const AVAILABLE_FOR_SOURCES_MS = WORKER_MAX_DURATION_MS - WORKER_OVERHEAD_RESERVE_MS;

test("a single active source still gets the full 75s ceiling", () => {
  assert.equal(sourceTimeoutBudgetMs(1), SOURCE_TIMEOUT_CEILING_MS);
});

test("zero sources (defensive) falls back to the ceiling rather than dividing by zero", () => {
  assert.equal(sourceTimeoutBudgetMs(0), SOURCE_TIMEOUT_CEILING_MS);
});

test("the real current maximum number of sequential sources (SCHEMA_READY_SOURCE_IDS minus olx) fits inside the worker's lifetime with real margin", () => {
  const maxSequentialSources = SCHEMA_READY_SOURCE_IDS.filter((id) => id !== "olx").length;
  assert.equal(maxSequentialSources, 13, "this test's premise: today's real maximum is 13 -- update the budget math (not just this number) if that ever changes");
  const perSourceBudget = sourceTimeoutBudgetMs(maxSequentialSources);
  const worstCaseTotalMs = perSourceBudget * maxSequentialSources;
  assert.ok(worstCaseTotalMs <= AVAILABLE_FOR_SOURCES_MS, `worst case ${worstCaseTotalMs}ms must fit inside the ${AVAILABLE_FOR_SOURCES_MS}ms reserved for sequential source fetches`);
  assert.ok(worstCaseTotalMs + WORKER_OVERHEAD_RESERVE_MS <= WORKER_MAX_DURATION_MS, "including worker overhead, the absolute worst case must still stay under maxDuration=300");
  assert.ok(perSourceBudget >= MIN_SOURCE_TIMEOUT_MS, "every source must still get a meaningful fetch window, never reduced to zero");
});

test("the per-source budget shrinks monotonically as more sources share one worker invocation", () => {
  const budgets = [1, 2, 5, 10, 13, 20].map((count) => sourceTimeoutBudgetMs(count));
  for (let i = 1; i < budgets.length; i += 1) {
    assert.ok(budgets[i] <= budgets[i - 1], `budget for more sources (${budgets[i]}ms) must never exceed the budget for fewer (${budgets[i - 1]}ms)`);
  }
});

test("an extreme, currently-impossible source count is clamped at the floor rather than shrinking to zero (and is flagged as a scaling limit, not silently unsafe)", () => {
  const extremeCount = 100;
  const perSourceBudget = sourceTimeoutBudgetMs(extremeCount);
  assert.equal(perSourceBudget, MIN_SOURCE_TIMEOUT_MS);
  // Documents the known limit rather than hiding it: past ~27 simultaneous
  // sequential sources (270000ms / 10000ms floor), this formula alone can no
  // longer guarantee the total stays under the worker's lifetime -- real
  // parallel source execution would be required at that scale. Today's real
  // maximum is 13, well inside the safe range proven above.
  assert.ok(perSourceBudget * extremeCount > AVAILABLE_FOR_SOURCES_MS, "sanity check on the documented scaling limit itself");
});

test("scanSource aborts at the exact reduced per-source budget it is given, not the full 75s ceiling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reducedBudget = sourceTimeoutBudgetMs(13);
  assert.ok(reducedBudget < SOURCE_TIMEOUT_CEILING_MS, "premise: with 13 sources the budget must actually be reduced below the ceiling");

  const sourceScans: Record<string, unknown>[] = [];
  let idSeq = 1;
  const fakeSupabase = {
    from(table: string) {
      assert.equal(table, "source_scans");
      let mode: "insert" | "update" = "insert";
      let payload: Record<string, unknown> = {};
      const builder = {
        insert: (p: Record<string, unknown>) => { mode = "insert"; payload = p; return builder; },
        update: (p: Record<string, unknown>) => { mode = "update"; payload = p; return builder; },
        eq: () => builder,
        select: () => builder,
        abortSignal: () => builder,
        async single() {
          if (mode === "insert") {
            const row = { id: `scan-${idSeq++}`, started_at: new Date().toISOString(), ...payload };
            sourceScans.push(row);
            return { data: { id: row.id, started_at: row.started_at }, error: null };
          }
          Object.assign(sourceScans[sourceScans.length - 1], payload);
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };

  const hangingSource = {
    id: "otodom",
    label: "Otodom",
    fetch: (_filter: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  const filterFixture = { id: "filter-1" } as never;

  const resultPromise = scanSource(hangingSource as never, "filter-1", filterFixture, fakeSupabase as never, "run-1", new Map(), undefined, reducedBudget);
  // Let scanSource's pending microtasks (the reservation insert, which
  // resolves before the setTimeout for the abort window is even
  // registered) flush before advancing the mocked clock -- setImmediate is
  // a real macrotask boundary, unaffected by mocking only "setTimeout".
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(reducedBudget);
  const result = await resultPromise;

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "SOURCE_TIMEOUT");
  assert.match(result.errorMessage ?? "", new RegExp(`source timeout after ${reducedBudget / 1000}s`), "the reported timeout must reflect the actual reduced budget, not the hardcoded 75s ceiling");
});
