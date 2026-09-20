import test from "node:test";
import assert from "node:assert/strict";
import { countFacebookWatcherLifecycle } from "./lifecycle-counts.ts";

test("Watcher lifecycle diagnostics separate database population from Finder candidates", () => {
  const statuses = [...Array(20).fill("ACTIVE"), ...Array(9).fill("REVIEW"), ...Array(20).fill("ARCHIVED"), ...Array(6).fill("REJECTED"), ...Array(5).fill("STALE")];
  const counts = countFacebookWatcherLifecycle(statuses.map((lifecycleStatus, index) => ({ listingId: String(index), lifecycleStatus }) as never));
  assert.deepEqual(counts, { database: 60, current: 29, review: 9, archived: 20, stale: 5, rejected: 6 });
});
