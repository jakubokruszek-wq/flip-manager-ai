import assert from "node:assert/strict";
import test from "node:test";

import {
  claimContinuationRows,
  classifySourceFailure,
  continuationCycleAt,
  continuationEligible,
  isContinuationExpired,
  isPermanentSourceFailure,
  nextContinuationAt,
} from "./scan-continuation.ts";

const NOW = Date.parse("2026-10-04T10:37:42.000Z");
const CYCLE = continuationCycleAt(NOW);

test("the 19,615-second source timeout is represented as a pending next-hour continuation", () => {
  const disposition = classifySourceFailure({ timedOut: true, error: new Error("AbortError"), now: NOW });
  assert.deepEqual(disposition, { status: "pending", errorCode: "SOURCE_TIMEOUT", nextAttemptAt: nextContinuationAt(NOW) });
  assert.equal(isPermanentSourceFailure(new Error("AbortError")), false, "timeout classification is independent from the permanent 403 rule");
});

test("completed rows are never eligible and a row is eligible at most once per cycle", () => {
  const completed = { id: "done", source: "gratka", status: "completed" };
  const pending = { id: "pending", source: "gratka", status: "pending", continuationNextAt: "2026-10-04T10:00:00.000Z", continuationCycleAt: "2026-10-04T09:00:00.000Z" };
  const claimedThisCycle = { ...pending, continuationCycleAt: CYCLE };
  assert.equal(continuationEligible(completed, NOW, CYCLE), false);
  assert.equal(continuationEligible(pending, NOW, CYCLE), true);
  assert.equal(continuationEligible(claimedThisCycle, NOW, CYCLE), false);
  assert.equal(claimContinuationRows([pending, pending, completed], NOW, CYCLE).length, 1);
});

test("one continuation cycle can claim multiple ready sources, while still de-duplicating each row", () => {
  const pending = { id: "pending-1", source: "gratka", status: "pending", continuationNextAt: "2026-10-04T10:00:00.000Z", continuationCycleAt: "2026-10-04T09:00:00.000Z" };
  const secondReady = { ...pending, id: "pending-2", source: "official_uml" };
  const completed = { id: "done", source: "gratka", status: "completed" };
  const claimed = claimContinuationRows([pending, secondReady, pending, completed], NOW, CYCLE);
  assert.deepEqual(claimed.map((row) => row.id), ["pending-1", "pending-2"], "the hourly worker must keep claiming ready rows until its deadline, not stop after the first source");
});

test("a ready row that cannot fit one complete source budget remains for the next hourly cycle", () => {
  const ready = { id: "pending-late", source: "gratka", status: "pending" };
  const timeoutMs = 75_000;
  const deadline = NOW + timeoutMs - 1;
  assert.equal(NOW + timeoutMs <= deadline, false, "the continuation worker must stop before claiming work it cannot finish inside its hard window");
  assert.equal(continuationEligible(ready, NOW, CYCLE), true, "the row itself remains eligible for the next cron invocation");
});

test("a live continuation lease is not reclaimed, but an expired lease or orphan is", () => {
  const live = { id: "live", source: "domy", status: "running", continuationCycleAt: "2026-10-04T09:00:00.000Z", continuationLeaseUntil: "2026-10-04T10:40:00.000Z", startedAt: "2026-10-04T10:00:00.000Z" };
  const expired = { ...live, id: "expired", continuationLeaseUntil: "2026-10-04T10:30:00.000Z" };
  const freshOrphan = { ...live, id: "fresh-orphan", continuationLeaseUntil: null, startedAt: "2026-10-04T10:34:00.000Z" };
  const staleOrphan = { ...live, id: "stale-orphan", continuationLeaseUntil: null, startedAt: "2026-10-04T10:00:00.000Z" };
  assert.equal(continuationEligible(live, NOW, CYCLE), false);
  assert.equal(continuationEligible(expired, NOW, CYCLE), true);
  assert.equal(continuationEligible(freshOrphan, NOW, CYCLE), false);
  assert.equal(continuationEligible(staleOrphan, NOW, CYCLE), true);
});

test("HTTP 403 is terminal and cannot enter the continuation queue", () => {
  const disposition = classifySourceFailure({ timedOut: false, error: new Error("Szybko: HTTP 403."), now: NOW });
  assert.deepEqual(disposition, { status: "failed", errorCode: "SOURCE_FORBIDDEN", nextAttemptAt: null });
  assert.equal(isPermanentSourceFailure("forbidden"), true);
});

test("a continuation that missed two hourly cycles expires instead of blocking forever", () => {
  assert.equal(isContinuationExpired("SOURCE_TIMEOUT: waiting", "2026-10-04T08:00:00.000Z", NOW), true);
  assert.equal(isContinuationExpired("SOURCE_TIMEOUT: waiting", "2026-10-04T10:00:00.000Z", NOW), false);
  assert.equal(isContinuationExpired("SOURCE_FAILED: permanent", "2026-10-04T08:00:00.000Z", NOW), false);
});

test("OLX and Facebook never enter Finder continuation claims", () => {
  const rows = [
    { id: "olx", source: "olx", status: "pending" },
    { id: "facebook", source: "facebook", status: "pending" },
    { id: "official", source: "official_uml", status: "pending" },
  ];
  assert.deepEqual(claimContinuationRows(rows, NOW, CYCLE).map((row) => row.id), ["official"]);
});
