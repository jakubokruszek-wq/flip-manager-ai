import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Issue 3 from the scan-lifecycle review: SearchFiltersPage's own polling
 * loop capped out at 300 attempts (~5 minutes), strictly shorter than the
 * server's own 15-minute staleness contract (scan-lifecycle.ts). A
 * legitimately slow but healthy scan would be falsely reported as timed out
 * while the backend was still correctly working. waitUntilScanTerminal (the
 * one shared polling loop both Finder pages now build on) must keep polling
 * for as long as the backend reports active work, with no attempt cap at
 * all -- proven here by polling well past the old 300-attempt limit using
 * Node's mock timers, so the proof is fast and deterministic rather than a
 * real multi-minute wait.
 */

type Row = Record<string, unknown>;

function runningSnapshot(runId: string): Row {
  return {
    runId,
    status: "running",
    startedAt: "2026-10-03T12:00:00.000Z",
    finishedAt: null,
    elapsedMs: 1_000,
    overall: { completedUnits: 0, totalUnits: 1, percent: 0, failedUnits: 0, remainingUnits: 1 },
    current: null,
    facebook: { totalGroups: 0, completedGroups: 0, runningGroups: 0, queuedGroups: 0, failedGroups: 0, discovered: 0, processed: 0, groups: [] },
    olx: { status: null, raw: 0, normalized: 0, processed: 0, errorMessage: null },
    totals: { scanned: 1, matched: 0, created: 0, updated: 0, priceDrops: 0 },
    collector: null,
    partialReason: null,
    errors: [],
    openai: { lastRun: {}, today: {}, month: {}, monthlyBudgetUsd: null, remainingBudgetUsd: null, budgetUsedPercent: null, balanceUsd: null, balanceStatus: "UNAVAILABLE" },
  };
}

function completedSnapshot(runId: string): Row {
  return {
    ...runningSnapshot(runId),
    status: "completed",
    finishedAt: "2026-10-03T12:10:00.000Z",
    overall: { completedUnits: 1, totalUnits: 1, percent: 100, failedUnits: 0, remainingUnits: 0 },
    totals: { scanned: 500, matched: 12, created: 7, updated: 2, priceDrops: 0 },
  };
}

let respond: () => Row | null = () => null;

mock.module("@/lib/api-fetch", {
  namedExports: {
    apiFetch: async (_input: unknown, init: RequestInit = {}) => {
      const signal = init.signal as AbortSignal | undefined;
      if (signal?.aborted) {
        const reason = (signal as AbortSignal & { reason?: unknown }).reason;
        throw reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
      }
      const body = respond();
      if (body === null) return new Response(JSON.stringify({ message: "Nie udało się pobrać postępu skanu." }), { status: 500 });
      return new Response(JSON.stringify(body), { status: 200 });
    },
  },
});
const { waitUntilScanTerminal } = await import("./scan-progress-client.ts");

test("polls past the old 300-attempt cap while the backend reports active work, then resolves on the real terminal snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runId = "run-slow-1";
  const TOTAL_RUNNING_POLLS = 320;
  let callCount = 0;
  respond = () => {
    callCount += 1;
    return callCount > TOTAL_RUNNING_POLLS ? completedSnapshot(runId) : runningSnapshot(runId);
  };

  const controller = new AbortController();
  const resultPromise = waitUntilScanTerminal(runId, controller.signal, 1_000);

  for (let i = 0; i < TOTAL_RUNNING_POLLS + 2; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(result.totals.scanned, 500, "the real final totals from the backend's own terminal snapshot must be returned");
  assert.ok(callCount > TOTAL_RUNNING_POLLS, `must have actually kept polling past the old 300-attempt cap (polled ${callCount} times)`);
});

test("aborting the signal (e.g. on unmount) stops polling instead of continuing to fetch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runId = "run-abort-1";
  let callCount = 0;
  respond = () => {
    callCount += 1;
    return runningSnapshot(runId);
  };

  const controller = new AbortController();
  const resultPromise = waitUntilScanTerminal(runId, controller.signal, 1_000);
  resultPromise.catch(() => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  const callsBeforeAbort = callCount;
  controller.abort();
  t.mock.timers.tick(1_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1_000);
  await new Promise<void>((resolve) => setImmediate(resolve));

  await assert.rejects(resultPromise, /AbortError|Aborted|cancelled/i);
  assert.equal(callCount, callsBeforeAbort, "no further poll may fire once the signal is aborted");
});

test("three consecutive read failures stop polling with a clear error, never spinning forever on a broken backend", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runId = "run-broken-1";
  respond = () => null;

  const controller = new AbortController();
  const resultPromise = waitUntilScanTerminal(runId, controller.signal, 1_000);
  resultPromise.catch(() => {});
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));

  await assert.rejects(resultPromise, /Nie udało się odczytać postępu skanu/);
});
