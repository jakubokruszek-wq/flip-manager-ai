import assert from "node:assert/strict";
import test from "node:test";
import { canonicalVisibilityDebug, summarizeCanonicalVisibility } from "./canonical-visibility.ts";

test("historical listings expose current decision without claiming Finder visibility", () => {
  const debug = canonicalVisibilityDebug({ listingId: "archived-review", canonicalBucket: "REVIEW", lifecycleStatus: "ARCHIVED", isCurrentMatch: false, matchReasons: ["review", "unknown_topFloor"], visibilityInFinder: false, visibilityInWatcher: true, reason: "review_uncertainty" });
  assert.equal(debug.finderStatus, "HISTORICAL");
  assert.equal(debug.visibilityInWatcher, true);
  assert.equal(debug.visibilityInFinder, false);
});

test("canonical visibility summary accounts for matched, review, rejected, and historical rows", () => {
  const rows = ([
    ["a", "MATCHED", "ACTIVE", true, true],
    ["b", "REVIEW", "REVIEW", false, true],
    ["c", "REJECTED", "REJECTED", false, true],
    ["d", "REVIEW", "STALE", false, true],
  ] as const).map(([listingId, canonicalBucket, lifecycleStatus, isCurrentMatch, visibilityInWatcher]) => canonicalVisibilityDebug({ listingId, canonicalBucket, lifecycleStatus, isCurrentMatch, matchReasons: [], visibilityInFinder: canonicalBucket !== "REJECTED" && lifecycleStatus !== "STALE", visibilityInWatcher, reason: "test" }));
  assert.deepEqual(summarizeCanonicalVisibility(rows), { totalWatcher: 4, matched: 1, review: 1, rejected: 1, historical: 1 });
});
