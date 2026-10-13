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
SOURCE_DOMAIN.facebook = "facebook.com";

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
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => currentDb } });
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

test("Finder remains readable before the optional year_built migration is applied", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [FILTER_ROW]);
  const listing = listingRow("legacy-schema-listing", "otodom");
  db.seed("listings", [listing]);
  db.seed("listing_filter_matches", [membershipRow("legacy-schema-listing")]);
  db.failNext("listings", "select", "Could not find the 'year_built' column of 'listings' in the schema cache", 1, "PGRST204");
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.equal(payload?.results.length, 1, "a missing optional column must not hide an otherwise valid listing");
  assert.equal(payload?.results[0]?.id, "legacy-schema-listing");
  assert.equal(payload?.results[0]?.yearBuilt, null, "without the column the UI must honestly report no construction year");
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

test("Finder counts include every active current MATCHED/REVIEW row regardless of publication age; only an invalid portal price is excluded, with its reason", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [{ ...FILTER_ROW, area_min: 30, sources: ["otodom", "olx", "official_uml", "facebook"] }]);
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  const rows = [
    listingRow("fresh-cutoff", "otodom"),
    listingRow("old-matched", "otodom"),
    listingRow("unknown-date", "otodom"),
    listingRow("future-date", "otodom"),
    listingRow("fresh-review", "otodom", { area: null, lifecycle_status: "REVIEW", missing_fields: ["area"] }),
    listingRow("old-review", "otodom", { area: null, lifecycle_status: "REVIEW", missing_fields: ["area"] }),
    listingRow("missing-price-review", "otodom", { price: null, area: null, lifecycle_status: "REVIEW", missing_fields: ["price", "area"] }),
    listingRow("facebook-unknown-price", "facebook", { original_url: "https://www.facebook.com/groups/example/posts/1000000000000001/", price: null, price_per_sqm: null, area: null, lifecycle_status: "REVIEW", missing_fields: ["price", "area"] }),
  ];
  db.seed("listings", rows);
  db.seed("listing_filter_matches", rows.map((row) => row.lifecycle_status === "REVIEW"
    ? { ...membershipRow(row.id as string), is_current_match: false, match_reasons: ["review", "unknown_area"] }
    : membershipRow(row.id as string)));
  const exactCutoff = new Date(now - 30 * 86_400_000).toISOString();
  const tooOld = new Date(now - 30 * 86_400_000 - 1).toISOString();
  db.seed("listing_snapshots", [
    { listing_id: "fresh-cutoff", price: 400000, captured_at: "2026-10-07T11:00:00Z", raw_data: { sourcePublishedAt: exactCutoff } },
    { listing_id: "old-matched", price: 400000, captured_at: "2026-10-07T11:00:00Z", raw_data: { sourcePublishedAt: tooOld } },
    { listing_id: "unknown-date", price: 400000, captured_at: "2026-10-07T11:00:00Z", raw_data: { createdAt: "2026-10-07T11:00:00Z" } },
    { listing_id: "future-date", price: 400000, captured_at: "2026-10-07T11:00:00Z", raw_data: { sourcePublishedAt: new Date(now + 60_000).toISOString() } },
    { listing_id: "fresh-review", price: 400000, captured_at: "2026-10-07T11:00:00Z", raw_data: { sourcePublishedAt: "2026-10-06T11:00:00Z" } },
    { listing_id: "old-review", price: 400000, captured_at: "2026-10-07T11:00:00Z", raw_data: { sourcePublishedAt: tooOld } },
    { listing_id: "missing-price-review", price: null, captured_at: "2026-10-07T11:00:00Z", raw_data: { sourcePublishedAt: "2026-10-06T11:00:00Z" } },
  ]);
  db.seed("listing_source_metadata", [{ id: "fb-meta-1", listing_id: "facebook-unknown-price", source: "facebook", source_post_url: "https://www.facebook.com/groups/example/posts/1000000000000001/", published_at: null, collected_at: "2026-10-07T11:00:00Z", metadata: { postId: "1000000000000001" } }]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID, false, now);
  assert.ok(payload);
  assert.deepEqual(new Set(payload.results.map((result) => result.id)), new Set(["fresh-cutoff", "old-matched", "unknown-date", "future-date"]));
  assert.deepEqual(new Set(payload.reviewResults.map((result) => result.id)), new Set(["fresh-review", "old-review", "facebook-unknown-price"]));
  assert.equal(payload.counts.active, 4);
  assert.equal(payload.counts.review, 2 + 1);
  assert.equal(payload.total, 4);
  assert.equal(payload.newMatches, 0);
  assert.equal(payload.results.find((result) => result.id === "unknown-date")?.publishedAt, null, "created/import timestamps must not be presented as publication dates");
  assert.equal(payload.results.find((result) => result.id === "old-matched")?.isOlderListing, true, "an older listing is flagged, not hidden");
  assert.equal(payload.results.find((result) => result.id === "fresh-cutoff")?.isOlderListing, false);
  assert.deepEqual(payload.excludedResults.map((entry) => [entry.id, entry.code]), [["missing-price-review", "invalid_price"]]);

  const history = await getFilterResults(FILTER_ID, true, now);
  assert.ok(history);
  assert.equal(history.archivedResults.length, 0, "current memberships are never repeated in the archive page");
});

// Confirmed Production read (filter "Flip", 2026-10-11 and again 2026-10-13):
// four real OLX listings, all is_current_match=true, lifecycle ACTIVE, no
// manual decision. The old hard 30-day publication window hid "teofilow"
// (137 days) and "m4-loggia" (33 days) from the operator although they are
// active, current matches. Publication age is now information only.
test("4 active, is_current_match OLX rows (Production 'Flip'): every one is shown exactly once under Dopasowane, older ones are flagged instead of hidden", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [{ ...FILTER_ROW, area_min: 31, area_max: 75, max_price_per_sqm: 6500, rooms: [1, 2, 3, 4], building_types: ["blok", "apartamentowiec"], ownership_types: [] }]);
  const now = Date.parse("2026-10-13T10:00:00.000Z");
  const rows = [
    listingRow("teofilow", "olx", { title: "Najciekawsze Mieszkanie NA Teofilowie", area: 37.07, price: 238000, price_per_sqm: null, district: "Teofilów" }),
    listingRow("okazyjna-cena", "olx", { title: "2 pokojowe mieszkanie w okazyjnej cenie Łódź", area: 47.19, price: 269000, price_per_sqm: null, rooms: 2, district: "Śródmieście" }),
    listingRow("teofilow-2", "olx", { title: "Mieszkanie Teofilów 46,55 m²", area: 46.55, price: 298000, price_per_sqm: null, rooms: 2, district: "Teofilów" }),
    listingRow("m4-loggia", "olx", { title: "M4 z loggią na dąbrowie", area: 52, price: 329000, price_per_sqm: null, rooms: 3, district: "Dąbrowa" }),
  ];
  db.seed("listings", rows);
  db.seed("listing_filter_matches", rows.map((row) => membershipRow(row.id as string)));
  db.seed("listing_snapshots", [
    { listing_id: "teofilow", price: 238000, captured_at: "2026-10-12T18:19:39Z", raw_data: { sourcePublishedAt: "2026-05-29T19:56:11.000Z" } },
    { listing_id: "okazyjna-cena", price: 269000, captured_at: "2026-10-12T13:02:40Z", raw_data: { sourcePublishedAt: "2026-10-01T21:57:40.000Z" } },
    { listing_id: "teofilow-2", price: 298000, captured_at: "2026-10-12T11:54:06Z", raw_data: { sourcePublishedAt: "2026-07-28T11:30:56.000Z" } },
    { listing_id: "m4-loggia", price: 329000, captured_at: "2026-10-12T17:04:32Z", raw_data: { sourcePublishedAt: "2026-09-10T14:37:40.000Z" } },
  ]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID, false, now);
  assert.ok(payload);
  const ids = payload.results.map((result) => result.id);
  assert.deepEqual(new Set(ids), new Set(["teofilow", "okazyjna-cena", "teofilow-2", "m4-loggia"]));
  assert.equal(ids.length, new Set(ids).size, "no duplicates");
  assert.equal(payload.counts.active, 4, "the Dopasowane counter equals the rendered cards");
  assert.equal(payload.reviewResults.length + payload.buildingVerificationResults.length + payload.excludedResults.length, 0);
  const byId = new Map(payload.results.map((result) => [result.id, result]));
  assert.equal(byId.get("teofilow")?.isOlderListing, true);
  assert.equal(byId.get("teofilow")?.publicationAgeDays, 136);
  assert.equal(byId.get("teofilow-2")?.isOlderListing, true);
  assert.equal(byId.get("m4-loggia")?.isOlderListing, true);
  assert.equal(byId.get("okazyjna-cena")?.isOlderListing, false);
  assert.equal(byId.get("okazyjna-cena")?.publishedAt, "2026-10-01T21:57:40.000Z");

  const history = await getFilterResults(FILTER_ID, true, now);
  assert.equal(history?.archivedResults.length, 0, "nothing current is pushed into the archive");
});

test("a filter-cleared membership stays out of both current sections after reload and remains in that filter's history", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [FILTER_ROW]);
  db.seed("listings", [listingRow("cleared-listing", "otodom")]);
  db.seed("listing_filter_matches", [{ ...membershipRow("cleared-listing"), is_current_match: false, match_reasons: ["finder_cleared"], last_matched_at: "2026-10-07T11:00:00Z" }]);
  currentDb = db;

  const current = await getFilterResults(FILTER_ID);
  assert.equal(current?.results.length, 0);
  assert.equal(current?.reviewResults.length, 0);
  assert.deepEqual(current?.counts, { active: 0, review: 0, buildingVerification: 0, excluded: 0, archived: 1 });

  const history = await getFilterResults(FILTER_ID, true);
  assert.equal(history?.results.length, 0);
  assert.equal(history?.reviewResults.length, 0);
  assert.equal(history?.archivedResults.length, 1);
  assert.equal(history?.archivedResults[0]?.id, "cleared-listing");
  assert.equal(history?.archivedResults[0]?.lifecycleStatus, "ARCHIVED", "archive state is only a per-filter read projection");
  assert.equal(db.rows("listings")[0]?.lifecycle_status, "ACTIVE", "the canonical listing must not be globally archived or mutated");
});
