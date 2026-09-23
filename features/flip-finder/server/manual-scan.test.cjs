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

// URGENT ADDITION — production incident: reconcile_canonical_listing_decision
// is service_role-only by design (its own grant migration explicitly revokes
// anon/authenticated). Proven live against production (read-only, a
// nonexistent-id call so nothing is mutated either way): the anon/publishable
// client gets 42501 "permission denied for function
// reconcile_canonical_listing_decision" (surfacing as
// CANONICAL_RECONCILIATION_FAILED); the exact same call with the service-role
// key reaches the function body. manual-scan.ts is trusted, already-
// authorized server code — its own scan/persist/reconcile pipeline must use
// the admin client, never the anon one, or every listing a live scan tries
// to persist fails on this exact permission check.
test("the scan pipeline uses the service-role admin client, never the anon/publishable one, for its own reconcile/persist writes", () => {
  assert.match(source, /import \{ createAdminClient \} from "@\/lib\/supabase\/admin";/, "manual-scan.ts must import the admin (service-role) client factory");
  assert.doesNotMatch(source, /from ["']@\/lib\/supabase\/server["']/, "manual-scan.ts must never import the anon/publishable client — it has been explicitly revoked from reconcile_canonical_listing_decision");
  assert.match(source, /const supabase = createAdminClient\(\);/, "the one supabase client this whole scan run uses (source_scans writes, persistListing, and the facebook reconciliation) must be the admin client");
});

// Whatever throws inside the reconciliation call (a permission error, a
// transient network failure, anything) must produce a terminal "failed"
// SourceScanResult — never leave the caller waiting on a source that will
// never resolve. This is what actually prevented the production incident
// from being a permanent hang: Otodom/Morizon/Facebook all fail fast and
// explicitly instead of leaving the scan funnel stuck at a stage forever.
test("any reconciliation failure (including a permission error) becomes a terminal 'failed' result, never a silent hang", () => {
  const start = source.indexOf("async function reconcileFacebookFromCanonicalListings(");
  assert.ok(start >= 0, "reconcileFacebookFromCanonicalListings must exist");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /\} catch \(error\) \{\s*return failedResult\("facebook", Date\.now\(\) - started, "FACEBOOK_RECONCILIATION_FAILED", error instanceof Error \? error\.message : "[^"]+"\);\s*\}/, "any thrown error — a permission error included — must resolve to a terminal failedResult, not an unresolved/hanging state");
});
