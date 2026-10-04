import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";

/**
 * Integration test for the actual route, not a stand-in for it: uses the
 * REAL authorizeContinuationRequest (so FINDER_CRON_SECRET's acceptance is
 * proven for this exact endpoint too) and the REAL runAfterResponse --
 * only runFinderScanContinuations itself is mocked, since its real claim/
 * lease/RPC behavior is manual-scan.ts's own test files' job, not this
 * file's.
 */

const FINDER_SECRET = "finder-cron-secret-continuation-route-test-value";
process.env.FINDER_CRON_SECRET = FINDER_SECRET;
delete process.env.CRON_SECRET;

let continuationCalls = 0;
let continuationBehavior: "resolve" | "hang" | "throw" = "resolve";
mock.module("@/features/flip-finder/server/manual-scan", {
  namedExports: {
    runFinderScanContinuations: async () => {
      continuationCalls += 1;
      if (continuationBehavior === "throw") throw new Error("simulated continuation failure");
      if (continuationBehavior === "hang") return new Promise(() => { /* never resolves within this test */ });
      return { status: "completed", cycleAt: "2026-10-04T18:00:00.000Z", claimed: 1, completed: 1, deferred: 0, failed: 0, errors: [] };
    },
  },
});

const route = await import("../../../app/api/jobs/finder-scan-continuation/route.ts");

function request(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("https://flip-manager-ai.vercel.app/api/jobs/finder-scan-continuation", { method: "POST", headers });
}

test("an unauthenticated request is rejected with 401 and continuation is never run", async () => {
  continuationCalls = 0;
  const response = await route.POST(request());
  assert.equal(response.status, 401);
  assert.equal(continuationCalls, 0);
});

test("a wrong secret is rejected -- FINDER_CRON_SECRET must match exactly", async () => {
  continuationCalls = 0;
  const response = await route.POST(request("Bearer not-the-right-secret"));
  assert.equal(response.status, 401);
  assert.equal(continuationCalls, 0);
});

test("the Finder-scoped secret authorizes the request and returns a fast 202 'accepted' -- even while the continuation cycle hangs", async () => {
  continuationCalls = 0;
  continuationBehavior = "hang";
  const startedAt = Date.now();
  const response = await route.POST(request(`Bearer ${FINDER_SECRET}`));
  const elapsedMs = Date.now() - startedAt;
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "accepted" });
  assert.ok(elapsedMs < 2_000, `the response must never wait on the continuation cycle, took ${elapsedMs}ms -- this is exactly what keeps a 30s-timeout external trigger (e.g. cron-job.org) from seeing a false failure`);
  continuationBehavior = "resolve";
});

test("the deferred continuation cycle actually runs (fire-and-forget, not dropped)", async () => {
  continuationCalls = 0;
  continuationBehavior = "resolve";
  const response = await route.POST(request(`Bearer ${FINDER_SECRET}`));
  assert.equal(response.status, 202);
  assert.equal(continuationCalls, 1);
});

test("a continuation failure inside the deferred task never surfaces as a route error -- the 202 was already sent", async () => {
  continuationCalls = 0;
  continuationBehavior = "throw";
  const response = await route.POST(request(`Bearer ${FINDER_SECRET}`));
  assert.equal(response.status, 202);
  assert.equal(continuationCalls, 1);
  continuationBehavior = "resolve";
});

test("two near-simultaneous invocations (e.g. GitHub Actions and cron-job.org overlapping) each get their own fast 202, and each defers its own independent attempt", async () => {
  continuationCalls = 0;
  continuationBehavior = "resolve";
  const [first, second] = await Promise.all([
    route.POST(request(`Bearer ${FINDER_SECRET}`)),
    route.POST(request(`Bearer ${FINDER_SECRET}`)),
  ]);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(continuationCalls, 2, "the route wrapper must not drop or merge either request -- it is runFinderScanContinuations' own claim_finder_scan_source lease, proven separately in manual-scan.ts's tests, that keeps two real concurrent attempts from double-processing the same row");
});

test("the continuation route source never references facebook_scan_jobs or Facebook Watch's own runner -- this fast-ACK rewrite adds no new path to Facebook", () => {
  const routeSource = fs.readFileSync(path.join(process.cwd(), "app", "api", "jobs", "finder-scan-continuation", "route.ts"), "utf8");
  assert.doesNotMatch(routeSource, /facebook_scan_jobs|runFacebookWatchJob|enqueueFacebook/);
});
