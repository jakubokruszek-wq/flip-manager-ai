import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase, installCanonicalReconciliationRpc } from "../../facebook-watcher/server/facebook-fake-supabase.ts";
import { fetchExternalPortal } from "../external-source-adapters.ts";
import type { SearchFilter } from "../index.ts";

/**
 * Confirmed Production bug: manual-scan.ts and olx-jobs.ts called
 * persistListing() with only (createMatch, unknownFields) -- never the
 * optional `decision` object -- so persistListing's own fallback
 * (bucket = createMatch ? "MATCHED" : unknownFields.length ? "REVIEW" :
 * "REJECTED") decided the bucket from unknownFields ALONE, blind to
 * whether a real hard-rejection reason (e.g. price over the cap) also
 * applied. A listing that is BOTH over the filter's price-per-sqm cap AND
 * missing ownership data was written as REVIEW instead of REJECTED, and
 * the canonical RPC received empty `reasons` instead of the real
 * "max_price_per_sqm" rejection -- decisionBucket() in decision-model.ts
 * (the real, correct evaluator logic) has always treated a non-empty
 * `reasons` as REJECTED regardless of unknownFields; the gap was entirely
 * in persist-listing.ts's fallback for a caller that omitted `decision`.
 *
 * This drives the real runFinderScanPortion() (manual-scan.ts) end to end:
 * real HTML parsing, persistListing(), the application's canonical RPC call,
 * and getFilterResults(). `installCanonicalReconciliationRpc` is a fake DB
 * implementation that records/applies the RPC contract; this test does not
 * execute PostgreSQL's function body or prove its transaction behavior.
 */

const runId = "20000000-0000-4000-8000-000000000001";
const filter: SearchFilter = {
  id: "20000000-0000-4000-8000-000000000002", name: "Price+ownership regression", sources: ["domy"], city: "Łódź", districts: [],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [],
  // Non-empty on purpose: the domy.pl adapter never extracts ownership at
  // all (confirmed null for every listing), so with this set, every
  // candidate also carries an unknown_ownership field alongside whatever
  // the price-per-sqm check decides.
  ownershipTypes: ["pełna własność"], marketType: null,
  // The fixture card below is 439 000 zł / 53 m² ≈ 8283 zł/m². A cap well
  // under that forces a genuine, real hard price_per_sqm rejection.
  privateOnly: false, maxPricePerSqm: 5_000, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 30, isActive: true,
  lastScannedAt: null, createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
};
let currentFilter = filter;
let db = new FakeFacebookSupabase();
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => db } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => db } });
mock.module("@/features/facebook-watcher/supabase-admin", { namedExports: { createFacebookWatcherAdminClient: () => db } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getSearchFilter: async () => currentFilter } });
mock.module("@/features/flip-finder/server/listing-ai-analysis", { namedExports: { analyzeListingWithAiIfNeeded: async () => undefined } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => undefined, listResaleComps: async () => [] } });

const { runFinderScanPortion } = await import("./manual-scan.ts");
const { getFilterResults } = await import("./filter-results.ts");
const { SOURCES, EXTERNAL_SOURCE_CONFIGS } = await import("./search-source-registry.ts");
const domy = SOURCES.find((source) => source.id === "domy")!;

function initialize() {
  currentFilter = filter;
  db = new FakeFacebookSupabase();
  installCanonicalReconciliationRpc(db);
  db.seed("source_scans", [
    { id: "scan-domy", search_filter_id: filter.id, scan_run_id: runId, source: "domy", status: "pending", started_at: new Date().toISOString(), filter_snapshot: filter, continuation_next_at: null, continuation_lease_until: null, continuation_lease_token: null },
  ]);
}

const card = (id: number) => `<article class="propertyBox"><a class="property_link" href="https://domy.pl/mieszkanie/${id}" title="Dwupokojowe mieszkanie na sprzedaż Łódź">Łódź</a><span class="price">439 000 zł</span><span class="area">53m²</span></article>`;

test("a listing over the price cap with unknown ownership is persisted as REJECTED, not REVIEW, through the real scan -> persistListing -> canonical RPC call -> Finder chain", async () => {
  const originalFetch = domy.fetch;
  const originalHttp = globalThis.fetch;
  initialize();
  globalThis.fetch = async () => new Response(card(201));
  domy.fetch = (criteria, signal, batches) => fetchExternalPortal(EXTERNAL_SOURCE_CONFIGS.find((item) => item.id === "domy")!, criteria, signal, batches);
  try {
    const result = await runFinderScanPortion(runId);
    assert.equal(result.status, "completed");
    assert.equal(db.rows("listings").length, 1);

    const listing = db.rows("listings")[0];
    assert.equal(listing.lifecycle_status, "REJECTED", "a listing over the price cap must be persisted as REJECTED even though ownership is also unknown");
    assert.equal(listing.review_reason, null, "a REJECTED listing must never carry a review_reason");
    assert.deepEqual(listing.missing_fields, [], "a REJECTED listing must never carry missing_fields -- those belong to REVIEW only");

    const rpcCall = db.accessLog().some((access) => access.name === "reconcile_canonical_listing_decision");
    assert.ok(rpcCall, "the canonical RPC must have been called");
    const match = db.rows("listing_filter_matches").find((row) => row.listing_id === listing.id);
    assert.ok(match);
    assert.equal(match.is_current_match, false, "a REJECTED listing must never be is_current_match=true");
    const matchReasons = match.match_reasons as string[];
    assert.ok(!matchReasons.includes("review") && !matchReasons.some((r) => r.startsWith("unknown_")), "REJECTED match_reasons must never carry REVIEW markers");
    assert.ok(matchReasons.includes("max_price_per_sqm"), "the real rejection reason (price) must reach the canonical RPC, not be silently dropped to an empty array");

    const finder = await getFilterResults(filter.id);
    assert.ok(finder);
    assert.equal(finder.results.some((r) => r.id === listing.id), false, "a REJECTED listing must never appear in results");
    assert.equal(finder.reviewResults.some((r) => r.id === listing.id), false, "a REJECTED listing must never appear in reviewResults just because ownership is also unknown");
  } finally { domy.fetch = originalFetch; globalThis.fetch = originalHttp; }
});

test("a second scan (re-scan) of the same over-cap, unknown-ownership listing never flips it to REVIEW", async () => {
  const originalFetch = domy.fetch;
  const originalHttp = globalThis.fetch;
  initialize();
  globalThis.fetch = async () => new Response(card(202));
  domy.fetch = (criteria, signal, batches) => fetchExternalPortal(EXTERNAL_SOURCE_CONFIGS.find((item) => item.id === "domy")!, criteria, signal, batches);
  try {
    await runFinderScanPortion(runId);
    const firstListingId = db.rows("listings")[0].id;
    assert.equal(db.rows("listings")[0].lifecycle_status, "REJECTED");

    // Re-scan: a fresh source_scans row for the same filter/source, same
    // fixture listing (same external id, so persistListing updates the
    // SAME row rather than creating a second one).
    const rescanRunId = "20000000-0000-4000-8000-000000000003";
    db.seed("source_scans", [
      ...db.rows("source_scans"),
      { id: "scan-domy-2", search_filter_id: filter.id, scan_run_id: rescanRunId, source: "domy", status: "pending", started_at: new Date().toISOString(), filter_snapshot: filter, continuation_next_at: null, continuation_lease_until: null, continuation_lease_token: null },
    ]);
    await runFinderScanPortion(rescanRunId);

    assert.equal(db.rows("listings").length, 1, "the re-scan must update the same canonical listing, not create a second one");
    assert.equal(db.rows("listings")[0].id, firstListingId);
    assert.equal(db.rows("listings")[0].lifecycle_status, "REJECTED", "a re-scan must never flip a genuinely over-cap listing to REVIEW just because ownership is still unknown");
  } finally { domy.fetch = originalFetch; globalThis.fetch = originalHttp; }
});

test("confirmed building and ownership survive a later source response that omits both before filter evaluation", async () => {
  const originalFetch = domy.fetch;
  const originalHttp = globalThis.fetch;
  initialize();
  const ownership = "pe\u0142na w\u0142asno\u015b\u0107";
  currentFilter = { ...filter, maxPricePerSqm: null, buildingTypes: ["blok"], ownershipTypes: [ownership] };
  let title = `Mieszkanie w bloku, ${ownership}`;
  globalThis.fetch = async () => new Response(`<article class="propertyBox"><a class="property_link" href="https://domy.pl/mieszkanie/211" title="${title}">Łódź, Widzew</a><span class="price">439 000 z\u0142</span><span class="area">53m\u00b2</span></article>`);
  domy.fetch = (criteria, signal, batches) => fetchExternalPortal(EXTERNAL_SOURCE_CONFIGS.find((item) => item.id === "domy")!, criteria, signal, batches);
  try {
    await runFinderScanPortion(runId);
    const first = db.rows("listings")[0];
    assert.equal(first.building_type, "blok");
    assert.equal(first.ownership, ownership);
    assert.equal(first.lifecycle_status, "ACTIVE");

    const secondRunId = "20000000-0000-4000-8000-000000000004";
    db.seed("source_scans", [...db.rows("source_scans"), { id: "scan-domy-attributes-2", search_filter_id: currentFilter.id, scan_run_id: secondRunId, source: "domy", status: "pending", started_at: new Date().toISOString(), filter_snapshot: currentFilter, continuation_next_at: null, continuation_lease_until: null, continuation_lease_token: null }]);
    title = "Mieszkanie trzypokojowe";
    await runFinderScanPortion(secondRunId);

    assert.equal(db.rows("listings").length, 1, "the same portal id must update its canonical listing");
    assert.equal(db.rows("listings")[0].id, first.id);
    assert.equal(db.rows("listings")[0].building_type, "blok");
    assert.equal(db.rows("listings")[0].ownership, ownership);
    assert.equal(db.rows("listings")[0].lifecycle_status, "ACTIVE", "reused attributes must be included in evaluation before persistence");
    const finder = await getFilterResults(currentFilter.id);
    assert.equal(finder?.results.filter((result) => result.id === first.id).length, 1);
  } finally { domy.fetch = originalFetch; globalThis.fetch = originalHttp; }
});
