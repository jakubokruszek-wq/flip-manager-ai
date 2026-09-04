/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const scheduler = read("features/facebook-worker/scheduler.ts");
const claimRoute = read("app/api/collector/jobs/claim/route.ts");
const completeRoute = read("app/api/collector/jobs/complete/route.ts");
const watchJob = read("features/facebook-groups/watch-job.ts");

test("automatic scheduler keeps exactly one active source in singleton state", () => {
  assert.match(scheduler, /nextSchedulerSource\(/);
  assert.match(scheduler, /activeBrowserJob/);
  assert.doesNotMatch(scheduler, /Promise\.all\([^)]*enqueueFacebookJobs/s);
});

test("cron and empty queue advance automatic cycles without page messaging", () => {
  assert.match(watchJob, /runFacebookSchedulerTick\(\)/);
  assert.doesNotMatch(watchJob, /safeFacebookGroupAdapter/);
  assert.match(claimRoute, /if \(!job\) \{\s*await runFacebookSchedulerTick\(\);\s*job = await claimFacebookJob/s);
  assert.match(claimRoute, /"BROWSER_EXTENSION"/);
  assert.doesNotMatch(claimRoute, /BOOTSTRAP|postMessage|READY_REQUEST/);
});

test("terminal jobs advance the next source and source health is persisted", () => {
  assert.match(completeRoute, /await runFacebookSchedulerTick\(\)/);
  for (const field of ["lastScanAt", "lastSuccessAt", "lastCanonicalCount", "lastExactCount", "lastSellCount", "consecutiveFailures"]) assert.match(scheduler, new RegExp(field));
});

test("scheduler lock and diagnostics do not expose collector secrets", () => {
  assert.match(scheduler, /facebook_worker_nonces/);
  assert.doesNotMatch(scheduler, /deviceToken|token_hash|lease_token/);
  assert.match(scheduler, /lastHeartbeat/);
  assert.match(scheduler, /currentJob/);
});
