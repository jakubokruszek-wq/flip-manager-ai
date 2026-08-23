import assert from "node:assert/strict";
import test from "node:test";

import { activeSourcesSummary, latestActiveScansText } from "./source-summary.ts";
import type { SearchFilterScan } from "./search-filter-contract.ts";

function scan(source: SearchFilterScan["source"], startedAt: string): SearchFilterScan {
  return { id: `${source}-${startedAt}`, searchFilterId: "filter", source, status: "completed", startedAt, finishedAt: startedAt, scannedCount: 3, matchedCount: 2, listingsCreated: 0, newCount: 0, listingsUpdated: 0, priceDropCount: 0, warningsCount: 0, errorsCount: 0, errorMessage: null };
}

test("summary clearly lists only active sources", () => {
  assert.equal(activeSourcesSummary(["facebook", "olx"]), "Aktywne źródła: Facebook, OLX");
});

test("latest scan summary excludes historical disabled sources", () => {
  const result = latestActiveScansText([
    scan("otodom", "2026-08-20T10:00:00Z"),
    scan("morizon", "2026-08-20T11:00:00Z"),
    scan("facebook", "2026-08-22T10:00:00Z"),
    scan("olx", "2026-08-22T11:00:00Z"),
  ], ["facebook", "olx"]);

  assert.match(result, /Facebook/);
  assert.match(result, /OLX/);
  assert.doesNotMatch(result, /Otodom|Morizon/);
});
