import assert from "node:assert/strict";
import test from "node:test";

const { scanSource } = await import("./manual-scan.ts");

/**
 * Reproduces a real, live bug found while running the client-side
 * auto-resume loop (monitorScanRun) against Production data: Domiporta kept
 * restarting from checked:0 and re-hitting the same ~10s timeout every
 * round, forever -- continuation_attempt was never actually advancing.
 *
 * Root cause: continuation_attempt is only ever incremented by
 * claim_finder_scan_source's RPC (the GitHub Actions continuation path).
 * scanSource's OWN manual-claim branch (prepared && !preparedAlreadyRunning
 * -- exactly the path monitorScanRun's auto-resume and a plain "Skanuj
 * oferty" click both take) never wrote it at all, so classifySourceFailure's
 * MAX_CONTINUATION_ATTEMPTS check always saw attempt=1 no matter how many
 * times the same source was manually resumed -- it could never turn
 * terminal, so it retried identically forever instead of eventually giving
 * up and letting the run finish with whatever sources did complete.
 *
 * This fakes a chronically-timing-out source and drives scanSource through
 * MAX_CONTINUATION_ATTEMPTS manual resumes (each one a separate scanSource
 * call sharing the same fake row, exactly like separate monitorScanRun
 * auto-resume POSTs each do), reading back the row's own continuation_attempt
 * between rounds the same way loadPreparedSourceScans would.
 */

const MAX_CONTINUATION_ATTEMPTS = 12;
const TIMEOUT_MS = 10_000;

function fakeAdmin(row: Record<string, unknown>) {
  return {
    row,
    from(table: string) {
      assert.equal(table, "source_scans");
      let mode: "select" | "update" = "select";
      let patch: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        update: (value: Record<string, unknown>) => { mode = "update"; patch = value; return builder; },
        eq: () => builder,
        gt: () => builder,
        abortSignal: () => builder,
        async maybeSingle() { return { data: { id: row.id }, error: null }; },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          const run = async () => {
            if (mode === "update") {
              Object.assign(row, patch);
              return { data: [{ id: row.id, started_at: row.started_at, continuation_lease_token: row.continuation_lease_token, filter_snapshot: row.filter_snapshot }], error: null };
            }
            return { data: [row], error: null };
          };
          return run().then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

test("a chronically-timing-out source manually/auto-resumed repeatedly eventually turns terminal instead of retrying forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const row: Record<string, unknown> = {
    id: "scan-domiporta",
    source: "domiporta",
    status: "pending",
    started_at: "2026-10-06T10:00:00.000Z",
    continuation_attempt: 0,
    continuation_lease_token: null,
    continuation_lease_until: null,
  };
  const supabase = fakeAdmin(row);

  const hangingSource = {
    id: "domiporta",
    label: "Domiporta",
    fetch: (_filter: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  const filterFixture = { id: "filter-1" } as never;

  const attemptsAtEachRound: number[] = [];
  let lastResult: Awaited<ReturnType<typeof scanSource>> | null = null;

  // Exactly what monitorScanRun's auto-resume loop does: a fresh scanSource
  // call per round, each one reading the row's CURRENT continuation_attempt
  // (as loadPreparedSourceScans would) rather than a value carried over in
  // memory -- proving the persisted value itself is what grows.
  for (let round = 1; round <= MAX_CONTINUATION_ATTEMPTS; round += 1) {
    row.status = "pending"; // simulates the row being finalized back to "pending" between rounds
    const prepared = { id: row.id as string, source: "domiporta", started_at: row.started_at as string, continuation_attempt: row.continuation_attempt as number };
    const resultPromise = scanSource(hangingSource as never, "filter-1", filterFixture, supabase as never, "run-domiporta", new Map(), prepared, TIMEOUT_MS);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(TIMEOUT_MS);
    lastResult = await resultPromise;
    attemptsAtEachRound.push(row.continuation_attempt as number);
    if (lastResult.status === "failed") break;
  }

  assert.deepEqual(attemptsAtEachRound, Array.from({ length: MAX_CONTINUATION_ATTEMPTS }, (_, i) => i + 1), "continuation_attempt must advance by exactly 1 on every manual round, reaching 12 on the 12th -- before the fix this stayed at 1 forever");
  assert.equal(lastResult?.status, "failed", "after MAX_CONTINUATION_ATTEMPTS the source must finally turn terminal");
  assert.equal(lastResult?.errorCode, "SOURCE_CONTINUATION_EXHAUSTED");
  assert.equal(row.status, "failed", "the row itself must be left terminal, not pending forever");
  assert.equal(row.continuation_next_at, null, "a terminal row must never be scheduled for another retry");
});
