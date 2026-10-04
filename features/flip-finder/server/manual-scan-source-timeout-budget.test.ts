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
const { sourceTimeoutBudgetMs, scanSource, scanTimestamp } = await import("./manual-scan.ts");

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

/**
 * Investigated after a real Production run showed 7 of 13 sources' finished_at
 * clustered within 17ms of each other despite the sequential for loop in
 * runManualOtodomScan. This proves why that clustering is explained by
 * scanTimestamp's own semantics, not by overlap: it anchors every timestamp
 * to the shared RESERVATION time (source_scans.started_at, identical across
 * every prepared row in a run) plus only this one source's own elapsed
 * duration -- never the cumulative wall-clock time spent queued behind
 * however many earlier sequential sources already ran. Several sources
 * hitting the exact same timeoutMs ceiling will therefore always compute a
 * finished_at within a few ms of `startedAt + timeoutMs` of each other, no
 * matter how far apart their real wall-clock finish times actually were --
 * so a cluster of near-identical finished_at values is not, by itself,
 * evidence of concurrent/duplicate execution (see
 * manual-scan-concurrent-claim behavior covered in
 * manual-scan-lock-separation.test.ts for what actually would be).
 */
test("scanTimestamp anchors to the shared reservation time plus this call's own elapsed duration, not cumulative wall-clock time since the scan began", () => {
  const reservationTime = "2026-10-04T10:02:36.008081Z";
  const fakeNow = Date.parse(reservationTime) + 500_000; // 500s of real time has passed since reservation, e.g. because many earlier sequential sources already ran
  const originalNow = Date.now;
  try {
    Date.now = () => fakeNow;
    // This source's OWN call only started 19_615ms before "now" -- it was
    // simply queued behind other sources for a long time first.
    const ownStartedMs = fakeNow - 19_615;
    const result = scanTimestamp({ startedAt: reservationTime, startedMs: ownStartedMs });
    const resultOffsetFromReservation = Date.parse(result) - Date.parse(reservationTime);
    assert.equal(resultOffsetFromReservation, 19_615, "must reflect only this source's own ~19.615s duration, not the 500s of real time elapsed since the scan's reservation");
  } finally {
    Date.now = originalNow;
  }
});

test("two sources with the same timeoutMs ceiling compute finished_at within milliseconds of each other even though they really ran at very different wall-clock times", () => {
  const reservationTime = "2026-10-04T10:02:36.008081Z";
  const reservationMs = Date.parse(reservationTime);
  const budget = 19_615;
  // Source A runs almost immediately. Source B is queued for two full real
  // minutes behind other sources before it even starts, then also takes the
  // full budget. Both are genuine, correctly sequential executions -- B
  // really does finish two minutes later than A in wall-clock time.
  const sourceAStartedMs = reservationMs + 100;
  const sourceBStartedMs = reservationMs + 120_100;
  const originalNow = Date.now;
  try {
    Date.now = () => sourceAStartedMs + budget;
    const finishedA = scanTimestamp({ startedAt: reservationTime, startedMs: sourceAStartedMs });
    Date.now = () => sourceBStartedMs + budget;
    const finishedB = scanTimestamp({ startedAt: reservationTime, startedMs: sourceBStartedMs });
    const driftMs = Math.abs(Date.parse(finishedB) - Date.parse(finishedA));
    assert.ok(driftMs < 50, `two sequential sources really finishing two real minutes apart still compute finished_at only ${driftMs}ms apart -- clustering alone cannot distinguish this from overlap`);
  } finally {
    Date.now = originalNow;
  }
});
