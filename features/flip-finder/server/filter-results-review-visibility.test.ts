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
let sessionTableReads: string[] = [];
let adminTableReads: string[] = [];
let adminClientCreations = 0;
let operatorAuthorizationFails = false;
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => ({ from: (table: string) => { sessionTableReads.push(table); return currentDb.from(table); } }) } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { adminClientCreations += 1; return { from: (table: string) => { adminTableReads.push(table); return currentDb.from(table); } }; } } });
const { getFilterResults } = await import("./filter-results.ts");
mock.module("@/features/auth/operator", {
  namedExports: {
    requireOperator: async () => {
      if (operatorAuthorizationFails) throw new Error("operator required");
      return { id: "operator-test", email: "operator@example.test" };
    },
    operatorAuthorizationResponse: () => Response.json({ ok: false }, { status: 401 }),
  },
});
const { GET: getFilterResultsRoute } = await import("../../../app/api/flip-finder/search-filters/[id]/results/route.ts");

function assertNoFacebookScanContact(db: FakeFacebookSupabase) {
  const accesses = db.accessLog();
  assert.ok(!sessionTableReads.includes("facebook_scan_jobs"), "Finder must not read the Facebook scan queue through the session client");
  assert.ok(!adminTableReads.includes("facebook_scan_jobs"), "Finder must not read the Facebook scan queue through the service client");
  assert.ok(!accesses.some((entry) => entry.kind === "table" && entry.name === "facebook_scan_jobs"), "Finder must make no table access to facebook_scan_jobs");
  assert.ok(!accesses.some((entry) => entry.kind === "rpc" && /facebook.*(?:scan|enqueue)|(?:scan|enqueue).*facebook/iu.test(entry.name)), "Finder must not call a Facebook scan enqueue RPC");
}

test("authorized portal-only Finder results use owner-scoped session identity reads without service-role access", async () => {
  const db = freshDb();
  db.seed("search_filters", [{ ...CHORALNA_FILTER_ROW, sources: ["domiporta"] }]);
  db.seed("listings", [listingRow({ id: "portal-only", source: "domiporta", original_url: "https://domiporta.pl/oferta/portal-only", building_type: "blok", ownership: "pełna własność", lifecycle_status: "ACTIVE", review_reason: null, missing_fields: [] })]);
  db.seed("listing_filter_matches", [membershipRow("portal-only", { is_current_match: true, match_reasons: [] })]);
  currentDb = db;
  sessionTableReads = [];
  adminTableReads = [];
  adminClientCreations = 0;

  const response = await getFilterResultsRoute(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/results`), { params: Promise.resolve({ id: FILTER_ID }) });
  assert.equal(response.status, 200);
  assert.equal(adminClientCreations, 0, "a portal-only read never needs service-role credentials");
  assert.ok(sessionTableReads.includes("finder_listing_identity_groups"));
  assert.ok(sessionTableReads.includes("finder_listing_identity_decisions"));
  assert.equal(adminTableReads.length, 0, "the owner-scoped RLS read stays on the session client");
  assert.ok(!sessionTableReads.includes("listing_source_metadata"), "publishable/session client must not read private metadata");
  assert.ok(!adminTableReads.includes("listing_source_metadata"));
  assertNoFacebookScanContact(db);
});

test("authorized Facebook Finder results read private source metadata only through the service client", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow({ id: "facebook-private", lifecycle_status: "ACTIVE", review_reason: null, missing_fields: [] })]);
  db.seed("listing_filter_matches", [membershipRow("facebook-private", { is_current_match: true, match_reasons: [] })]);
  db.seed("listing_source_metadata", [{ id: "metadata-1", listing_id: "facebook-private", source: "facebook", source_post_url: "https://www.facebook.com/groups/test/posts/123", collected_at: "2026-10-07T10:00:00.000Z", metadata: { postId: "123", priceQuality: { status: "VERIFIED" } } }]);
  currentDb = db;
  sessionTableReads = [];
  adminTableReads = [];
  adminClientCreations = 0;

  const response = await getFilterResultsRoute(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/results`), { params: Promise.resolve({ id: FILTER_ID }) });
  assert.equal(response.status, 200);
  assert.equal(adminClientCreations, 1, "only private Facebook metadata requires the service client");
  assert.ok(adminTableReads.includes("listing_source_metadata"), "the privileged server client must perform the batched metadata read");
  assert.ok(!sessionTableReads.includes("listing_source_metadata"), "the user/session client must never access the private metadata table");
  assertNoFacebookScanContact(db);
});

test("pre-migration identity columns and tables leave ordinary Finder results visible and report identity features unavailable", async () => {
  const db = freshDb();
  db.seed("search_filters", [{ ...CHORALNA_FILTER_ROW, sources: ["domiporta"] }]);
  db.seed("listings", [listingRow({ id: "legacy-identity-schema", source: "domiporta", original_url: "https://domiporta.pl/oferta/legacy-identity-schema", lifecycle_status: "ACTIVE", review_reason: null, missing_fields: [] })]);
  db.seed("listing_filter_matches", [membershipRow("legacy-identity-schema", { is_current_match: true, match_reasons: [] })]);
  db.failNext("listings", "select", 'column "identity_evidence" does not exist', 1, "42703");
  db.failNext("listings", "select", 'column "cross_source_identity" does not exist', 1, "42703");
  db.failNext("finder_listing_identity_groups", "select", 'relation "finder_listing_identity_groups" does not exist', 1, "42P01");
  currentDb = db;
  const response = await getFilterResultsRoute(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/results`), { params: Promise.resolve({ id: FILTER_ID }) });
  assert.equal(response.status, 200, "missing optional identity schema must not break ordinary offer reads");
  const payload = await response.json() as { results: Array<{ id: string }>; reviewResults: Array<{ id: string }>; identityFeatures: { automaticEvidenceAvailable: boolean; manualReviewAvailable: boolean } };
  assert.deepEqual([...payload.results, ...payload.reviewResults].map((row) => row.id), ["legacy-identity-schema"]);
  assert.deepEqual(payload.identityFeatures, { automaticEvidenceAvailable: false, manualReviewAvailable: false }, "the API reports precise unavailable feature flags instead of returning empty results or claiming a successful write");
});

test("manual identity read surfaces permission and transport errors instead of disguising them as migration-unavailable", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow({ id: "identity-read-error", source: "domiporta", lifecycle_status: "ACTIVE", review_reason: null, missing_fields: [] })]);
  db.seed("listing_filter_matches", [membershipRow("identity-read-error", { is_current_match: true, match_reasons: [] })]);
  db.failNext("finder_listing_identity_groups", "select", "permission denied for table finder_listing_identity_groups", 1, "42501");
  currentDb = db;
  const response = await getFilterResultsRoute(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/results`), { params: Promise.resolve({ id: FILTER_ID }) });
  assert.equal(response.status, 500, "only an exact missing-table response is downgraded to feature unavailable");
});

test("anonymous Finder results requests stop at operator authorization before any database or private-metadata access", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow({ id: "facebook-anonymous", lifecycle_status: "ACTIVE", review_reason: null, missing_fields: [] })]);
  db.seed("listing_filter_matches", [membershipRow("facebook-anonymous", { is_current_match: true, match_reasons: [] })]);
  currentDb = db;
  sessionTableReads = [];
  adminTableReads = [];
  adminClientCreations = 0;
  operatorAuthorizationFails = true;
  try {
    const response = await getFilterResultsRoute(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/results`), { params: Promise.resolve({ id: FILTER_ID }) });
    assert.equal(response.status, 401);
    assert.equal(adminClientCreations, 0, "an unauthorized request must never initialize the service client");
    assert.deepEqual(sessionTableReads, [], "authorization must run before any session database read");
    assert.deepEqual(adminTableReads, []);
    assert.equal(db.accessLog().length, 0);
  } finally {
    operatorAuthorizationFails = false;
  }
});

test("endpoint E2E: Finder displays Żychlin from the Facebook post text instead of the stale Łódź row", async () => {
  const db = freshDb();
  db.seed("search_filters", [{ ...CHORALNA_FILTER_ROW, city: "Żychlin" }]);
  db.seed("listings", [listingRow({
    id: "listing-zychlin",
    title: "SPRZEDAM: Rozkładowe 3 pokoje w Żychlinie",
    description: "270 000 zł, 58 m2",
    price: 270000,
    area: 58,
    rooms: 3,
    price_per_sqm: 270000 / 58,
    city: "Łódź",
    district: "Bałuty",
    building_type: "blok",
    ownership: CHORALNA_FILTER_ROW.ownership_types[1],
    lifecycle_status: "ACTIVE",
    review_reason: null,
    missing_fields: [],
  })]);
  db.seed("listing_filter_matches", [membershipRow("listing-zychlin", {
    is_current_match: true,
    match_reasons: [],
  })]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.ok(payload);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0]?.id, "listing-zychlin");
  assert.equal(payload.results[0]?.city, "Żychlin");
  assert.equal(payload.results[0]?.district, null);
});


test("endpoint E2E: an official canonical listing survives the real Finder results route", async () => {
  const db = freshDb();
  db.seed("search_filters", [{ ...CHORALNA_FILTER_ROW, sources: ["official_cooperative"] }]);
  db.seed("listings", [listingRow({
    id: "listing-official-dabrowa",
    source: "official_cooperative",
    original_url: "https://smdabrowa.pl/informacje/oferty-przetargi/397-lokal-mieszkalny-na-przetarg",
    title: "Lokal mieszkalny - przetarg",
    price: 222000,
    area: 36.74,
    rooms: 2,
    building_type: "blok",
    ownership: CHORALNA_FILTER_ROW.ownership_types[1],
    address: "ul. Zbaraska 25",
    city: CHORALNA_FILTER_ROW.city,
    lifecycle_status: "ACTIVE",
    review_reason: null,
    missing_fields: [],
  })]);
  db.seed("listing_filter_matches", [membershipRow("listing-official-dabrowa", {
    is_current_match: true,
    match_reasons: [],
  })]);
  currentDb = db;

  const response = await getFilterResultsRoute(
    new Request("http://localhost/api/flip-finder/search-filters/" + FILTER_ID + "/results"),
    { params: Promise.resolve({ id: FILTER_ID }) },
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as { results: Array<{ id: string; source: string }> };
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0]?.id, "listing-official-dabrowa");
  assert.equal(payload.results[0]?.source, "official_cooperative");
});
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

test("same Facebook source URL is one Finder card, while a below-minimum price is absent", async () => {
  const db = freshDb();
  const sourcePostUrl = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/shared-post";
  db.seed("listings", [
    listingRow({ id: "listing-source-new", original_url: sourcePostUrl, price: 439_000, area: 70, price_per_sqm: 439_000 / 70, lifecycle_status: "REVIEW" }),
    listingRow({ id: "listing-source-old", original_url: sourcePostUrl, price: 439_000, area: 70, price_per_sqm: 439_000 / 70, lifecycle_status: "REVIEW" }),
    listingRow({ id: "listing-too-cheap", price: 15_000, area: 70, price_per_sqm: 15_000 / 70, lifecycle_status: "REVIEW" }),
  ]);
  db.seed("listing_filter_matches", [
    membershipRow("listing-source-new", { is_current_match: true, match_reasons: [] }),
    membershipRow("listing-source-old", { is_current_match: true, match_reasons: [] }),
    membershipRow("listing-too-cheap", { is_current_match: true, match_reasons: [] }),
  ]);
  db.seed("listing_source_metadata", [
    { listing_id: "listing-source-new", source: "facebook", source_post_url: sourcePostUrl, collected_at: "2026-09-27T12:00:00Z", metadata: { listingIntent: "SELL_PROPERTY" } },
    { listing_id: "listing-source-old", source: "facebook", source_post_url: sourcePostUrl, collected_at: "2026-09-27T11:00:00Z", metadata: { listingIntent: "SELL_PROPERTY" } },
  ]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.equal(payload?.reviewResults.filter((item) => item.id === "listing-source-new").length, 1);
  assert.equal(payload?.reviewResults.some((item) => item.id === "listing-source-old"), false);
  assert.equal(payload?.reviewResults.some((item) => item.id === "listing-too-cheap"), false);
});

test("read path rejects an existing legacy row whose stored block type conflicts with its own tenement description", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow({
    id: "legacy-tenement-labelled-block",
    title: "Mieszkanie po remoncie w kamienicy z windą",
    description: "Kamienica po rewitalizacji, lokal przy ul. testowej.",
    building_type: "blok",
    ownership: "pełna własność",
    lifecycle_status: "ACTIVE",
    review_reason: null,
    missing_fields: [],
  })]);
  db.seed("listing_filter_matches", [membershipRow("legacy-tenement-labelled-block", { is_current_match: true, match_reasons: [] })]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.ok(payload);
  assert.equal(payload.results.some((result) => result.id === "legacy-tenement-labelled-block"), false);
  assert.equal(payload.reviewResults.some((result) => result.id === "legacy-tenement-labelled-block"), false);
});

test("Finder read path groups only confirmed cross-portal identity, keeps one coherent representative and all concrete links", async () => {
  const db = freshDb();
  const identity = "portal_shared_unit_id:unit-tuwima-71";
  const common = { building_type: "blok", ownership: "pełna własność", lifecycle_status: "ACTIVE", review_reason: null, missing_fields: [], cross_source_identity: identity };
  db.seed("listings", [
    listingRow({ id: "tuwima-gratka", source: "gratka", original_url: "https://gratka.pl/nieruchomosci/tuwima", title: "Mieszkanie · Tuwima", price: 365000, area: 71, rooms: 3, ...common }),
    listingRow({ id: "tuwima-morizon", source: "morizon", original_url: "https://morizon.pl/oferta/tuwima", title: "Mieszkanie · Tuwima", price: 369000, area: 70.8, rooms: 3, ...common }),
    listingRow({ id: "tuwima-nieruchomosci-online", source: "nieruchomosci_online", original_url: "https://lodz.nieruchomosci-online.pl/oferta/tuwima", title: "Mieszkanie · Tuwima", price: 365000, area: 71, rooms: 3, ...common }),
  ]);
  db.seed("listing_filter_matches", [
    membershipRow("tuwima-gratka", { is_current_match: true, match_reasons: [] }),
    membershipRow("tuwima-morizon", { is_current_match: true, match_reasons: [] }),
    membershipRow("tuwima-nieruchomosci-online", { is_current_match: true, match_reasons: [] }),
  ]);
  currentDb = db;
  const payload = await getFilterResults(FILTER_ID);
  assert.ok(payload);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.reviewResults.length, 0);
  const [group] = payload.results;
  assert.equal(group.id, "tuwima-gratka", "representative selection is stable by completeness, then source/id");
  assert.equal(group.price, 365000);
  assert.equal(group.area, 71, "price/area remain from the same canonical row");
  assert.deepEqual(group.linkedListings?.map((item) => item.source).sort(), ["gratka", "morizon", "nieruchomosci_online"]);
  assert.deepEqual(group.linkedListings?.map((item) => item.originalUrl).sort(), ["https://gratka.pl/nieruchomosci/tuwima", "https://lodz.nieruchomosci-online.pl/oferta/tuwima", "https://morizon.pl/oferta/tuwima"]);
});

test("same parameters with no explicit cross-source identity remain separate Finder cards", async () => {
  const db = freshDb();
  db.seed("listings", [
    listingRow({ id: "separate-gratka", source: "gratka", original_url: "https://gratka.pl/nieruchomosci/a", title: "Mieszkanie", price: 299000, area: 65, rooms: 3, building_type: "blok", ownership: "pełna własność", lifecycle_status: "ACTIVE", missing_fields: [], cross_source_identity: null }),
    listingRow({ id: "separate-allegro", source: "allegro_lokalnie", original_url: "https://allegrolokalnie.pl/oferta/b", title: "Mieszkanie", price: 299000, area: 65, rooms: 3, building_type: "blok", ownership: "pełna własność", lifecycle_status: "ACTIVE", missing_fields: [], cross_source_identity: null }),
  ]);
  db.seed("listing_filter_matches", [membershipRow("separate-gratka", { is_current_match: true, match_reasons: [] }), membershipRow("separate-allegro", { is_current_match: true, match_reasons: [] })]);
  currentDb = db;
  const payload = await getFilterResults(FILTER_ID);
  assert.equal(payload?.results.length, 2);
});

test("Facebook content identity collapses route duplicates for one post without hiding a different post", async () => {
  const db = freshDb();
  const matchedFields = { building_type: "blok", ownership: "pełna własność", lifecycle_status: "ACTIVE", missing_fields: [] };
  const duplicateA = listingRow({ id: "listing-280-a", original_url: "https://www.facebook.com/groups/a/posts/100000000000001", content_hash: "same-full-content", price: 280000, area: 59.9, ...matchedFields });
  const duplicateB = listingRow({ id: "listing-280-b", original_url: "https://www.facebook.com/groups/b/posts/100000000000001", content_hash: "same-full-content", price: 280000, area: 59.9, ...matchedFields });
  const differentPost = listingRow({ id: "listing-280-c", original_url: "https://www.facebook.com/groups/d/posts/100000000000002", content_hash: "same-full-content", price: 280000, area: 59.9, ...matchedFields });
  const distinct = listingRow({ id: "listing-550", original_url: "https://www.facebook.com/groups/c/posts/100000000000003", content_hash: "different-full-content", title: "Podobna oferta", price: 280000, area: 59.9, ...matchedFields });
  db.seed("listings", [duplicateA, duplicateB, differentPost, distinct]);
  db.seed("listing_filter_matches", [membershipRow("listing-280-a", { is_current_match: true, match_reasons: [] }), membershipRow("listing-280-b", { is_current_match: true, match_reasons: [] }), membershipRow("listing-280-c", { is_current_match: true, match_reasons: [] }), membershipRow("listing-550", { is_current_match: true, match_reasons: [] })]);
  db.seed("listing_source_metadata", [
    { listing_id: "listing-280-a", source: "facebook", source_post_url: duplicateA.original_url, collected_at: "2026-09-27T12:00:00Z", metadata: { listingIntent: "SELL_PROPERTY" } },
    { listing_id: "listing-280-b", source: "facebook", source_post_url: duplicateB.original_url, collected_at: "2026-09-27T11:00:00Z", metadata: { listingIntent: "SELL_PROPERTY" } },
    { listing_id: "listing-280-c", source: "facebook", source_post_url: differentPost.original_url, collected_at: "2026-09-27T10:30:00Z", metadata: { listingIntent: "SELL_PROPERTY" } },
    { listing_id: "listing-550", source: "facebook", source_post_url: distinct.original_url, collected_at: "2026-09-27T10:00:00Z", metadata: { listingIntent: "SELL_PROPERTY" } },
  ]);
  currentDb = db;
  const payload = await getFilterResults(FILTER_ID);
  assert.equal(payload?.results.length, 3);
  assert.deepEqual(new Set(payload?.results.map((result) => result.id)), new Set(["listing-280-a", "listing-280-c", "listing-550"]));
});

// Duplicate/status-disjointness mission: three write paths (persist-listing.ts's
// deactivateListingFilterMatch, listing-lifecycle/server.ts's
// runListingLifecycleBatch, clear-results.ts's clearFilterResults) update
// is_current_match/lifecycle_status independently, outside the single atomic
// RPC (reconcile_canonical_listing_decision) that normally keeps them in
// lockstep -- so real drift between the two is possible. canonicalConsistencyMismatch
// exists specifically to detect that drift at read time, but had zero test
// coverage: nothing proved it actually fires. This closes that gap.
test("J (consistency-detector regression): a listing whose persisted lifecycle_status has drifted from what the live canonical decision computes is flagged canonicalConsistencyMismatch=true, and still lands in exactly one bucket", async () => {
  const db = freshDb();
  // Complete evidence (building type + ownership present) plus price/area/
  // rooms that satisfy the filter outright -> the live canonical decision is
  // a genuine MATCHED with no missing fields. lifecycle_status is stale at
  // "REVIEW" (as if only is_current_match had been kept current by a non-RPC
  // write path, without also correcting lifecycle_status back to ACTIVE).
  db.seed("listings", [listingRow({ id: "listing-drifted", building_type: "blok", ownership: "pełna własność", price: 300000, area: 45, price_per_sqm: 300000 / 45, missing_fields: [], review_reason: null, lifecycle_status: "REVIEW" })]);
  db.seed("listing_filter_matches", [membershipRow("listing-drifted", { is_current_match: true, match_reasons: [] })]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  assert.ok(payload);
  const inResults = payload.results.find((item) => item.id === "listing-drifted");
  const inReview = payload.reviewResults.some((item) => item.id === "listing-drifted");
  assert.ok(inResults, "the live canonical decision (MATCHED, no missing fields) must still win and place the listing in results");
  assert.equal(inReview, false, "never simultaneously in reviewResults despite the stale lifecycle_status='REVIEW'");
  assert.equal(inResults?.canonicalConsistencyMismatch, true, "the drift between lifecycle_status='REVIEW' and the live MATCHED decision must be flagged, not silently ignored");
});

test("J2 (consistency-detector regression, no false positive): a healthy, non-drifted MATCHED listing is never flagged canonicalConsistencyMismatch", async () => {
  const db = freshDb();
  db.seed("listings", [listingRow({ id: "listing-healthy", building_type: "blok", ownership: "pełna własność", price: 300000, area: 45, price_per_sqm: 300000 / 45, missing_fields: [], review_reason: null, lifecycle_status: "ACTIVE" })]);
  db.seed("listing_filter_matches", [membershipRow("listing-healthy", { is_current_match: true, match_reasons: [] })]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  const result = payload?.results.find((item) => item.id === "listing-healthy");
  assert.ok(result);
  assert.equal(result?.canonicalConsistencyMismatch, false, "a listing whose lifecycle_status already agrees with the live decision must never be flagged");
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

// Section 7 (gallery pipeline) regression: proven live in production that no
// reaper anywhere ever moves a gallery job out of PENDING/RUNNING if no
// extension instance ever claims it — it would otherwise show "Oczekuje na
// pobranie galerii" forever. This exercises effectiveGalleryDisplayState
// through the real getFilterResults() read path, not just the isolated
// pure function.
test("Section 7: a gallery stuck PENDING for far longer than the timeout displays as FAILED with the timeout code, through the real read path", async () => {
  const db = freshDb();
  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago, well over the 10-minute timeout
  db.seed("listings", [
    listingRow({ id: "listing-gallery-stuck", missing_fields: [], review_reason: null, gallery_status: "PENDING", gallery_requested_at: longAgo, gallery_error: null }),
  ]);
  db.seed("listing_filter_matches", [membershipRow("listing-gallery-stuck")]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  const result = payload?.reviewResults.find((item) => item.id === "listing-gallery-stuck");
  assert.ok(result);
  assert.equal(result.galleryStatus, "FAILED");
  assert.equal(result.galleryError, "FACEBOOK_GALLERY_TIMEOUT");
});

test("Section 7: a gallery recently requested and still PENDING is left unchanged, never mistaken for timed out", async () => {
  const db = freshDb();
  const justNow = new Date(Date.now() - 30_000).toISOString();
  db.seed("listings", [
    listingRow({ id: "listing-gallery-fresh", missing_fields: [], review_reason: null, gallery_status: "PENDING", gallery_requested_at: justNow, gallery_error: null }),
  ]);
  db.seed("listing_filter_matches", [membershipRow("listing-gallery-fresh")]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  const result = payload?.reviewResults.find((item) => item.id === "listing-gallery-fresh");
  assert.ok(result);
  assert.equal(result.galleryStatus, "PENDING");
  assert.equal(result.galleryError, undefined);
});

test("Section 7: an already-terminal gallery failure keeps its real diagnostic code, never overwritten by the timeout code", async () => {
  const db = freshDb();
  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.seed("listings", [
    listingRow({ id: "listing-gallery-real-failure", missing_fields: [], review_reason: null, gallery_status: "FAILED", gallery_requested_at: longAgo, gallery_error: "FACEBOOK_GALLERY_ROOT_AMBIGUOUS" }),
  ]);
  db.seed("listing_filter_matches", [membershipRow("listing-gallery-real-failure")]);
  currentDb = db;

  const payload = await getFilterResults(FILTER_ID);
  const result = payload?.reviewResults.find((item) => item.id === "listing-gallery-real-failure");
  assert.ok(result);
  assert.equal(result.galleryStatus, "FAILED");
  assert.equal(result.galleryError, "FACEBOOK_GALLERY_ROOT_AMBIGUOUS");
});
