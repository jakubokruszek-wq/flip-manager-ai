import assert from "node:assert/strict";
import test from "node:test";

import { selectClearResultsTargets } from "./clear-results-targeting.ts";

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
