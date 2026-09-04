/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const scheduler = read("features/facebook-worker/scheduler.ts");
const jobs = read("features/facebook-worker/jobs.ts");
const claimRoute = read("app/api/collector/jobs/claim/route.ts");
const completeRoute = read("app/api/collector/jobs/complete/route.ts");
const watchJob = read("features/facebook-groups/watch-job.ts");

test("automatic scheduler keeps exactly one active source in singleton state", () => {
  assert.match(scheduler, /schedulerCycleDecision\(/);
  assert.match(scheduler, /activeBrowserJob/);
  assert.doesNotMatch(scheduler, /Promise\.all\([^)]*enqueueFacebookJobs/s);
});

test("cron and empty queue advance automatic cycles without page messaging", () => {
  assert.match(watchJob, /runFacebookSchedulerTick\(\)/);
  assert.doesNotMatch(watchJob, /safeFacebookGroupAdapter/);
  assert.match(claimRoute, /if \(!job\) \{\s*scheduler = await runFacebookSchedulerTick\(\);\s*job = await claimFacebookJob/s);
  assert.match(claimRoute, /scheduler: scheduler \? \{/);
  assert.match(claimRoute, /"BROWSER_EXTENSION"/);
  assert.doesNotMatch(claimRoute, /BOOTSTRAP|postMessage|READY_REQUEST/);
});

test("terminal jobs advance the next source and source health is persisted", () => {
  assert.match(completeRoute, /await runFacebookSchedulerTick\(\)/);
  for (const field of ["lastScanAt", "lastSuccessAt", "lastCanonicalCount", "lastExactCount", "lastSellCount", "consecutiveFailures"]) assert.match(scheduler, new RegExp(field));
});

test("scheduler lock and diagnostics do not expose collector secrets", () => {
  assert.match(scheduler, /facebook_worker_nonces/);
  assert.match(scheduler, /\.eq\("created_at", createdAt\)/);
  assert.doesNotMatch(scheduler, /deviceToken|token_hash|lease_token/);
  assert.match(scheduler, /lastHeartbeat/);
  assert.match(scheduler, /currentJob/);
  assert.match(scheduler, /preflight:\s*\{/);
  assert.match(scheduler, /activeFilterQuery:/);
});

test("cycle marker survives source finalization through immutable job snapshot", () => {
  assert.match(jobs, /group_snapshot: groupSnapshot/);
  assert.match(jobs, /_facebookScheduler: schedulerMarker/);
  assert.match(scheduler, /attachJobMarkers/);
  assert.match(scheduler, /markerFromJob/);
  assert.match(scheduler, /stampAndVerifyAutomaticSource/);
  assert.match(scheduler, /SCHEDULER_MARKER_VERIFY_FAILED/);
});

test("parallel ticks are serialized before active-job and cycle decisions", () => {
  const lockIndex = scheduler.indexOf("acquireSchedulerLock");
  const activeIndex = scheduler.indexOf("activeBrowserJob", lockIndex);
  const historyIndex = scheduler.indexOf("automaticScanHistory", activeIndex);
  assert.ok(lockIndex >= 0 && activeIndex > lockIndex && historyIndex > activeIndex);
  assert.match(scheduler, /code === "23505"/);
});
