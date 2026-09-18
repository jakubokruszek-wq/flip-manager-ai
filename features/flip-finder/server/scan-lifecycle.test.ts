import assert from "node:assert/strict";
import test from "node:test";

import {
  isStaleScan,
  RECOVERABLE_SCAN_STATUSES,
  selectLatestCompletedScans,
  selectLatestScans,
  staleScanCutoff,
  STALE_SCAN_TIMEOUT_MS,
} from "./scan-lifecycle.ts";

const now = Date.parse("2026-09-19T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

// -----------------------------------------------------------------------------
// Stale scan recovery. The duplicate guard blocks on pending AND running, so
// recovery has to cover both or a stuck row blocks that filter forever.
// -----------------------------------------------------------------------------

test("A. a fresh pending scan is preserved and never reaped", () => {
  assert.equal(isStaleScan({ status: "pending", startedAt: minutesAgo(1) }, now), false);
  assert.equal(isStaleScan({ status: "pending", startedAt: minutesAgo(14) }, now), false);
});

test("B. a stale pending scan is recoverable, closing the permanent 429 deadlock", () => {
  assert.equal(isStaleScan({ status: "pending", startedAt: minutesAgo(16) }, now), true);
  assert.equal(isStaleScan({ status: "pending", startedAt: minutesAgo(60 * 24 * 7) }, now), true);
});

test("C. a fresh running scan is preserved", () => {
  assert.equal(isStaleScan({ status: "running", startedAt: minutesAgo(1) }, now), false);
  assert.equal(isStaleScan({ status: "running", startedAt: minutesAgo(14) }, now), false);
});

test("D. stale running behaviour is unchanged", () => {
  assert.equal(isStaleScan({ status: "running", startedAt: minutesAgo(16) }, now), true);
});

test("E. after stale pending cleanup the duplicate guard no longer blocks a new scan", () => {
  const blocking = [
    { status: "pending", startedAt: minutesAgo(90) },
    { status: "running", startedAt: minutesAgo(90) },
  ];
  const survivors = blocking.filter((scan) => !isStaleScan(scan, now));
  assert.deepEqual(survivors, [], "every stale non-terminal row must be reapable, otherwise the 429 guard stays latched");
});

test("terminal scans are never reaped regardless of age", () => {
  for (const status of ["completed", "failed", "partial"]) {
    assert.equal(isStaleScan({ status, startedAt: minutesAgo(60 * 24) }, now), false);
  }
});

test("a scan whose age cannot be established is never reaped", () => {
  assert.equal(isStaleScan({ status: "pending", startedAt: null }, now), false);
  assert.equal(isStaleScan({ status: "running", startedAt: "not-a-timestamp" }, now), false);
});

test("the recovery cutoff matches the documented timeout and covers both blocking statuses", () => {
  assert.equal(staleScanCutoff(now), new Date(now - STALE_SCAN_TIMEOUT_MS).toISOString());
  assert.deepEqual([...RECOVERABLE_SCAN_STATUSES], ["pending", "running"]);
});

// -----------------------------------------------------------------------------
// Last scan selection. Must not depend on the order rows arrive in, because an
// unordered PostgREST page can truncate anywhere.
// -----------------------------------------------------------------------------

function scan(overrides: { id: string; searchFilterId?: string; status?: string; startedAt: string; finishedAt?: string | null }) {
  return { searchFilterId: "filter-1", status: "completed", finishedAt: overrides.startedAt, ...overrides };
}

test("old rows plus a new row: the newest row wins", () => {
  const rows = [
    scan({ id: "old", startedAt: minutesAgo(600) }),
    scan({ id: "newest", startedAt: minutesAgo(5) }),
    scan({ id: "older", startedAt: minutesAgo(900) }),
  ];
  assert.equal(selectLatestScans(rows).get("filter-1")?.id, "newest");
});

test("a large historical set selects the newest row independently of arrival order", () => {
  const history = Array.from({ length: 1_200 }, (_, index) => scan({ id: `scan-${index}`, startedAt: minutesAgo(1_200 - index) }));
  const expected = selectLatestScans(history).get("filter-1")?.id;
  assert.equal(expected, "scan-1199");

  const reversed = selectLatestScans([...history].reverse()).get("filter-1")?.id;
  const shuffled = selectLatestScans([...history].sort((a, b) => a.id.localeCompare(b.id))).get("filter-1")?.id;
  assert.equal(reversed, expected, "selection must not depend on PostgREST truncation order");
  assert.equal(shuffled, expected, "selection must not depend on PostgREST truncation order");
});

test("an in-flight scan outranks a newer finished scan", () => {
  const rows = [
    scan({ id: "finished", status: "completed", startedAt: minutesAgo(1) }),
    scan({ id: "inflight", status: "pending", startedAt: minutesAgo(30), finishedAt: null }),
  ];
  assert.equal(selectLatestScans(rows).get("filter-1")?.id, "inflight");
  assert.equal(selectLatestScans([...rows].reverse()).get("filter-1")?.id, "inflight");
});

test("each filter keeps its own latest scan", () => {
  const rows = [
    scan({ id: "f1-old", searchFilterId: "filter-1", startedAt: minutesAgo(400) }),
    scan({ id: "f1-new", searchFilterId: "filter-1", startedAt: minutesAgo(3) }),
    scan({ id: "f2-only", searchFilterId: "filter-2", startedAt: minutesAgo(900) }),
  ];
  const latest = selectLatestScans(rows);
  assert.equal(latest.get("filter-1")?.id, "f1-new");
  assert.equal(latest.get("filter-2")?.id, "f2-only");
});

test("latest completed selection ignores unfinished and non-completed scans", () => {
  const rows = [
    scan({ id: "completed-old", status: "completed", startedAt: minutesAgo(500), finishedAt: minutesAgo(499) }),
    scan({ id: "completed-new", status: "completed", startedAt: minutesAgo(50), finishedAt: minutesAgo(49) }),
    scan({ id: "failed-newer", status: "failed", startedAt: minutesAgo(2), finishedAt: minutesAgo(1) }),
    scan({ id: "pending-newest", status: "pending", startedAt: minutesAgo(1), finishedAt: null }),
  ];
  assert.equal(selectLatestCompletedScans(rows).get("filter-1")?.id, "completed-new");
  assert.equal(selectLatestCompletedScans([...rows].reverse()).get("filter-1")?.id, "completed-new");
});
