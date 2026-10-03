import assert from "node:assert/strict";
import test from "node:test";

import { toSearchFilterScan as toListScan } from "./search-filters.ts";
import { toSearchFilterScan as toResultsScan } from "./filter-results.ts";
import { STALE_SCAN_MESSAGE } from "./scan-lifecycle.ts";

/**
 * Both listSearchFilters() (the dashboard) and getFilterResults() (a single
 * filter's results page) compute their own "last scan" display from the raw
 * source_scans row, entirely independent of whether the user has ever
 * clicked "Skanuj" in this session or is polling that exact run's progress
 * endpoint. Before this fix, a row abandoned by a killed background
 * invocation stayed "running" in both views forever -- simply loading or
 * refreshing either page could show fabricated, perpetually-"in progress"
 * activity for work that had already died. This is the real end-to-end
 * proof the user's exact screenshot symptom ("Trwa pobieranie i
 * zapisywanie ofert" with stale, unmoving counters) cannot reappear on
 * either page that renders a SearchFilterScan.
 */
const now = Date.parse("2026-10-03T12:00:00.000Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "scan-1",
    scan_run_id: "run-1",
    search_filter_id: "filter-1",
    source: "allegro_lokalnie",
    status: "running",
    started_at: ago(20),
    finished_at: null,
    scanned_count: 300,
    matched_count: 0,
    listings_created: 22,
    new_count: 0,
    listings_updated: 0,
    price_drop_count: 0,
    warnings: [],
    error_message: null,
    filter_snapshot: {},
    ...overrides,
  };
}

for (const [label, toScan] of [["listSearchFilters (dashboard)", toListScan], ["getFilterResults (per-filter page)", toResultsScan]] as const) {
  test(`${label}: a running scan abandoned by a killed worker (no heartbeat, past the timeout) is shown as failed, never as still running`, () => {
    const scan = toScan(row({ status: "running", started_at: ago(20) }), now);
    assert.equal(scan?.status, "failed", "a stale row must never render as 'Trwa pobieranie i zapisywanie ofert'");
    assert.equal(scan?.errorMessage, STALE_SCAN_MESSAGE);
    assert.equal(scan?.errorsCount, 1);
  });

  test(`${label}: a running scan with a recent progress heartbeat is still genuinely alive and is never reclassified`, () => {
    const scan = toScan(row({ status: "running", started_at: ago(45), filter_snapshot: { _scanProgress: { lastProgressAt: ago(1), checked: 300 } } }), now);
    assert.equal(scan?.status, "running", "a scan still actively progressing (recent heartbeat) must keep showing real progress, not be killed just for running long");
    assert.equal(scan?.errorMessage, null);
  });

  test(`${label}: a pending scan that has not yet crossed the timeout is preserved exactly as the database has it`, () => {
    const scan = toScan(row({ status: "pending", started_at: ago(2) }), now);
    assert.equal(scan?.status, "pending");
    assert.equal(scan?.errorMessage, null);
  });

  test(`${label}: a Facebook row is never reclassified here -- the Watcher's own scheduler owns its recovery`, () => {
    const scan = toScan(row({ source: "facebook", status: "running", started_at: ago(999) }), now);
    assert.equal(scan?.status, "running", "Facebook rows belong exclusively to the Watcher's own independent watchdog");
  });

  test(`${label}: an OLX row is never reclassified here -- the OLX lease watchdog owns its recovery`, () => {
    const scan = toScan(row({ source: "olx", status: "running", started_at: ago(999) }), now);
    assert.equal(scan?.status, "running", "OLX rows have their own lease-expiry recovery, independent of this display");
  });

  test(`${label}: a genuinely completed scan is never touched regardless of age`, () => {
    const scan = toScan(row({ status: "completed", started_at: ago(10_000), finished_at: ago(9_999), error_message: null }), now);
    assert.equal(scan?.status, "completed");
    assert.equal(scan?.errorMessage, null);
  });

  test(`${label}: a row that is already failed keeps its own original error message, not the generic timeout text`, () => {
    const scan = toScan(row({ status: "failed", error_message: "SOURCE_TIMEOUT: Allegro Lokalnie przekroczyło limit czasu" }), now);
    assert.equal(scan?.status, "failed");
    assert.equal(scan?.errorMessage, "SOURCE_TIMEOUT: Allegro Lokalnie przekroczyło limit czasu");
  });
}
