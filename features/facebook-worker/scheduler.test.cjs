/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "scheduler.ts"), "utf8");

// URGENT ADDITION — production incident regression guard: the Facebook
// Watcher's own autonomous scheduler is a completely independent collection
// mechanism from Finder's manual scan (fixed in this same mission to stop
// acquiring Facebook itself). This proves that independence structurally:
// the scheduler must still import and call enqueueFacebookJobs — the only
// function that can create a facebook_scan_jobs row for the browser
// extension — regardless of anything changed in Finder's own scan path.
test("the Watcher scheduler still independently enqueues Facebook collection jobs, unaffected by Finder's own scan-path fix", () => {
  assert.match(source, /import \{ enqueueFacebookJobs \} from "\.\/jobs";/, "the scheduler must still import enqueueFacebookJobs");
  assert.match(source, /await enqueueFacebookJobs\(scheduledFilter, cycleId, source\.sourceId\)/, "the scheduler must still call it to enqueue real Facebook collection");
});
