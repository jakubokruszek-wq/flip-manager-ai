import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "./facebook-watcher/server/facebook-fake-supabase.ts";

/**
 * Targeted review, HEAD 1e14ac9: both features/flip-finder/server/
 * filter-results.ts (getFilterResults) and features/facebook-watcher/
 * server.ts (listFacebookWatcher) call the same features/listing-identity.ts
 * dedupeByListingIdentity, with an independently-written but structurally
 * identical pre-sort (prefer a resolvable URL, then images, then most
 * recently observed) -- proven by reading both call sites side by side. This
 * proves it at runtime, against the real functions, for the exact three
 * fixture shapes the mission specifies, and proves Finder and Watcher do not
 * just each independently collapse to one card, but agree on the SAME
 * surviving canonical listing.
 *
 * Never deletes or mutates a database row: both dedupe functions only ever
 * filter which already-persisted rows are surfaced to the UI.
 */

const FILTER_ID = "6ebf3a9c-5418-4ae6-a0bf-1989b6603367";
const FILTER_ROW = {
  id: FILTER_ID, name: "Flip", sources: ["facebook"], city: "Łódź", districts: [],
  price_min: null, price_max: null, area_min: 32, area_max: 75, rooms: [1, 2, 3, 4],
  floor_min: null, floor_max: null, exclude_ground_floor: false, exclude_top_floor: false,
  building_types: [], ownership_types: [], market_type: null, private_only: false,
  max_price_per_sqm: 20_000, required_keywords: [], excluded_keywords: [],
  min_flip_score: null, min_estimated_profit: null, max_estimated_renovation_cost: null,
  scan_interval_minutes: 20, is_active: true, last_scanned_at: null,
  created_at: "2026-07-19T12:16:19.371Z", updated_at: "2026-09-20T20:29:27.038Z",
};

function finderListingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "listing-a", title: "Mieszkanie, Łódź", price: 439_000, area: 70, rooms: 2, floor: "2",
    building_type: "blok", ownership: "pełna własność", description: "Oferta testowa",
    price_per_sqm: 439_000 / 70, address: "Piotrkowska", city: "Łódź", district: null, images: [],
    original_url: "https://www.facebook.com/groups/test/posts/1", source: "facebook", status: "active",
    first_seen_at: "2026-09-27T10:00:00.000Z", last_seen_at: "2026-09-27T10:00:00.000Z",
    lifecycle_status: "ACTIVE", review_reason: null, missing_fields: [], manual_decision: null,
    manual_decision_reason: null, archived_at: null, estimated_sale_price: null, estimated_profit: null,
    estimated_roi: null, flip_score: null, gallery_status: "NOT_REQUESTED", gallery_job_id: null,
    gallery_requested_at: null, gallery_completed_at: null, gallery_error: null, gallery_total: 0,
    gallery_persisted_count: 0,
    ...overrides,
  };
}

function finderMembershipRow(listingId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { listing_id: listingId, search_filter_id: FILTER_ID, first_matched_at: "2026-09-27T10:00:00.000Z", last_matched_at: "2026-09-27T10:00:00.000Z", is_current_match: true, match_origin: "scan", match_reasons: [], ...overrides };
}

function finderDb(filterOverrides: Record<string, unknown> = {}): FakeFacebookSupabase {
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [{ ...FILTER_ROW, ...filterOverrides }]);
  return db;
}

let currentFinderDb = finderDb();
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => currentFinderDb } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => currentFinderDb } });
const { getFilterResults } = await import("./flip-finder/server/filter-results.ts");

type WatcherRow = Record<string, unknown>;
let watcherRows: WatcherRow[] = [];
class WatcherQuery {
  select() { return this; }
  eq() { return this; }
  order() { return this; }
  limit() { return Promise.resolve({ data: watcherRows, error: null }); }
}
mock.module("@/features/facebook-watcher/supabase-admin", { namedExports: { createFacebookWatcherAdminClient: () => ({ from: () => new WatcherQuery() }) } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getActiveSearchFiltersForSource: async () => [] } });
const { listFacebookWatcher } = await import("./facebook-watcher/server.ts");

function watcherListing(id: string, overrides: WatcherRow = {}): WatcherRow {
  return {
    id, external_listing_id: `ext-${id}`, content_hash: null, title: "Mieszkanie, Łódź", price: 439_000,
    price_per_sqm: 439_000 / 70, area: 70, rooms: 2, floor: "2", district: null, city: "Łódź",
    address: "Piotrkowska", description: "Oferta testowa", original_url: `https://www.facebook.com/groups/test/posts/${id}`,
    images: [], status: "active", source: "facebook", flip_score: 50, estimated_profit: null,
    first_seen_at: "2026-09-27T10:00:00.000Z", last_seen_at: "2026-09-27T10:00:00.000Z",
    created_at: "2026-09-27T10:00:00.000Z", building_type: "blok", ownership: "pełna własność",
    lifecycle_status: "ACTIVE", archived_at: null,
    ...overrides,
  };
}

function watcherMetadataRow(listingId: string, sourcePostUrl: string, collectedAt: string, overrides: WatcherRow = {}): WatcherRow {
  return { source_post_url: sourcePostUrl, group_name: "Test", published_at: null, collected_at: collectedAt, metadata: { listingIntent: "SELL_PROPERTY" }, listings: watcherListing(listingId), ...overrides };
}

test("scenario 1: two different listings.id sharing the SAME real Facebook source_post_url render as exactly one card on Finder and on Watcher, and both agree on the same surviving id", async () => {
  const sharedUrl = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/9990001";

  // Finder fixture.
  const finder = finderDb();
  finder.seed("listings", [
    finderListingRow({ id: "listing-a", original_url: sharedUrl, first_seen_at: "2026-09-27T09:00:00.000Z", last_seen_at: "2026-09-27T09:00:00.000Z" }),
    finderListingRow({ id: "listing-b", original_url: sharedUrl, first_seen_at: "2026-09-27T11:00:00.000Z", last_seen_at: "2026-09-27T11:00:00.000Z" }),
  ]);
  finder.seed("listing_filter_matches", [finderMembershipRow("listing-a"), finderMembershipRow("listing-b")]);
  finder.seed("listing_source_metadata", [
    { listing_id: "listing-a", source: "facebook", source_post_url: sharedUrl, collected_at: "2026-09-27T09:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" } },
    { listing_id: "listing-b", source: "facebook", source_post_url: sharedUrl, collected_at: "2026-09-27T11:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" } },
  ]);
  currentFinderDb = finder;
  const finderPayload = await getFilterResults(FILTER_ID);
  assert.equal(finderPayload?.results.length, 1, "Finder must render exactly one card for two listing rows sharing one real source_post_url");

  // Watcher fixture: same shared URL, same two listing ids, same collected_at ordering.
  watcherRows = [
    watcherMetadataRow("listing-a", sharedUrl, "2026-09-27T09:00:00.000Z"),
    watcherMetadataRow("listing-b", sharedUrl, "2026-09-27T11:00:00.000Z"),
  ];
  const watcherResult = await listFacebookWatcher();
  assert.equal(watcherResult.length, 1, "Watcher must render exactly one card for the same two rows");

  assert.equal(finderPayload?.results[0]?.id, watcherResult[0]?.listingId, "Finder and Watcher must agree on the SAME surviving canonical listing, not just the same count");
  assert.equal(finderPayload?.results[0]?.id, "listing-b", "the more recently observed row must win, per both surfaces' own identical preference ordering");
});

test("scenario 2: two genuinely different Facebook source_post_url values render as exactly two separate cards on Finder and on Watcher", async () => {
  const urlOne = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/9990002";
  const urlTwo = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/9990003";

  const finder = finderDb();
  finder.seed("listings", [
    finderListingRow({ id: "listing-c", original_url: urlOne, price: 300_000, price_per_sqm: 300_000 / 70 }),
    finderListingRow({ id: "listing-d", original_url: urlTwo, price: 350_000, price_per_sqm: 350_000 / 70, description: "Zupełnie inna oferta" }),
  ]);
  finder.seed("listing_filter_matches", [finderMembershipRow("listing-c"), finderMembershipRow("listing-d")]);
  finder.seed("listing_source_metadata", [
    { listing_id: "listing-c", source: "facebook", source_post_url: urlOne, collected_at: "2026-09-27T09:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" } },
    { listing_id: "listing-d", source: "facebook", source_post_url: urlTwo, collected_at: "2026-09-27T09:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" } },
  ]);
  currentFinderDb = finder;
  const finderPayload = await getFilterResults(FILTER_ID);
  assert.equal(finderPayload?.results.length, 2, "two genuinely distinct posts must never collapse into one Finder card");
  assert.deepEqual(new Set(finderPayload?.results.map((result) => result.id)), new Set(["listing-c", "listing-d"]));

  watcherRows = [
    watcherMetadataRow("listing-c", urlOne, "2026-09-27T09:00:00.000Z", { listings: watcherListing("listing-c", { price: 300_000, price_per_sqm: 300_000 / 70 }) }),
    watcherMetadataRow("listing-d", urlTwo, "2026-09-27T09:00:00.000Z", { listings: watcherListing("listing-d", { price: 350_000, price_per_sqm: 350_000 / 70, description: "Zupełnie inna oferta" }) }),
  ];
  const watcherResult = await listFacebookWatcher();
  assert.equal(watcherResult.length, 2, "two genuinely distinct posts must never collapse into one Watcher card");
  assert.deepEqual(new Set(watcherResult.map((item) => item.listingId)), new Set(["listing-c", "listing-d"]));
});

test("scenario 3: the same listingId with multiple listing_source_metadata rows renders as exactly one card on Finder and on Watcher", async () => {
  const olderUrl = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/9990004";
  const newerUrl = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/9990004?ref=share";

  const finder = finderDb();
  finder.seed("listings", [finderListingRow({ id: "listing-e", original_url: olderUrl })]);
  finder.seed("listing_filter_matches", [finderMembershipRow("listing-e")]);
  finder.seed("listing_source_metadata", [
    { listing_id: "listing-e", source: "facebook", source_post_url: olderUrl, collected_at: "2026-09-27T09:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" } },
    { listing_id: "listing-e", source: "facebook", source_post_url: newerUrl, collected_at: "2026-09-27T11:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" } },
  ]);
  currentFinderDb = finder;
  const finderPayload = await getFilterResults(FILTER_ID);
  assert.equal(finderPayload?.results.length, 1, "one canonical listing with two metadata rows must never render twice on Finder");
  assert.equal(finderPayload?.results[0]?.id, "listing-e");

  const sharedListing = watcherListing("listing-e");
  watcherRows = [
    { source_post_url: olderUrl, group_name: "Test", published_at: null, collected_at: "2026-09-27T09:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" }, listings: sharedListing },
    { source_post_url: newerUrl, group_name: "Test", published_at: null, collected_at: "2026-09-27T11:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" }, listings: sharedListing },
  ];
  const watcherResult = await listFacebookWatcher();
  assert.equal(watcherResult.length, 1, "one canonical listing with two metadata rows must never render twice on Watcher");
  assert.equal(watcherResult[0]?.listingId, "listing-e");
});

test("UMŁ regression: two confirmed units sharing one catalog page URL render as two Finder cards, while re-importing the same unit stays one card", async () => {
  const catalogUrl = "https://bip.uml.lodz.pl/ogloszenia/lokale-mieszkalne";
  const officialRow = (id: string, externalListingId: string, overrides: Record<string, unknown> = {}) => finderListingRow({
    id,
    source: "official_uml",
    external_listing_id: externalListingId,
    original_url: catalogUrl,
    title: "Lokal mieszkalny — oferta",
    building_type: "blok",
    ownership: "pełna własność",
    lifecycle_status: "ACTIVE",
    review_reason: null,
    missing_fields: [],
    ...overrides,
  });

  const finder = finderDb({ sources: ["official_uml"] });
  finder.seed("listings", [
    officialRow("uml-unit-1", "uml-source:unit-1", { price: 180_000, area: 36, price_per_sqm: 180_000 / 36 }),
    officialRow("uml-unit-2", "uml-source:unit-2", { price: 210_000, area: 42, price_per_sqm: 210_000 / 42 }),
  ]);
  finder.seed("listing_filter_matches", [
    finderMembershipRow("uml-unit-1"),
    finderMembershipRow("uml-unit-2"),
  ]);
  currentFinderDb = finder;

  const payload = await getFilterResults(FILTER_ID);
  assert.equal(payload?.results.length, 2, "two confirmed units sharing one catalog URL must render as two Finder cards, never collapsed into one");
  assert.deepEqual(new Set(payload?.results.map((result) => result.id)), new Set(["uml-unit-1", "uml-unit-2"]));

  // Re-importing the same unit (same externalListingId, a fresh listings row
  // as a real re-scan would produce) must still collapse to exactly one card.
  const reimported = finderDb({ sources: ["official_uml"] });
  reimported.seed("listings", [
    officialRow("uml-unit-1-old", "uml-source:unit-1", { price: 180_000, area: 36, price_per_sqm: 180_000 / 36, last_seen_at: "2026-09-27T09:00:00.000Z" }),
    officialRow("uml-unit-1-new", "uml-source:unit-1", { price: 180_000, area: 36, price_per_sqm: 180_000 / 36, last_seen_at: "2026-09-27T11:00:00.000Z" }),
  ]);
  reimported.seed("listing_filter_matches", [
    finderMembershipRow("uml-unit-1-old"),
    finderMembershipRow("uml-unit-1-new"),
  ]);
  currentFinderDb = reimported;

  const reimportedPayload = await getFilterResults(FILTER_ID);
  assert.equal(reimportedPayload?.results.length, 1, "re-importing the same unit (same externalListingId) must render as one Finder card, not two");
  assert.equal(reimportedPayload?.results[0]?.id, "uml-unit-1-new", "the more recently observed row must win, per the existing preference ordering");
});

test("reported Żychlin cards: one confirmed post is one card, while different confirmed posts with identical 270000/58m²/3-room content stay separate on both surfaces", async () => {
  const title = "SPRZEDAM: Rozkładowe 3 pokoje";
  const description = "Mieszkanie 3 pokoje, 58 m², Żychlin.";
  const sharedFingerprint = "reported-zychlin-270k-58m2";
  const firstPostId = "270000000000058";
  const secondPostId = "270000000000059";
  const thirdPostId = "270000000000060";
  const canonicalUrl = `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/${firstPostId}`;
  const trackedUrl = `${canonicalUrl}/?utm_source=feed&fbclid=tracking`;
  const secondUrl = `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/${secondPostId}`;
  const thirdUrl = `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/${thirdPostId}`;

  const listing = (id: string, sourceUrl: string, externalListingId: string, lastSeenAt: string) => finderListingRow({
    id,
    title,
    description,
    price: 270_000,
    area: 58,
    rooms: 3,
    city: "Żychlin",
    district: null,
    original_url: sourceUrl,
    external_listing_id: externalListingId,
    content_hash: sharedFingerprint,
    first_seen_at: "2026-10-05T10:00:00.000Z",
    last_seen_at: lastSeenAt,
  });
  const metadata = (listingId: string, sourceUrl: string, postId: string, collectedAt: string) => ({
    listing_id: listingId,
    source: "facebook",
    source_post_url: sourceUrl,
    collected_at: collectedAt,
    metadata: { listingIntent: "SELL_PROPERTY", postId },
  });

  const finder = finderDb({ city: "Żychlin" });
  finder.seed("listings", [
    listing("zychlin-duplicate-old", trackedUrl, firstPostId, "2026-10-05T10:01:00.000Z"),
    listing("zychlin-duplicate-new", canonicalUrl, firstPostId, "2026-10-05T10:02:00.000Z"),
    listing("zychlin-second-post", secondUrl, secondPostId, "2026-10-05T10:01:00.000Z"),
    listing("zychlin-third-post", thirdUrl, thirdPostId, "2026-10-05T10:01:00.000Z"),
  ]);
  finder.seed("listing_filter_matches", [
    finderMembershipRow("zychlin-duplicate-old"),
    finderMembershipRow("zychlin-duplicate-new"),
    finderMembershipRow("zychlin-second-post"),
    finderMembershipRow("zychlin-third-post"),
  ]);
  finder.seed("listing_source_metadata", [
    metadata("zychlin-duplicate-old", trackedUrl, firstPostId, "2026-10-05T10:01:00.000Z"),
    metadata("zychlin-duplicate-new", canonicalUrl, firstPostId, "2026-10-05T10:02:00.000Z"),
    metadata("zychlin-second-post", secondUrl, secondPostId, "2026-10-05T10:01:00.000Z"),
    metadata("zychlin-third-post", thirdUrl, thirdPostId, "2026-10-05T10:01:00.000Z"),
  ]);
  currentFinderDb = finder;
  const finderPayload = await getFilterResults(FILTER_ID);
  const finderResults = [...(finderPayload?.results ?? []), ...(finderPayload?.reviewResults ?? [])];
  assert.equal(finderResults.length, 3, "Finder must collapse only the duplicate first post and keep both different confirmed posts");
  assert.deepEqual(new Set(finderResults.map((result) => result.id)), new Set(["zychlin-duplicate-new", "zychlin-second-post", "zychlin-third-post"]));
  assert.ok(finderResults.every((result) => result.locationText?.includes("Żychlin")), "every visible card must show Żychlin, never the stale Łódź fallback");
  assert.equal(finderResults.filter((result) => result.sourcePostUrl === canonicalUrl).length, 1, "the same canonical post URL must produce one Finder card");

  watcherRows = [
    watcherMetadataRow("zychlin-duplicate-old", trackedUrl, "2026-10-05T10:01:00.000Z", { metadata: { listingIntent: "SELL_PROPERTY", postId: firstPostId }, listings: watcherListing("zychlin-duplicate-old", listing("zychlin-duplicate-old", trackedUrl, firstPostId, "2026-10-05T10:01:00.000Z")) }),
    watcherMetadataRow("zychlin-duplicate-new", canonicalUrl, "2026-10-05T10:02:00.000Z", { metadata: { listingIntent: "SELL_PROPERTY", postId: firstPostId }, listings: watcherListing("zychlin-duplicate-new", listing("zychlin-duplicate-new", canonicalUrl, firstPostId, "2026-10-05T10:02:00.000Z")) }),
    watcherMetadataRow("zychlin-second-post", secondUrl, "2026-10-05T10:01:00.000Z", { metadata: { listingIntent: "SELL_PROPERTY", postId: secondPostId }, listings: watcherListing("zychlin-second-post", listing("zychlin-second-post", secondUrl, secondPostId, "2026-10-05T10:01:00.000Z")) }),
    watcherMetadataRow("zychlin-third-post", thirdUrl, "2026-10-05T10:01:00.000Z", { metadata: { listingIntent: "SELL_PROPERTY", postId: thirdPostId }, listings: watcherListing("zychlin-third-post", listing("zychlin-third-post", thirdUrl, thirdPostId, "2026-10-05T10:01:00.000Z")) }),
  ];
  const watcherResult = await listFacebookWatcher();
  assert.equal(watcherResult.length, 3, "Watcher must collapse only the duplicate first post and keep both different confirmed posts");
  assert.deepEqual(new Set(watcherResult.map((item) => item.listingId)), new Set(["zychlin-duplicate-new", "zychlin-second-post", "zychlin-third-post"]));
  assert.equal(watcherResult.filter((item) => item.facebookPostId === firstPostId).length, 1, "one confirmed post ID must produce one Watcher card");
  assert.deepEqual(new Set(watcherResult.map((item) => item.facebookPostId)), new Set([firstPostId, secondPostId, thirdPostId]));
  assert.ok(watcherResult.every((item) => item.city === "Żychlin"), "Watcher cards must retain the canonical Żychlin location");
  assert.equal(watcherResult.find((item) => item.facebookPostId === firstPostId)?.externalListingId, firstPostId, "the surviving duplicate must retain the confirmed external listing ID");
});
