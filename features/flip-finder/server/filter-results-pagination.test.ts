import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";

/**
 * Confirmed Production bug: getFilterResults() reads listing_filter_matches
 * with a bare .select().eq(search_filter_id) -- no .range(), no .limit().
 * Supabase/PostgREST silently caps an unranged response at its configured
 * default row limit (confirmed empirically: exactly 1000). Filter "Flip" has
 * 2121 listing_filter_matches rows; whatever source happened to land past
 * row 1000 in Postgres's own return order -- OLX (362 listings, 68 REVIEW)
 * and the official UMŁ catalog among them -- was silently invisible to every
 * Finder read, with no error anywhere to surface the truncation.
 *
 * FakeFacebookSupabase now reproduces that same silent 1000-row cap for any
 * unranged select (see facebook-fake-supabase.ts's DEFAULT_SELECT_ROW_CAP),
 * so this is a real regression test, not a tautology: before the
 * getFilterResults pagination fix, this test fails the same way Production
 * did.
 */

const FILTER_ID = "6ebf3a9c-5418-4ae6-a0bf-1989b6603367";
const FILTER_ROW = {
  id: FILTER_ID, name: "Flip", sources: ["otodom", "olx", "official_uml"], city: "Łódź", districts: [],
  price_min: null, price_max: null, area_min: null, area_max: null, rooms: [],
  floor_min: null, floor_max: null, exclude_ground_floor: false, exclude_top_floor: false,
  building_types: [], ownership_types: [], market_type: null, private_only: false,
  max_price_per_sqm: null, required_keywords: [], excluded_keywords: [],
  min_flip_score: null, min_estimated_profit: null, max_estimated_renovation_cost: null,
  scan_interval_minutes: 60, is_active: true, last_scanned_at: null,
  created_at: "2026-07-19T12:16:19.371Z", updated_at: "2026-09-20T20:29:27.038Z",
};

// sourceDomainMatchesSource (results.ts) validates original_url's hostname
// against each source's real registered domain(s) -- a placeholder
// example.test URL would be flagged as a source conflict and silently
// rejected, hiding the exact rows this regression needs visible.
const SOURCE_DOMAIN: Record<string, string> = { otodom: "otodom.pl", olx: "olx.pl", official_uml: "bip.uml.lodz.pl" };

function listingRow(id: string, source: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: `Oferta ${id}`, price: 400_000, area: 50, rooms: 2, floor: "1",
    building_type: "blok", ownership: "pełna własność", description: null, price_per_sqm: 8_000,
    address: "Łódź", city: "Łódź", district: null, images: [],
    original_url: `https://${SOURCE_DOMAIN[source]}/${source}/${id}`, source, status: "active",
    first_seen_at: "2026-09-20T14:43:18.766Z", last_seen_at: "2026-09-20T20:49:02.785Z",
    lifecycle_status: "ACTIVE", review_reason: null, missing_fields: [], manual_decision: null,
    manual_decision_reason: null, archived_at: null, estimated_sale_price: null, estimated_profit: null,
    estimated_roi: null, flip_score: null, gallery_status: "NOT_REQUESTED", gallery_job_id: null,
    gallery_requested_at: null, gallery_completed_at: null, gallery_error: null, gallery_total: 0,
    gallery_persisted_count: 0,
    ...overrides,
  };
}

function membershipRow(listingId: string): Record<string, unknown> {
  return {
    listing_id: listingId, search_filter_id: FILTER_ID,
    first_matched_at: "2026-09-20T20:30:43.921Z", last_matched_at: "2026-09-20T20:49:02.785Z",
    is_current_match: true, match_origin: "scan", match_reasons: [],
  };
}

let currentDb = new FakeFacebookSupabase().seed("search_filters", [FILTER_ROW]);
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => currentDb } });
const { getFilterResults } = await import("./filter-results.ts");

test("over 1000 listing_filter_matches rows: OLX and the official UMŁ catalog, seeded past row 1000, are still returned — never silently truncated", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [FILTER_ROW]);

  // 1049 filler Otodom rows (indices 0..1048), then OLX and UMŁ last — well
  // past the default 1000-row cap a bare, unranged select would silently
  // apply.
  const fillerCount = 1049;
  const listings = Array.from({ length: fillerCount }, (_, i) => listingRow(`otodom-filler-${i}`, "otodom"));
  listings.push(listingRow("olx-late-row", "olx"));
  listings.push(listingRow("uml-late-row", "official_uml", { original_url: "https://bip.uml.lodz.pl/ogloszenia/lokale-mieszkalne", external_listing_id: "uml-source:unit-late" }));

  db.seed("listings", listings);
  db.seed("listing_filter_matches", listings.map((listing) => membershipRow(listing.id as string)));
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.ok(payload);
  assert.equal(payload.total, fillerCount + 2, "every one of the 1051 matches must be read, not just the first 1000");
  assert.equal(payload.results.length, fillerCount + 2);

  const ids = new Set(payload.results.map((result) => result.id));
  assert.ok(ids.has("olx-late-row"), "OLX, seeded past row 1000, must not be silently dropped");
  assert.ok(ids.has("uml-late-row"), "the official UMŁ listing, seeded past row 1000, must not be silently dropped");
});

test("a filter with fewer than 1000 matches is completely unaffected (no accidental double-counting from the pagination loop)", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [FILTER_ROW]);
  const listings = [listingRow("small-1", "otodom"), listingRow("small-2", "olx")];
  db.seed("listings", listings);
  db.seed("listing_filter_matches", listings.map((listing) => membershipRow(listing.id as string)));
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.equal(payload?.total, 2);
  assert.deepEqual(new Set(payload?.results.map((result) => result.id)), new Set(["small-1", "small-2"]));
});

test("exactly 1000 matches (the old cap's exact boundary) are all returned, none dropped at the edge", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [FILTER_ROW]);
  const listings = Array.from({ length: 1000 }, (_, i) => listingRow(`exact-${i}`, "otodom"));
  db.seed("listings", listings);
  db.seed("listing_filter_matches", listings.map((listing) => membershipRow(listing.id as string)));
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.equal(payload?.total, 1000);
});
