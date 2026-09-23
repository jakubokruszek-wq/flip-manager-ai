import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";

/**
 * Real, end-to-end regression coverage for the exact question this mission
 * asks: does getFilterResults() — the actual Flip Finder read path, run for
 * real against a controllable fake database, not a hand-coded boolean —
 * correctly surface a canonical REVIEW listing (the Chóralna production
 * fixture) in reviewResults? Proven here: YES, it already does. The
 * investigation this suite backs found the real defect one layer up, in
 * features/flip-finder/components/filter-results-page.tsx, which never read
 * reviewResults from this same, correct API payload — see that component's
 * own test file for the client-side half of this fix.
 */

const FILTER_ID = "6ebf3a9c-5418-4ae6-a0bf-1989b6603367";
const CHORALNA_FILTER_ROW = {
  id: FILTER_ID,
  name: "Flip",
  sources: ["facebook"],
  city: "Łódź",
  districts: [],
  price_min: null,
  price_max: null,
  area_min: 32,
  area_max: 75,
  rooms: [1, 2, 3, 4],
  floor_min: null,
  floor_max: null,
  exclude_ground_floor: false,
  exclude_top_floor: false,
  building_types: ["blok", "apartamentowiec"],
  ownership_types: ["pełna własność", "spółdzielcze"],
  market_type: null,
  private_only: false,
  max_price_per_sqm: 8000,
  required_keywords: [],
  excluded_keywords: [],
  min_flip_score: null,
  min_estimated_profit: null,
  max_estimated_renovation_cost: null,
  scan_interval_minutes: 20,
  is_active: true,
  last_scanned_at: null,
  created_at: "2026-07-19T12:16:19.371Z",
  updated_at: "2026-09-20T20:29:27.038Z",
};

function listingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "listing-choralna",
    title: "2-pokojowe mieszkanie do remontu na sprzedaż - ul Chóralna, piętro 11",
    price: 295000,
    area: 47,
    rooms: 2,
    floor: "11",
    building_type: null,
    ownership: null,
    description: null,
    price_per_sqm: 295000 / 47,
    address: "Chóralna",
    city: "Łódź",
    district: null,
    images: [],
    original_url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/1597595792058564",
    source: "facebook",
    status: "active",
    first_seen_at: "2026-09-20T14:43:18.766Z",
    last_seen_at: "2026-09-20T20:49:02.785Z",
    lifecycle_status: "REVIEW",
    review_reason: "review, unknown_buildingType, unknown_ownership",
    missing_fields: ["buildingType", "ownership"],
    manual_decision: null,
    manual_decision_reason: null,
    archived_at: null,
    estimated_sale_price: null,
    estimated_profit: null,
    estimated_roi: null,
    flip_score: null,
    gallery_status: "NOT_REQUESTED",
    gallery_job_id: null,
    gallery_requested_at: null,
    gallery_completed_at: null,
    gallery_error: null,
    gallery_total: 0,
    gallery_persisted_count: 0,
    ...overrides,
  };
}

function membershipRow(listingId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listing_id: listingId,
    search_filter_id: FILTER_ID,
    first_matched_at: "2026-09-20T20:30:43.921Z",
    last_matched_at: "2026-09-20T20:49:02.785Z",
    is_current_match: false,
    match_origin: "scan",
    match_reasons: ["review", "unknown_buildingType", "unknown_ownership"],
    ...overrides,
  };
}

function freshDb(): FakeFacebookSupabase {
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [CHORALNA_FILTER_ROW]);
  return db;
}

let currentDb = freshDb();
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => currentDb } });
const { getFilterResults } = await import("./filter-results.ts");

test("A: a Chóralna-like canonical REVIEW listing (missing buildingType/ownership, is_current_match=false, match_reasons contains 'review') is surfaced by the real getFilterResults(), never dropped", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow()]);
  db.seed("listing_filter_matches", [membershipRow("listing-choralna")]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.ok(payload);
  assert.equal(payload.results.length, 0);
  assert.equal(payload.reviewResults.length, 1);
  assert.equal(payload.reviewResults[0].id, "listing-choralna");
  assert.equal(payload.reviewResults[0].decisionBucket, "REVIEW");
  assert.deepEqual(payload.reviewResults[0].missingFields, ["buildingType", "ownership"]);
  assert.equal(payload.counts.review, 1);
  assert.equal(payload.counts.active, 0);
});

test("B: a MATCHED listing (is_current_match=true) is surfaced in results with bucket MATCHED, MATCHED behavior unchanged", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow({ id: "listing-matched", building_type: "blok", ownership: "pełna własność", missing_fields: [], review_reason: null, lifecycle_status: "ACTIVE" })]);
  db.seed("listing_filter_matches", [membershipRow("listing-matched", { is_current_match: true, match_reasons: [] })]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.ok(payload);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].id, "listing-matched");
  assert.equal(payload.results[0].decisionBucket, "MATCHED");
  assert.equal(payload.reviewResults.length, 0);
});

test("C: a REJECTED listing (lifecycle_status=REJECTED, is_current_match=false) is excluded from both results and reviewResults", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow({ id: "listing-rejected", lifecycle_status: "REJECTED", missing_fields: [], review_reason: null })]);
  db.seed("listing_filter_matches", [membershipRow("listing-rejected", { is_current_match: false, match_reasons: [] })]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.ok(payload);
  assert.equal(payload.results.length, 0);
  assert.equal(payload.reviewResults.length, 0, "a REJECTED listing must not appear as an actionable Finder result");
});

test("D: a REVIEW listing preserves its missing-field badges/reasons in the returned payload", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow({ id: "listing-review-2" })]);
  db.seed("listing_filter_matches", [membershipRow("listing-review-2")]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  const result = payload?.reviewResults.find((item) => item.id === "listing-review-2");
  assert.ok(result);
  assert.deepEqual(result.missingFields, ["buildingType", "ownership"]);
  assert.deepEqual(result.unknownFields, ["buildingType", "ownership"]);
  assert.equal(result.reviewReason, "review, unknown_buildingType, unknown_ownership");
});

test("E: the same listing matched under two different filters produces independent, non-duplicated results per filter", async () => {
  const filterBId = "filter-b";
  const db = freshDb();
  db.seed("search_filters", [CHORALNA_FILTER_ROW, { ...CHORALNA_FILTER_ROW, id: filterBId, name: "Second filter" }]);
  db.seed("listings", [listingRow({ id: "listing-shared" })]);
  db.seed("listing_filter_matches", [membershipRow("listing-shared", { search_filter_id: FILTER_ID }), membershipRow("listing-shared", { search_filter_id: filterBId })]);
  currentDb = db;

  const payloadA = await getFilterResults(FILTER_ID);
  const payloadB = await getFilterResults(filterBId);
  assert.equal(payloadA?.reviewResults.filter((item) => item.id === "listing-shared").length, 1);
  assert.equal(payloadB?.reviewResults.filter((item) => item.id === "listing-shared").length, 1);
});

test("F: STALE/ARCHIVED lifecycle listings keep their existing visibility semantics — absent by default, present only in archivedResults when requested", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow({ id: "listing-stale", lifecycle_status: "STALE" })]);
  db.seed("listing_filter_matches", [membershipRow("listing-stale")]);
  currentDb = db;

  const defaultPayload = await getFilterResults(FILTER_ID);
  assert.equal(defaultPayload?.results.length, 0);
  assert.equal(defaultPayload?.reviewResults.length, 0);

  const archivePayload = await getFilterResults(FILTER_ID, true);
  assert.equal(archivePayload?.archivedResults.some((item) => item.id === "listing-stale"), true);
  // Duplicate-listing mission: this fixture's own missing buildingType/
  // ownership makes the live filter decision REVIEW, not just STALE. Proven
  // live in production before this fix: an includeArchived=true call let a
  // listing this same shape into BOTH reviewResults and archivedResults at
  // once (44 real listings, one filter). archivedResults having it is not
  // enough — reviewResults (and results) must never also claim it, or the
  // exact same canonical listing renders twice on screen.
  assert.equal(archivePayload?.reviewResults.some((item) => item.id === "listing-stale"), false, "a STALE-lifecycle listing must never also appear in reviewResults, even when its live filter decision would otherwise be REVIEW");
  assert.equal(archivePayload?.results.some((item) => item.id === "listing-stale"), false, "a STALE-lifecycle listing must never also appear in results (MATCHED)");
});

test("H (duplicate-listing regression): an ARCHIVED-lifecycle listing whose live filter decision is REVIEW appears in exactly one bucket, never both", async () => {
  const db = freshDb();
  // building_type/ownership present and matching, so the live filterDecision
  // is REVIEW purely from missing-field-free evidence being otherwise
  // sufficient to be a real (not review-by-missing-fields) match — using the
  // base fixture's own missing buildingType/ownership, which is exactly the
  // production shape that produced the live overlap.
  db.seed("listings", [listingRow({ id: "listing-archived-review", lifecycle_status: "ARCHIVED" })]);
  db.seed("listing_filter_matches", [membershipRow("listing-archived-review")]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID, true);
  assert.ok(payload);
  const inResults = payload.results.some((item) => item.id === "listing-archived-review");
  const inReview = payload.reviewResults.some((item) => item.id === "listing-archived-review");
  const inArchived = payload.archivedResults.some((item) => item.id === "listing-archived-review");
  assert.equal(inArchived, true, "an ARCHIVED-lifecycle listing must appear in archivedResults");
  assert.equal(inResults, false, "and never simultaneously in results");
  assert.equal(inReview, false, "and never simultaneously in reviewResults — one canonical listing, exactly one bucket");
});

test("I (duplicate-listing regression): a duplicated listing_filter_matches row for the same listing under the same filter never produces two results", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow({ id: "listing-dup-row" })]);
  // Simulates a genuine listing_filter_matches primary-key violation (should
  // be impossible in production — see the pkey on (listing_id,
  // search_filter_id) — but the read path must not blindly trust that and
  // mint two FilterResult objects sharing one id if it ever happened).
  db.seed("listing_filter_matches", [
    membershipRow("listing-dup-row"),
    membershipRow("listing-dup-row", { first_matched_at: "2026-09-19T00:00:00.000Z" }),
  ]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.ok(payload);
  assert.equal(payload.reviewResults.filter((item) => item.id === "listing-dup-row").length, 1, "a duplicated match row must never produce two entries for the same canonical listing");
});

test("G: a manual_decision=REJECTED listing stays excluded regardless of otherwise-matching canonical evidence — existing manual-decision behavior unchanged", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow({ id: "listing-manual-reject", building_type: "blok", ownership: "pełna własność", missing_fields: [], review_reason: null, manual_decision: "REJECTED" })]);
  db.seed("listing_filter_matches", [membershipRow("listing-manual-reject", { is_current_match: true, match_reasons: [] })]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.equal(payload?.results.length, 0);
  assert.equal(payload?.reviewResults.length, 0);
});

// Task 4: price/m² fallback safety, exercised through the real getFilterResults()
// (which internally applies reliablePricePerSqm) rather than a hand-copied
// reimplementation of that private function.
async function pricePerSqmFor(overrides: Record<string, unknown>): Promise<number | null> {
  const db = freshDb();
  db.seed("listings", [listingRow({ id: "listing-price", missing_fields: [], review_reason: null, ...overrides })]);
  db.seed("listing_filter_matches", [membershipRow("listing-price")]);
  currentDb = db;
  const payload = await getFilterResults(FILTER_ID);
  return payload?.reviewResults[0]?.pricePerSqm ?? null;
}

test("Task 4: a valid canonical price_per_sqm is used as-is, even if it disagrees with price/area", async () => {
  assert.equal(await pricePerSqmFor({ price: 295000, area: 47, price_per_sqm: 6300 }), 6300);
});

test("Task 4: a missing/invalid canonical price_per_sqm falls back to price / area", async () => {
  assert.equal(await pricePerSqmFor({ price: 295000, area: 47, price_per_sqm: null }), 295000 / 47);
  assert.equal(await pricePerSqmFor({ price: 295000, area: 47, price_per_sqm: 0 }), 295000 / 47);
});

test("Task 4: a missing price yields a safe null, never a fabricated value", async () => {
  assert.equal(await pricePerSqmFor({ price: null, area: 47, price_per_sqm: null }), null);
});

test("Task 4: a missing area yields a safe null", async () => {
  assert.equal(await pricePerSqmFor({ price: 295000, area: null, price_per_sqm: null }), null);
});

test("Task 4: area=0 yields a safe null (no division by zero)", async () => {
  assert.equal(await pricePerSqmFor({ price: 295000, area: 0, price_per_sqm: null }), null);
});

test("Task 4: an implausible canonical price (e.g. below 20,000) is never trusted, even if present", async () => {
  assert.equal(await pricePerSqmFor({ price: 500, area: 47, price_per_sqm: 6300 }), null);
});
