/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "filter-results-page.tsx"), "utf8");

// The per-filter "Otwórz wyniki" page (features/flip-finder/components/search-filters-page.tsx
// links to it) used to type its API response without reviewResults at all, so a
// canonical REVIEW listing — correctly returned by the real getFilterResults()
// server function, proven in features/flip-finder/server/filter-results-review-visibility.test.ts —
// was silently dropped from this page regardless of backend correctness. This is
// the exact production symptom this mission investigated for the Chóralna fixture.
test("the per-filter results page reads reviewResults from the API response, not just results", () => {
  assert.match(page, /reviewResults:\s*FilterResult\[\]/, "the response type must declare reviewResults");
  assert.match(page, /data\.reviewResults/, "the component must actually read data.reviewResults");
});

test("the per-filter results page renders a DO OCENY section for review-bucket listings", () => {
  assert.match(page, /DO OCENY/);
  assert.match(page, /reviewResults\.length > 0/);
});

test("the per-filter results page's response type guard validates reviewResults is present and is an array", () => {
  const guardStart = page.indexOf("function isResultsResponse");
  assert.ok(guardStart >= 0, "expected an isResultsResponse type guard");
  const guardBody = page.slice(guardStart, guardStart + 800);
  assert.match(guardBody, /"reviewResults" in value/);
  assert.match(guardBody, /Array\.isArray\(value\.reviewResults\)/);
});

test("MATCHED listings still render through the unchanged results section — no redesign of the matched path", () => {
  assert.match(page, /results\.map\(\(result\) => \(\s*<ListingResultCard key=\{result\.id\} result=\{result\} \/>/);
});

// Third Finder/Watcher separation bug, proven via real production read-only
// evidence: data.lastScan is the most recent source_scans row for this
// filter from ANY origin, including the Watcher's own independent scheduler
// -- a failed Watcher facebook scan (e.g. COLLECTOR_UPLOAD_422) rendered
// here under "Ostatni skan" read as if it were Finder's own last action.
// data.filter.lastScannedAt is written exclusively by Finder's own
// runManualOtodomScan and can never carry a Watcher-owned timestamp.
test("the header's last-recalculation metric reads filter.lastScannedAt (Finder-exclusive), never the Watcher-influenced top-level lastScan", () => {
  assert.doesNotMatch(page, /label="Ostatni skan"/, "the old, Watcher-influenced 'Ostatni skan' label must be gone");
  assert.match(page, /label="Ostatnie przeliczenie zapisanych ofert"/, "the header must use the recalculation-specific label");
  assert.match(page, /data\.filter\.lastScannedAt/, "the header must read the Finder-exclusive lastScannedAt field");
  assert.doesNotMatch(page, /formatDateTime\(data\.lastScan\.startedAt\)/, "the header must never format a timestamp from the Watcher-influenced top-level lastScan");
});
