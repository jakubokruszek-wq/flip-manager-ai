/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "manual-scan.ts"), "utf8");

// Finder/Watcher contract mission: Flip Finder must never acquire Facebook
// posts itself. enqueueFacebookJobs (features/facebook-worker/jobs.ts) is the
// ONLY function in this codebase that can insert a facebook_scan_jobs row —
// the row the browser extension polls and acts on. If manual-scan.ts never
// imports or calls it, a Finder-triggered scan is structurally incapable of
// creating one, regardless of what path execution takes at runtime.
test("manual-scan.ts never imports or calls enqueueFacebookJobs — Finder cannot create a Facebook extension job", () => {
  assert.doesNotMatch(source, /enqueueFacebookJobs/, "no reference to the Facebook job-enqueue function may remain in Finder's own scan path");
  assert.doesNotMatch(source, /from ["']@\/features\/facebook-worker\/jobs["']/, "manual-scan.ts must not import from facebook-worker/jobs at all");
});

test("a Facebook-enabled filter is reconciled from canonical listings only, never queued", () => {
  assert.match(source, /const facebookEnabled = filter\.sources\.includes\("facebook"\);/, "the facebookEnabled gate itself must be unchanged");
  assert.match(source, /if \(facebookEnabled\) \{\s*sourceResults\.push\(await reconcileFacebookFromCanonicalListings\(filterId, runId\)\);\s*\}/, "the facebook branch must call the canonical reconciliation helper, not an enqueue function");
  assert.match(source, /async function reconcileFacebookFromCanonicalListings\(filterId: string, runId: string\): Promise<SourceScanResult> \{/, "the reconciliation helper must exist with this exact signature");
  assert.match(source, /await recalculateFilterMatches\(filterId, \{ allowWithoutScan: true, scanRunId: runId, sourcesOverride: \["facebook"\] \}\)/, "reconciliation must be scoped to facebook only, and must not require a prior scan to already exist");
});

test("mixed-source filters keep their real Otodom/Morizon scan and OLX enqueue untouched", () => {
  assert.match(source, /for \(const source of sources\.filter\(\(item\) => item\.id !== "olx"\)\) \{\s*sourceResults\.push\(await scanSource\(source, filterId, filter, supabase, runId, ownedScans\)\);\s*\}/, "the real (non-Facebook, non-OLX) source fetch loop must be unchanged");
  assert.match(source, /await enqueueOlxJob\(filter, runId\);/, "OLX's own separate async worker queue is unrelated to this mission and must remain");
});

test("the stored listing source value for Facebook listings is never renamed by this contract change", () => {
  assert.match(source, /source: "facebook"/, "reconcileFacebookFromCanonicalListings must still report source: \"facebook\" in its SourceScanResult, matching the unchanged stored value");
});
