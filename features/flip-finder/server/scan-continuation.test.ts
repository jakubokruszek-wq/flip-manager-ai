import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTINUATION_MAX_WAIT_MS,
  CONTINUATION_RETRY_INTERVAL_MS,
  MAX_CONTINUATION_ATTEMPTS,
  claimContinuationRows,
  classifySourceFailure,
  continuationBackoffMs,
  continuationCycleAt,
  continuationEligible,
  isContinuationExpired,
  isGenuinelyAwaitingContinuation,
  isPermanentSourceFailure,
} from "./scan-continuation.ts";

const NOW = Date.parse("2026-10-04T10:37:42.000Z");
const CYCLE = continuationCycleAt(NOW);

test("a source timing out for the first time gets a short backoff, not a terminal failure", () => {
  const disposition = classifySourceFailure({ timedOut: true, error: new Error("AbortError"), attempt: 1, now: NOW });
  assert.equal(disposition.status, "pending");
  assert.equal(disposition.errorCode, "SOURCE_TIMEOUT");
  assert.equal(disposition.nextAttemptAt, new Date(NOW + CONTINUATION_RETRY_INTERVAL_MS).toISOString());
  assert.equal(isPermanentSourceFailure(new Error("AbortError")), false, "timeout classification is independent from the permanent 403 rule");
});

test("classifySourceFailure defaults to attempt 1 when the caller has not threaded a real continuation_attempt yet", () => {
  const disposition = classifySourceFailure({ timedOut: true, error: new Error("AbortError"), now: NOW });
  assert.equal(disposition.nextAttemptAt, new Date(NOW + CONTINUATION_RETRY_INTERVAL_MS).toISOString());
});

test("repeated timeouts back off geometrically instead of retrying at the full cadence every cycle", () => {
  assert.equal(continuationBackoffMs(1), CONTINUATION_RETRY_INTERVAL_MS);
  assert.equal(continuationBackoffMs(2), CONTINUATION_RETRY_INTERVAL_MS * 2);
  assert.equal(continuationBackoffMs(3), CONTINUATION_RETRY_INTERVAL_MS * 4);
  // Capped well under CONTINUATION_MAX_WAIT_MS -- a chronically slow portal
  // is retried less often, never essentially never.
  assert.equal(continuationBackoffMs(10), 30 * 60 * 1000);
  assert.ok(continuationBackoffMs(10) < CONTINUATION_MAX_WAIT_MS, "backoff must stay well under the abandonment window");
});

test("a source that keeps timing out is eventually given up on for good, not polled forever", () => {
  const stillRetrying = classifySourceFailure({ timedOut: true, error: new Error("AbortError"), attempt: MAX_CONTINUATION_ATTEMPTS - 1, now: NOW });
  assert.equal(stillRetrying.status, "pending", "the attempt just under the cap must still be a normal, retryable timeout");

  const exhausted = classifySourceFailure({ timedOut: true, error: new Error("AbortError"), attempt: MAX_CONTINUATION_ATTEMPTS, now: NOW });
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.errorCode, "SOURCE_CONTINUATION_EXHAUSTED");
  assert.equal(exhausted.nextAttemptAt, null, "an exhausted source must never be scheduled for another retry");
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
  assert.deepEqual(claimed.map((row) => row.id), ["pending-1", "pending-2"], "the continuation worker must keep claiming ready rows until its deadline, not stop after the first source");
});

// 11 pending sources from the same real scan_run_id (the exact shape of the
// read-only Production diagnosis this fix was built from): each one must
// independently progress through successive 5-minute cycles -- none of them
// blocks or waits on any other, and a row already claimed this cycle is
// skipped without affecting the other 10.
test("11 pending sources from the same run each progress through successive continuation cycles independently", () => {
  const RUN_ID = "421dd220-e645-4970-8890-ca105095e737";
  const sources = Array.from({ length: 11 }, (_, index) => ({
    id: `${RUN_ID}-source-${index}`,
    source: `source-${index}`,
    status: "pending",
    continuationNextAt: null,
    continuationCycleAt: null,
  }));

  const firstCycleClaims = claimContinuationRows(sources, NOW, CYCLE);
  assert.equal(firstCycleClaims.length, 11, "every never-claimed pending source must be eligible for its first continuation cycle");

  // Simulate one row being claimed and deferred again this cycle (it now
  // carries this cycle's continuationCycleAt); the other 10 remain untouched.
  const afterOneClaim = sources.map((row, index) => (index === 0 ? { ...row, continuationCycleAt: CYCLE } : row));
  const sameCycleClaims = claimContinuationRows(afterOneClaim, NOW, CYCLE);
  assert.equal(sameCycleClaims.length, 10, "a row already claimed this cycle must not be claimed again in the same cycle, but its 10 siblings remain claimable");

  // Five minutes later (the next cycle), the previously-claimed row becomes
  // claimable again -- it is not permanently excluded by having been claimed
  // once.
  const nextCycleNow = NOW + CONTINUATION_RETRY_INTERVAL_MS;
  const nextCycle = continuationCycleAt(nextCycleNow);
  const nextCycleClaims = claimContinuationRows(afterOneClaim, nextCycleNow, nextCycle);
  assert.equal(nextCycleClaims.length, 11, "every source, including the one claimed last cycle, must be claimable again once a new cycle starts");
});

test("a ready row that cannot fit one complete source budget remains for the next continuation cycle", () => {
  const ready = { id: "pending-late", source: "gratka", status: "pending" };
  const timeoutMs = 30_000;
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

test("a 403 never re-enters the continuation claim queue, even though it carries no next_at of its own", () => {
  const terminal403 = { id: "szybko", source: "szybko", status: "failed" };
  assert.equal(continuationEligible(terminal403, NOW, CYCLE), false, "a terminal (failed) row can never be re-claimed -- its own HTTP 403 never gets a retry");
});

test("a continuation that has been retried past the 2-hour abandonment window expires instead of blocking forever", () => {
  assert.equal(isContinuationExpired("SOURCE_TIMEOUT: waiting", "2026-10-04T08:00:00.000Z", NOW), true, "2h37m since continuationNextAt is past CONTINUATION_MAX_WAIT_MS");
  assert.equal(isContinuationExpired("SOURCE_TIMEOUT: waiting", "2026-10-04T10:00:00.000Z", NOW), false, "37m42s since continuationNextAt is well inside the 2h window");
  assert.equal(isContinuationExpired("SOURCE_FAILED: permanent", "2026-10-04T08:00:00.000Z", NOW), false, "a terminal failure is never subject to continuation expiry at all");
});

// Decoupling proof: shrinking the retry cadence from 1h to 5 minutes must
// never shrink the abandonment window. A 10-minute scheduling gap (two
// missed 5-minute cycles) must not be enough to expire a still-legitimately-
// waiting row, exactly as the user's instruction required.
test("a mere 10-minute scheduling gap never expires a still-legitimately-waiting row", () => {
  const deferredAt = NOW;
  const tenMinutesLater = NOW + 10 * 60 * 1000;
  assert.equal(isContinuationExpired("SOURCE_TIMEOUT: waiting", new Date(deferredAt).toISOString(), tenMinutesLater), false);
});

test("OLX and Facebook never enter Finder continuation claims", () => {
  const rows = [
    { id: "olx", source: "olx", status: "pending" },
    { id: "facebook", source: "facebook", status: "pending" },
    { id: "official", source: "official_uml", status: "pending" },
  ];
  assert.deepEqual(claimContinuationRows(rows, NOW, CYCLE).map((row) => row.id), ["official"]);
});

// UI-facing: a prepared row the worker loop never reached before being
// killed outright has no error_message at all, but it cannot possibly still
// be inside the invocation that reserved it once SOURCE_INVOCATION_CEILING_MS
// has passed. This is what makes the scan panel correctly show "Oczekuje na
// kontynuację" instead of a perpetual, misleading "Skanowanie…" for such a row.
test("isGenuinelyAwaitingContinuation distinguishes real waiting from a possibly-still-running invocation", () => {
  const reservedAt = "2026-10-04T10:36:50.000Z"; // 52s before NOW
  assert.equal(isGenuinelyAwaitingContinuation("pending", null, reservedAt, NOW), false, "under a minute old with no marker: the invocation could still legitimately be working through it");
  const olderReservation = "2026-10-04T10:36:00.000Z"; // 102s before NOW, well past the 60s ceiling
  assert.equal(isGenuinelyAwaitingContinuation("pending", null, olderReservation, NOW), true, "over SOURCE_INVOCATION_CEILING_MS old with no marker: no invocation can still be inside its own window");
  assert.equal(isGenuinelyAwaitingContinuation("pending", "SOURCE_TIMEOUT: waiting", reservedAt, NOW), true, "an explicit marker is always waiting, regardless of age");
  assert.equal(isGenuinelyAwaitingContinuation("running", null, olderReservation, NOW), false, "a running row is never 'waiting' by this function -- that is a different, lease-based question");
  assert.equal(isGenuinelyAwaitingContinuation("completed", null, olderReservation, NOW), false);
});
