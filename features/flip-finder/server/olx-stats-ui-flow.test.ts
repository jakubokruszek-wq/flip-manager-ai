import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "@/features/facebook-watcher/server/facebook-fake-supabase.ts";

/**
 * PR #13 follow-up: completeOlxJob stored result_summary.stats, but the Finder
 * page learns an asynchronous OLX result only from GET /api/flip-finder/scans/
 * :runId (getScanProgress -> scanResponseFromProgress), and neither passed the
 * stats on, so SourceDiagnosticCard never showed them. This drives the whole
 * path on one store: real completeOlxJob -> real getScanProgress -> the
 * client's olxSourceResultsFromProgress -> the card's labelled values.
 */

mock.module("server-only", { defaultExport: {} });
const decisions: Record<string, "MATCHED" | "REVIEW" | "REJECTED"> = {};
mock.module("@/features/flip-finder/filter-evaluation", { namedExports: { evaluateListingAgainstFilter: (listing: { externalListingId: string }) => {
  const bucket = decisions[listing.externalListingId] ?? "REJECTED";
  return { matches: bucket === "MATCHED", bucket, unknownFields: bucket === "REVIEW" ? ["buildingType"] : [], reasons: bucket === "REJECTED" ? ["area_min"] : [] };
} } });
const existing = new Set<string>();
const changed = new Set<string>();
mock.module("@/features/flip-finder/server/persist-listing", { namedExports: { persistListing: async (_db: unknown, _filterId: string, listing: { externalListingId: string }) => ({
  listingId: `listing-${listing.externalListingId}`, listingCreated: !existing.has(listing.externalListingId), matchCreated: false,
  updated: existing.has(listing.externalListingId) && changed.has(listing.externalListingId) ? 1 : 0, priceDrop: changed.has(listing.externalListingId) ? 1 : 0,
}) } });
const searchFilter = {
  id: "4f33711a-0000-4000-8000-0000000000f1", name: "Flip", sources: ["olx"], city: "Łódź", districts: [],
  priceMin: null, priceMax: 300_000, areaMin: 25, areaMax: null, rooms: [2, 3], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: ["blok"], ownershipTypes: [], marketType: null,
  privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
};
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getSearchFilter: async () => searchFilter } });
mock.module("@/features/flip-finder/server/listing-attribute-reuse", { namedExports: { reuseExistingListingAttributes: async (_db: unknown, listings: unknown[]) => listings } });

const RUN = "4f33711a-0000-4000-8000-000000000001";
const FILTER = "4f33711a-0000-4000-8000-0000000000f1";
let db = new FakeFacebookSupabase();
mock.module("@/features/flip-finder/server/olx-worker-admin", { namedExports: { createOlxWorkerAdminClient: () => db } });
mock.module("@/features/facebook-watcher/supabase-admin", { namedExports: { createFacebookWatcherAdminClient: () => db } });

const { completeOlxJob } = await import("./olx-jobs.ts");
const { getScanProgress } = await import("./scan-progress.ts");
const { listingScanStatsGroups, olxSourceResultsFromProgress } = await import("../olx-batch.ts");

function listing(id: string) {
  return { source: "olx", externalListingId: id, price: 238_000, contentHash: `hash-${id}`, title: id, area: 37.07, rooms: 2 };
}

test("a Cloudflare-completed OLX job shows read, unique, duplicates, new, updated, matched, review and rejected in the Finder card", async () => {
  // 52 read: 46 distinct others + 3 ads shown twice (promoted copies).
  const repeated = ["teofilow", "review-1", "kamienica"];
  const others = Array.from({ length: 46 }, (_, index) => `other-${index}`);
  Object.assign(decisions, { teofilow: "MATCHED", "review-1": "REVIEW" });
  for (const id of others.slice(0, 45)) existing.add(id); // 4 new: teofilow, review-1, kamienica, other-45
  for (const id of others.slice(0, 3)) changed.add(id); // 3 updated with a price drop
  const listings = [...repeated, ...repeated, ...others].map(listing);
  assert.equal(listings.length, 52);

  db = new FakeFacebookSupabase()
    .seed("olx_scan_jobs", [{ id: "job-cf", scan_run_id: RUN, status: "running", context_type: "finder", lease_token: "lease-cf", worker_id: "cloudflare-olx-stage2", source_scan_id: "scan-olx", search_filter_id: FILTER, result_summary: null, created_at: "2026-10-13T07:30:00.000Z", started_at: "2026-10-13T20:06:05.000Z" }])
    .seed("source_scans", [{ id: "scan-olx", scan_run_id: RUN, search_filter_id: FILTER, source: "olx", status: "running", started_at: "2026-10-13T07:30:00.000Z" }])
    .seed("search_filters", [{ id: FILTER }]);

  await completeOlxJob({ jobId: "job-cf", leaseToken: "lease-cf", workerId: "cloudflare-olx-stage2", fetched: 52, listings: listings as never, warnings: ["OLX_CLOUD_DUPLICATE_IDS: 3 powtórzonych identyfikatorów ofert."], durationMs: 27_000 });

  const progress = await getScanProgress(RUN);
  assert.equal(progress.olx.status, "completed");
  assert.deepEqual(progress.olx.stats, { read: 52, skippedInvalid: 0, unique: 49, duplicates: 3, created: 4, updated: 3, unchanged: 42, matched: 1, review: 1, rejectedByFilter: 47 });
  assert.ok(progress.olx.warnings?.some((warning) => warning.startsWith("OLX_DUPLICATE_LISTINGS_MERGED: 3")));
  // The API response is JSON: the stats must survive serialization unchanged.
  const wire = JSON.parse(JSON.stringify(progress));

  const [card] = olxSourceResultsFromProgress(wire.olx);
  assert.equal(card.source, "olx");
  assert.equal(card.status, "completed");
  assert.ok(card.stats);
  const shown = Object.fromEntries(listingScanStatsGroups(card.stats).flatMap((group) => group.items));
  assert.deepEqual(shown, { Odczytane: 52, Unikalne: 49, Powtórzenia: 3, "Nowe rekordy": 4, Zaktualizowane: 3, "Bez zmian": 42, Dopasowane: 1, "Do weryfikacji": 1, "Odrzucone przez filtr": 47 });
  assert.equal(card.matched, 1);
  assert.equal(card.rejected, 47);
});

test("progress of a queued OLX job shows it waiting; an older job without stats falls back to the plain counters", async () => {
  assert.deepEqual(olxSourceResultsFromProgress({ status: "queued", raw: 0, normalized: 0, errorMessage: null, stats: null }).map((result) => result.status), ["pending"]);
  assert.deepEqual(olxSourceResultsFromProgress({ status: null, raw: 0, normalized: 0, errorMessage: null }), []);
  const [legacy] = olxSourceResultsFromProgress({ status: "completed", raw: 52, normalized: 52, errorMessage: null, stats: null });
  assert.equal(legacy.stats, undefined);
  assert.equal(legacy.fetched, 52);
});
