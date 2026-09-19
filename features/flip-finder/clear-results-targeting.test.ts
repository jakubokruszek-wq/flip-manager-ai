import assert from "node:assert/strict";
import test from "node:test";

import { selectClearResultsTargets, selectVisibleListingIds } from "./clear-results-targeting.ts";

// -----------------------------------------------------------------------------
// PRODUCTION REGRESSION: "Wyczyść wyniki" appeared to do nothing. Root cause:
// a REVIEW-bucket listing (the "Do oceny" tab) is intentionally persisted with
// is_current_match=false, so filtering the match query on is_current_match
// alone silently excluded every REVIEW result. Whenever a filter's Finder view
// is entirely REVIEW listings (as it is in real production data today), the
// clear found zero candidates and reported "nothing to clear" — indistinguishable
// from the button doing nothing.
// -----------------------------------------------------------------------------

test("REGRESSION: a REVIEW-bucket listing is visible for clearing despite is_current_match=false", () => {
  const ids = selectVisibleListingIds([{ listingId: "review-1", isCurrentMatch: false, matchReasons: ["review", "unknown_price"] }]);
  assert.deepEqual(ids, ["review-1"]);
});

test("REGRESSION: a filter whose only visible results are REVIEW no longer clears to zero candidates", () => {
  const ids = selectVisibleListingIds([
    { listingId: "review-1", isCurrentMatch: false, matchReasons: ["review"] },
    { listingId: "review-2", isCurrentMatch: false, matchReasons: ["unknown_buildingType"] },
  ]);
  assert.equal(ids.length, 2, "this is exactly the production state that made the button look broken");
});

test("a reconciled-out (INACTIVE) match is not visible and is not selected", () => {
  const ids = selectVisibleListingIds([{ listingId: "gone", isCurrentMatch: false, matchReasons: ["facebook_search"] }]);
  assert.deepEqual(ids, []);
});

test("a MATCHED listing is still selected exactly as before", () => {
  const ids = selectVisibleListingIds([{ listingId: "matched-1", isCurrentMatch: true, matchReasons: ["facebook_search"] }]);
  assert.deepEqual(ids, ["matched-1"]);
});

test("duplicate match rows for the same listing collapse to one id", () => {
  const ids = selectVisibleListingIds([
    { listingId: "dup", isCurrentMatch: true, matchReasons: [] },
    { listingId: "dup", isCurrentMatch: true, matchReasons: [] },
  ]);
  assert.deepEqual(ids, ["dup"]);
});

const now = Date.parse("2026-09-19T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

function listing(overrides: Partial<{ id: string; source: "otodom" | "olx" | "morizon" | "facebook"; lifecycleStatus: string | null; lastSeenAt: string | null }> = {}) {
  return { id: "l1", source: "olx" as const, lifecycleStatus: "ACTIVE", lastSeenAt: daysAgo(1), ...overrides };
}

test("A. an old OLX listing is selected for clearing", () => {
  const targets = selectClearResultsTargets([listing({ id: "old-olx", source: "olx", lastSeenAt: daysAgo(30) })], { source: "olx", olderThanDays: 14 }, now);
  assert.deepEqual(targets, ["old-olx"]);
});

test("with no scope, every currently-visible listing is selected", () => {
  const targets = selectClearResultsTargets(
    [listing({ id: "a", lifecycleStatus: "ACTIVE" }), listing({ id: "b", lifecycleStatus: "REVIEW" })],
    {},
    now,
  );
  assert.deepEqual(targets.sort(), ["a", "b"]);
});

test("already-hidden lifecycle states (STALE/ARCHIVED/REJECTED) are never re-selected", () => {
  const targets = selectClearResultsTargets(
    [listing({ id: "stale", lifecycleStatus: "STALE" }), listing({ id: "archived", lifecycleStatus: "ARCHIVED" }), listing({ id: "rejected", lifecycleStatus: "REJECTED" })],
    {},
    now,
  );
  assert.deepEqual(targets, []);
});

test("source scope excludes other sources", () => {
  const targets = selectClearResultsTargets(
    [listing({ id: "olx-1", source: "olx" }), listing({ id: "facebook-1", source: "facebook" })],
    { source: "facebook" },
    now,
  );
  assert.deepEqual(targets, ["facebook-1"]);
});

test("olderThanDays keeps recently-seen listings out of scope", () => {
  const targets = selectClearResultsTargets(
    [listing({ id: "recent", lastSeenAt: daysAgo(2) }), listing({ id: "old", lastSeenAt: daysAgo(20) })],
    { olderThanDays: 14 },
    now,
  );
  assert.deepEqual(targets, ["old"]);
});

test("a listing with no last_seen_at is never selected by an age-scoped clear", () => {
  const targets = selectClearResultsTargets([listing({ id: "no-date", lastSeenAt: null })], { olderThanDays: 1 }, now);
  assert.deepEqual(targets, []);
});
