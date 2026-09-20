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
