import assert from "node:assert/strict";
import test from "node:test";

import { FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES, finderScanIntervalMinutes, isFinderScanDue } from "./finder-schedule.ts";

// Pure rules shared by the existing server scheduler, without a browser timer.

test("finderScanIntervalMinutes falls back to the default for anything not a positive integer", () => {
  assert.equal(finderScanIntervalMinutes(5), 5);
  assert.equal(finderScanIntervalMinutes("5"), 5);
  assert.equal(finderScanIntervalMinutes(0), FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES);
  assert.equal(finderScanIntervalMinutes(-1), FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES);
  assert.equal(finderScanIntervalMinutes(1.5), FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES);
  assert.equal(finderScanIntervalMinutes("not-a-number"), FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES);
  assert.equal(finderScanIntervalMinutes(null), FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES);
  assert.equal(finderScanIntervalMinutes(undefined), FINDER_SCHEDULER_DEFAULT_INTERVAL_MINUTES);
});

test("isFinderScanDue respects isActive, a never-scanned filter, and the configured interval", () => {
  const now = Date.parse("2026-10-06T12:00:00.000Z");
  assert.equal(isFinderScanDue({ isActive: false, lastScannedAt: null, scanIntervalMinutes: 5, now }), false, "a paused filter is never due");
  assert.equal(isFinderScanDue({ isActive: true, lastScannedAt: null, scanIntervalMinutes: 5, now }), true, "a never-scanned active filter is immediately due");
  assert.equal(isFinderScanDue({ isActive: true, lastScannedAt: new Date(now - 4 * 60_000).toISOString(), scanIntervalMinutes: 5, now }), false, "4 minutes since the last scan with a 5-minute interval is not yet due");
  assert.equal(isFinderScanDue({ isActive: true, lastScannedAt: new Date(now - 5 * 60_000).toISOString(), scanIntervalMinutes: 5, now }), true, "exactly 5 minutes since the last scan with a 5-minute interval is due");
  assert.equal(isFinderScanDue({ isActive: true, lastScannedAt: "not-a-timestamp", scanIntervalMinutes: 5, now }), true, "an unparseable lastScannedAt is treated the same as never-scanned, never silently never-due");
});
