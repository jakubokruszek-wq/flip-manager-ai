import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";

/**
 * Integration test for the actual route, not a stand-in for it: uses the
 * REAL authorizeFinderSchedulerRequest (so FINDER_CRON_SECRET's acceptance
 * is proven for this exact endpoint, not just in isolation) and the REAL
 * runAfterResponse (so the fast-ACK property is proven against the actual
 * deferral mechanism, not a mock of it) -- only the scheduler cycle itself
 * (runFinderScanScheduler) is mocked, since exercising its real DB/CAS
 * behavior is finder-scheduler.test.ts's and finder-scheduler-postgres-
 * cas.test.ts's job, not this file's.
 */

const FINDER_SECRET = "finder-cron-secret-route-test-value";
process.env.FINDER_CRON_SECRET = FINDER_SECRET;
delete process.env.CRON_SECRET;

let schedulerCalls = 0;
let schedulerBehavior: "resolve" | "hang" | "throw" = "resolve";
mock.module("@/features/flip-finder/server/finder-scheduler", {
  namedExports: {
    runFinderScanScheduler: async () => {
      schedulerCalls += 1;
      if (schedulerBehavior === "throw") throw new Error("simulated scheduler failure");
      if (schedulerBehavior === "hang") return new Promise(() => { /* never resolves within this test */ });
      return { status: "completed", checked: 1, due: 1, started: 1, skippedRunning: 0, skippedNotDue: 0, completed: 1, partial: 0, errors: [], runs: [] };
    },
  },
});

const route = await import("../../../app/api/jobs/finder-scan-scheduler/route.ts");

function request(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("https://flip-manager-ai.vercel.app/api/jobs/finder-scan-scheduler", { method: "POST", headers });
}

test("an unauthenticated request is rejected with 401 and the scheduler is never called", async () => {
  schedulerCalls = 0;
  const response = await route.POST(request());
  assert.equal(response.status, 401);
  assert.equal(schedulerCalls, 0);
});

test("the general CRON_SECRET (unset here) does not leak into FINDER_CRON_SECRET's role -- a wrong secret is still rejected", async () => {
  schedulerCalls = 0;
  const response = await route.POST(request("Bearer not-the-right-secret"));
  assert.equal(response.status, 401);
  assert.equal(schedulerCalls, 0);
});

test("the Finder-scoped secret authorizes the request and returns a fast 202 'accepted' -- even while the scheduler cycle hangs", async () => {
  schedulerCalls = 0;
  schedulerBehavior = "hang";
  const startedAt = Date.now();
  const response = await route.POST(request(`Bearer ${FINDER_SECRET}`));
  const elapsedMs = Date.now() - startedAt;
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "accepted" });
  assert.ok(elapsedMs < 2_000, `the response must never wait on the scheduler cycle, took ${elapsedMs}ms`);
  schedulerBehavior = "resolve";
});

test("the deferred scheduler cycle actually runs (fire-and-forget, not dropped)", async () => {
  schedulerCalls = 0;
  schedulerBehavior = "resolve";
  const response = await route.POST(request(`Bearer ${FINDER_SECRET}`));
  assert.equal(response.status, 202);
  assert.equal(schedulerCalls, 1, "runAfterResponse's outside-a-request-scope fallback runs the task synchronously in this test process, with no internal await in the mock, so it must have already run by the time POST resolves");
});

test("a scheduler failure inside the deferred task never surfaces as a route error -- the 202 was already sent", async () => {
  schedulerCalls = 0;
  schedulerBehavior = "throw";
  const response = await route.POST(request(`Bearer ${FINDER_SECRET}`));
  assert.equal(response.status, 202);
  assert.equal(schedulerCalls, 1);
  schedulerBehavior = "resolve";
});

test("two near-simultaneous invocations (e.g. GitHub Actions and cron-job.org overlapping) each get their own fast 202, and each defers its own independent attempt", async () => {
  schedulerCalls = 0;
  schedulerBehavior = "resolve";
  const [first, second] = await Promise.all([
    route.POST(request(`Bearer ${FINDER_SECRET}`)),
    route.POST(request(`Bearer ${FINDER_SECRET}`)),
  ]);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(schedulerCalls, 2, "the route wrapper must not drop or merge either request -- it is claimFinderFilter's own CAS, proven separately in finder-scheduler-postgres-cas.test.ts, that keeps two real concurrent cycles from starting the same filter twice");
});

test("the scheduler route source never references facebook_scan_jobs or Facebook Watch's own runner -- this fast-ACK rewrite adds no new path to Facebook", () => {
  const routeSource = fs.readFileSync(path.join(process.cwd(), "app", "api", "jobs", "finder-scan-scheduler", "route.ts"), "utf8");
  assert.doesNotMatch(routeSource, /facebook_scan_jobs|runFacebookWatchJob|enqueueFacebook/);
});
