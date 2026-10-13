import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * pg_cron (net.http_post) records "succeeded" for HTTP 202. The route answers
 * 202 right after authorization and only then runs the scheduler cycle in the
 * background, so 202 confirms delivery, never that a scan started or finished.
 * The outcome exists only in FINDER_SCHEDULER_RUN_COMPLETE / _FAILED logs.
 */

let authorized = true;
let deferred: Array<() => Promise<void>> = [];
let release: () => void = () => undefined;
let schedulerFinished = false;

mock.module("@/features/auth/github-actions-oidc", { namedExports: { authorizeFinderSchedulerRequest: async () => authorized } });
mock.module("@/features/facebook-watcher/run-after-response", { namedExports: { runAfterResponse: (work: () => Promise<void>) => { deferred.push(work); } } });
mock.module("@/features/flip-finder/server/finder-scheduler", {
  namedExports: {
    runFinderScanScheduler: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      schedulerFinished = true;
      return { status: "partial", checked: 1, due: 1, started: 0, skippedRunning: 0, skippedNotDue: 0, completed: 0, partial: 0, errors: ["flip: FINDER_RESERVE_TIMEOUT"], runs: [] };
    },
  },
});

const { POST } = await import("../../../app/api/jobs/finder-scan-scheduler/route.ts");

test("HTTP 202 is returned before the scheduler cycle runs and is not a completion signal", async () => {
  authorized = true;
  deferred = [];
  schedulerFinished = false;
  const response = await POST(new Request("https://example.test/api/jobs/finder-scan-scheduler", { method: "POST" }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "accepted" });
  assert.equal(deferred.length, 1, "the cycle is deferred after the response");
  assert.equal(schedulerFinished, false, "nothing has run when 202 is sent");

  const logs: Array<[string, unknown]> = [];
  const info = mock.method(console, "info", (event: string, payload: unknown) => { logs.push([event, payload]); });
  try {
    const cycle = deferred[0]();
    release();
    await cycle;
  } finally {
    info.mock.restore();
  }
  // The real outcome (here: a failure) is only visible in the log, never in the HTTP status.
  assert.equal(logs[0]?.[0], "FINDER_SCHEDULER_RUN_COMPLETE");
  assert.equal((logs[0]?.[1] as { status: string }).status, "partial");
});

test("an unauthorized trigger gets 401 and schedules no work", async () => {
  authorized = false;
  deferred = [];
  const response = await POST(new Request("https://example.test/api/jobs/finder-scan-scheduler", { method: "POST" }));
  assert.equal(response.status, 401);
  assert.equal(deferred.length, 0);
});
