import assert from "node:assert/strict";
import test from "node:test";
import {
  canReconcileNegativeResults,
  membershipAuditEntry,
  reconciliationMembershipState,
  visibleMembership,
} from "./membership-reconciliation.ts";

const finishedAt = "2026-09-06T10:00:00.000Z";

test("failed scan cannot reconcile negative results", () => {
  assert.deepEqual(canReconcileNegativeResults({ status: "failed", finishedAt, errorMessage: "COLLECT_SOURCE_RESPONSE_TIMEOUT" }), { allowed: false, reason: "SCAN_FAILED" });
  assert.equal(visibleMembership({ isCurrentMatch: true, matchReasons: [] }), true);
});

test("partial scan without complete coverage preserves unseen memberships", () => {
  assert.deepEqual(canReconcileNegativeResults({ status: "partial", finishedAt, coverageComplete: false }), { allowed: false, reason: "SCAN_PARTIAL_COVERAGE_INSUFFICIENT" });
  assert.deepEqual(canReconcileNegativeResults({ status: "partial", finishedAt, coverageComplete: true }), { allowed: true, reason: "COMPLETE_SCAN" });
});

test("complete scan can reconcile only after terminal, complete evidence", () => {
  assert.deepEqual(canReconcileNegativeResults({ status: "completed", finishedAt, expectedQueries: 7, completedQueries: 6 }), { allowed: false, reason: "SCAN_QUERY_COVERAGE_INSUFFICIENT" });
  assert.deepEqual(canReconcileNegativeResults({ status: "completed", finishedAt, expectedQueries: 7, completedQueries: 7 }), { allowed: true, reason: "COMPLETE_SCAN" });
});

test("review memberships remain visible while reconciled-out memberships do not", () => {
  assert.equal(visibleMembership({ isCurrentMatch: false, matchReasons: ["review", "unknown_price"] }), true);
  assert.equal(visibleMembership({ isCurrentMatch: false, matchReasons: ["reconciled_out"] }), false);
  assert.equal(reconciliationMembershipState(false, ["review"]), "REVIEW");
  assert.equal(reconciliationMembershipState(false, ["reconciled_out"]), "INACTIVE");
});

test("membership audit entries contain only the safe state transition fields", () => {
  const entry = membershipAuditEntry({ filterId: "filter-1", listingId: "listing-1", previousState: "REVIEW", newState: "INACTIVE", reason: "COMPLETE_SCAN_FILTER_MISMATCH", scanRunId: "run-1", timestamp: "2026-09-06T10:00:00.000Z" });
  assert.deepEqual(entry, { filterId: "filter-1", listingId: "listing-1", previousState: "REVIEW", newState: "INACTIVE", reason: "COMPLETE_SCAN_FILTER_MISMATCH", scanRunId: "run-1", timestamp: "2026-09-06T10:00:00.000Z" });
  assert.equal("token" in entry, false);
});
