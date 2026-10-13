import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase, installCanonicalReconciliationRpc } from "../../facebook-watcher/server/facebook-fake-supabase.ts";
import { evaluateCanonicalListingDecision } from "../filter-evaluation.ts";
import type { SearchFilter } from "../index.ts";

/**
 * Finder repair (2026-10-13): visibility of persisted matches, removal of
 * tenements and unverified buildings from the main lists, and a read path
 * that no longer downloads the full membership history. Driven through the
 * real getFilterResults() and the real results route against an in-memory
 * database that reproduces PostgREST's silent 1000-row cap.
 */

const FILTER_ID = "6ebf3a9c-5418-4ae6-a0bf-1989b6603367";
const NOW = Date.parse("2026-10-13T10:00:00.000Z");
const FLIP_FILTER_ROW = {
  id: FILTER_ID, name: "Flip", sources: ["otodom", "olx", "facebook"], city: "Łódź", districts: [],
  price_min: null, price_max: null, area_min: 31, area_max: 75, rooms: [1, 2, 3, 4],
  floor_min: null, floor_max: null, exclude_ground_floor: false, exclude_top_floor: false,
  building_types: ["blok", "apartamentowiec"], ownership_types: [], market_type: null, private_only: false,
  max_price_per_sqm: 6500, required_keywords: [], excluded_keywords: [],
  min_flip_score: null, min_estimated_profit: null, max_estimated_renovation_cost: null,
  scan_interval_minutes: 60, is_active: true, last_scanned_at: null,
  created_at: "2026-07-19T12:16:19.371Z", updated_at: "2026-10-01T00:00:00.000Z",
};

function listing(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, external_listing_id: id, content_hash: id, title: `Mieszkanie ${id}`, price: 269000, area: 47.19, rooms: 2, floor: "2",
    building_type: "blok", ownership: null, description: null, price_per_sqm: null, address: null, city: "Łódź", district: "Śródmieście",
    images: [], original_url: `https://www.olx.pl/d/oferta/${id}.html`, source: "olx", status: "active",
    first_seen_at: "2026-10-02T08:00:00.000Z", last_seen_at: "2026-10-12T20:00:00.000Z", lifecycle_status: "ACTIVE",
    review_reason: null, missing_fields: [], manual_decision: null, manual_decision_reason: null, archived_at: null,
    estimated_sale_price: null, estimated_profit: null, estimated_roi: null, flip_score: null, gallery_status: "NOT_REQUESTED",
    gallery_job_id: null, gallery_requested_at: null, gallery_completed_at: null, gallery_error: null, gallery_total: 0, gallery_persisted_count: 0,
    ...overrides,
  };
}

function membership(listingId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listing_id: listingId, search_filter_id: FILTER_ID, first_matched_at: "2026-10-02T08:00:00.000Z", last_matched_at: "2026-10-12T20:00:00.000Z",
    is_current_match: true, match_origin: "scan", match_reasons: [], ...overrides,
  };
}

const review = (listingId: string, fields: string[]) => membership(listingId, { is_current_match: false, match_reasons: ["review", ...fields.map((field) => `unknown_${field}`)] });
const historical = (listingId: string, reasons: string[] = ["max_price_per_sqm"]) => membership(listingId, { is_current_match: false, match_reasons: reasons, last_matched_at: "2026-08-01T00:00:00.000Z" });

let currentDb = new FakeFacebookSupabase();
let tableReads: string[] = [];
const track = (db: FakeFacebookSupabase) => ({ from: (table: string) => { tableReads.push(table); return db.from(table); }, rpc: db.rpc.bind(db) });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => track(currentDb) } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => track(currentDb) } });
mock.module("@/features/auth/operator", {
  namedExports: {
    requireOperator: async () => ({ id: "operator-test", email: "operator@example.test" }),
    operatorAuthorizationResponse: () => Response.json({ ok: false }, { status: 401 }),
  },
});
const { getFilterResults, resetFinderReadCachesForTests } = await import("./filter-results.ts");
const { GET: resultsRoute } = await import("../../../app/api/flip-finder/search-filters/[id]/results/route.ts");

function freshDb(): FakeFacebookSupabase {
  resetFinderReadCachesForTests();
  tableReads = [];
  return new FakeFacebookSupabase().seed("search_filters", [FLIP_FILTER_ROW]).seed("listing_snapshots", []).seed("source_scans", []).seed("resale_comps", []);
}

/** The 2026-10-13 Production shape of filter "Flip": 4 matches, 87 REVIEW (77 with unknown building type), N historical. */
function productionShape(historicalCount: number): FakeFacebookSupabase {
  const db = freshDb();
  const listings: Record<string, unknown>[] = [];
  const memberships: Record<string, unknown>[] = [];
  const snapshots: Record<string, unknown>[] = [];
  const matches: Array<[string, number, number, string, string]> = [
    ["match-srodmiescie-269", 269000, 47.19, "Śródmieście", "2026-10-01T21:57:40.000Z"],
    ["match-dabrowa-329", 329000, 52, "Dąbrowa", "2026-09-10T14:37:40.000Z"],
    ["match-teofilow-298", 298000, 46.55, "Teofilów", "2026-07-28T11:30:56.000Z"],
    ["match-teofilow-238", 238000, 37.07, "Teofilów", "2026-05-29T19:56:11.000Z"],
  ];
  for (const [id, price, area, district, publishedAt] of matches) {
    listings.push(listing(id, { price, area, district }));
    memberships.push(membership(id));
    snapshots.push({ listing_id: id, price, captured_at: "2026-10-12T20:00:00.000Z", raw_data: { sourcePublishedAt: publishedAt } });
  }
  for (let index = 0; index < 87; index += 1) {
    const id = `review-${String(index).padStart(3, "0")}`;
    const unknownBuilding = index < 77;
    listings.push(listing(id, { building_type: unknownBuilding ? null : "blok", rooms: unknownBuilding ? 2 : null, lifecycle_status: "REVIEW", missing_fields: unknownBuilding ? ["buildingType"] : ["rooms"] }));
    memberships.push(review(id, unknownBuilding ? ["buildingType"] : ["rooms"]));
  }
  for (let index = 0; index < historicalCount; index += 1) {
    const id = `history-${String(index).padStart(6, "0")}`;
    // Historical rows reference listings that still exist (rejected/archived).
    if (index < 123) listings.push(listing(id, { building_type: "kamienica", lifecycle_status: "REJECTED" }));
    memberships.push(historical(id, index < 123 ? ["building_type"] : ["max_price_per_sqm"]));
  }
  return db.seed("listings", listings).seed("listing_filter_matches", memberships).seed("listing_snapshots", snapshots);
}

test("Production shape (3854 memberships): every persisted match is visible exactly once, while only current rows are read", async () => {
  currentDb = productionShape(3854 - 4 - 87);
  const payload = await getFilterResults(FILTER_ID, false, NOW);
  assert.ok(payload);
  assert.deepEqual(new Set(payload.results.map((result) => result.id)), new Set(["match-srodmiescie-269", "match-dabrowa-329", "match-teofilow-298", "match-teofilow-238"]));
  assert.equal(payload.counts.active, 4);
  assert.equal(payload.counts.review, 10, "only REVIEW offers with a confirmed building stay in Do oceny");
  assert.equal(payload.counts.buildingVerification, 77, "unknown building types go to their own queue");
  assert.equal(payload.counts.excluded, 0);
  assert.equal(payload.counts.archived, 3854 - 91, "the archive is counted (HEAD) but not downloaded");
  assert.deepEqual(payload.archivedResults, []);
  const all = [...payload.results, ...payload.reviewResults, ...payload.buildingVerificationResults].map((result) => result.id);
  assert.equal(all.length, new Set(all).size, "no duplicates across sections");
  assert.equal(payload.diagnostics.membershipRowsRead, 91, "3763 historical memberships are never transferred");
  assert.equal(payload.diagnostics.listingRowsRead, 91);
  assert.ok(payload.diagnostics.queryCount <= 12, `query count ${payload.diagnostics.queryCount}`);
  const byId = new Map(payload.results.map((result) => [result.id, result]));
  assert.equal(byId.get("match-teofilow-238")?.isOlderListing, true);
  assert.equal(byId.get("match-srodmiescie-269")?.isOlderListing, false);
  assert.equal(byId.get("match-srodmiescie-269")?.publicationAgeDays, 11);
});

for (const historicalCount of [5_000, 50_000]) {
  test(`with ${historicalCount.toLocaleString("en-US")} historical memberships the active read stays bounded and the response stays small`, async () => {
    currentDb = productionShape(historicalCount);
    const started = performance.now();
    const response = await resultsRoute(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/results`), { params: Promise.resolve({ id: FILTER_ID }) });
    const elapsed = performance.now() - started;
    assert.equal(response.status, 200);
    const body = await response.text();
    const payload = JSON.parse(body) as { results: unknown[]; counts: Record<string, number>; diagnostics: { membershipRowsRead: number; queryCount: number } };
    assert.equal(payload.results.length, 4);
    assert.equal(payload.counts.archived, historicalCount);
    assert.equal(payload.diagnostics.membershipRowsRead, 91, "history size never changes what the active view downloads");
    assert.ok(body.length < 1_000_000, `response ${body.length} bytes`);
    assert.ok(elapsed < 10_000, `read took ${elapsed.toFixed(0)} ms`);
    assert.ok(!tableReads.includes("alerts"));
  });
}

test("the archive is read only on request, one server-side page at a time, and never repeats current offers", async () => {
  currentDb = productionShape(250);
  const active = await getFilterResults(FILTER_ID, false, NOW);
  const activeIds = new Set([...active!.results, ...active!.reviewResults, ...active!.buildingVerificationResults].map((result) => result.id));
  const firstPage = await getFilterResults(FILTER_ID, true, NOW, undefined, { archiveOffset: 0, archiveLimit: 50 });
  assert.equal(firstPage?.archive?.total, 250);
  assert.equal(firstPage?.archive?.hasMore, true);
  assert.equal(firstPage?.diagnostics.membershipRowsRead, 50);
  assert.ok(firstPage!.archivedResults.length <= 50);
  assert.ok(firstPage!.archivedResults.every((result) => !activeIds.has(result.id)));
  const lastPage = await getFilterResults(FILTER_ID, true, NOW, undefined, { archiveOffset: 200, archiveLimit: 50 });
  assert.equal(lastPage?.archive?.hasMore, false);
  const clamped = await getFilterResults(FILTER_ID, true, NOW, undefined, { archiveOffset: 0, archiveLimit: 10_000 });
  assert.equal(clamped?.archive?.limit, 100, "a client cannot request an unbounded archive page");
});

test("a tenement never reaches Dopasowane: structured, textual, or contradicting a stale 'blok' label -- each with a visible reason", async () => {
  const db = freshDb();
  db.seed("listings", [
    listing("structured-tenement", { building_type: "kamienica" }),
    listing("text-tenement", { building_type: null, description: "Mieszkanie w kamienicy z 1910 roku, wysokie sufity." }),
    listing("stale-block-label", { building_type: "blok", title: "Mieszkanie po remoncie w kamienicy" }),
    listing("house", { building_type: "dom wolnostojący" }),
    listing("block-next-to-tenement", { building_type: "blok", description: "Blok obok zabytkowej kamienicy, widok na park." }),
  ]);
  db.seed("listing_filter_matches", ["structured-tenement", "text-tenement", "stale-block-label", "house", "block-next-to-tenement"].map((id) => membership(id)));
  currentDb = db;
  const payload = await getFilterResults(FILTER_ID, false, NOW);
  assert.deepEqual(payload?.results.map((result) => result.id), ["block-next-to-tenement"], "'obok kamienicy' is not evidence about this flat");
  assert.equal(payload?.reviewResults.length, 0);
  assert.equal(payload?.buildingVerificationResults.length, 0);
  const excluded = new Map(payload?.excludedResults.map((entry) => [entry.id, entry]));
  for (const id of ["structured-tenement", "text-tenement", "stale-block-label", "house"]) {
    assert.equal(excluded.get(id)?.code, "filter_rejected", id);
    assert.ok(excluded.get(id)?.label.length, `${id} has a human-readable reason`);
  }
  assert.ok(excluded.get("stale-block-label")?.reasons.includes("building_type_conflict"));
});

test("an unknown building type waits in 'Do weryfikacji budynku' and returns to Dopasowane once the operator confirms a block", async () => {
  const db = freshDb();
  db.seed("listings", [listing("unknown-building", { building_type: null, lifecycle_status: "REVIEW", missing_fields: ["buildingType"] })]);
  db.seed("listing_filter_matches", [review("unknown-building", ["buildingType"])]);
  db.seed("finder_building_type_confirmations", []);
  currentDb = db;
  const before = await getFilterResults(FILTER_ID, false, NOW);
  assert.deepEqual(before?.buildingVerificationResults.map((result) => result.id), ["unknown-building"]);
  assert.equal(before?.results.length, 0);
  assert.equal(before?.identityFeatures.buildingConfirmationAvailable, true);

  db.seed("finder_building_type_confirmations", [{ listing_id: "unknown-building", building_type: "blok", confirmed_by: "operator-test", confirmed_at: "2026-10-13T09:00:00Z" }]);
  const after = await getFilterResults(FILTER_ID, false, NOW);
  assert.deepEqual(after?.results.map((result) => result.id), ["unknown-building"], "historical listing requalified on read, no data deleted");
  assert.equal(after?.results[0].buildingQualification?.reason, "building_type_confirmed_operator");
  assert.equal(after?.buildingVerificationResults.length, 0);

  db.seed("finder_building_type_confirmations", [{ listing_id: "unknown-building", building_type: "kamienica", confirmed_by: "operator-test", confirmed_at: "2026-10-13T09:05:00Z" }]);
  const rejected = await getFilterResults(FILTER_ID, false, NOW);
  assert.equal(rejected?.results.length, 0);
  assert.equal(rejected?.excludedResults[0]?.code, "filter_rejected");
});

test("before the confirmations migration is applied the Finder still works and reports the feature as unavailable", async () => {
  const db = freshDb();
  db.seed("listings", [listing("ok-block")]);
  db.seed("listing_filter_matches", [membership("ok-block")]);
  db.failNext("finder_building_type_confirmations", "select", 'relation "public.finder_building_type_confirmations" does not exist', 1, "42P01");
  currentDb = db;
  const payload = await getFilterResults(FILTER_ID, false, NOW);
  assert.deepEqual(payload?.results.map((result) => result.id), ["ok-block"]);
  assert.equal(payload?.identityFeatures.buildingConfirmationAvailable, false);
});

test("why the 269 000 zł offer was invisible: each Production mechanism now yields a visible card or a visible reason", async () => {
  const db = freshDb();
  const url = "https://www.olx.pl/d/oferta/2-pokojowe-mieszkanie-w-okazyjnej-cenie-lodz.html";
  db.seed("listings", [
    // (a) a refreshed ad: the first known publication is 4 months old, the latest refresh is 01.10.
    listing("refreshed", { original_url: "https://www.olx.pl/d/oferta/refreshed.html" }),
    // (b) the same ad saved twice; the REVIEW copy has a photo and is newer, which used to win deduplication.
    listing("same-ad-matched", { original_url: url, last_seen_at: "2026-10-12T20:00:00.000Z" }),
    listing("same-ad-review", { original_url: url, images: ["https://img.olx/1.jpg"], last_seen_at: "2026-10-13T08:00:00.000Z", rooms: null, lifecycle_status: "REVIEW" }),
    // (c) Śródmieście area text with a structured "blok": previously silently REJECTED as building_type_conflict.
    listing("area-tenements", { original_url: "https://www.olx.pl/d/oferta/area.html", description: "Klimatyczna okolica pełna kamienic, blisko Piotrkowskiej." }),
    // (d) the operator accepted it manually; the read used to re-evaluate it back into REVIEW.
    listing("manually-accepted", { original_url: "https://www.olx.pl/d/oferta/accepted.html", rooms: null, manual_decision: "ACCEPTED" }),
  ]);
  db.seed("listing_filter_matches", [
    membership("refreshed"), membership("same-ad-matched"), review("same-ad-review", ["rooms"]), membership("area-tenements"),
    membership("manually-accepted", { match_reasons: ["manual_accept"] }),
  ]);
  db.seed("listing_snapshots", [
    { listing_id: "refreshed", price: 269000, captured_at: "2026-06-10T10:00:00Z", raw_data: { sourcePublishedAt: "2026-06-09T10:00:00Z" } },
    { listing_id: "refreshed", price: 269000, captured_at: "2026-10-02T10:00:00Z", raw_data: { sourcePublishedAt: "2026-10-01T21:57:40Z" } },
  ]);
  currentDb = db;
  const payload = await getFilterResults(FILTER_ID, false, NOW);
  assert.ok(payload);
  const matched = new Map(payload.results.map((result) => [result.id, result]));
  assert.ok(matched.has("refreshed"), "(a) shown although its first publication is older than 30 days");
  assert.equal(matched.get("refreshed")?.publishedAt, "2026-06-09T10:00:00.000Z");
  assert.equal(matched.get("refreshed")?.latestPublishedAt, "2026-10-01T21:57:40.000Z", "the portal refresh date is shown next to the first publication");
  assert.ok(matched.has("same-ad-matched"), "(b) the MATCHED copy wins deduplication");
  assert.equal(payload.excludedResults.find((entry) => entry.id === "same-ad-review")?.code, "duplicate");
  assert.equal(payload.buildingVerificationResults.find((result) => result.id === "area-tenements")?.buildingQualification?.reason, "building_type_ambiguous_tenement_mention", "(c) waits for the operator with a reason instead of disappearing");
  assert.ok(matched.has("manually-accepted"), "(d) an operator's ACCEPT is honoured on read");
  const placed = [...payload.results, ...payload.reviewResults, ...payload.buildingVerificationResults].map((result) => result.id).concat(payload.excludedResults.map((entry) => entry.id));
  assert.equal(placed.length, 5);
  assert.equal(new Set(placed).size, 5, "every current membership appears exactly once");
});

test("archived, rejected and manually removed listings never appear in the active sections", async () => {
  const db = freshDb();
  db.seed("listings", [
    listing("archived", { lifecycle_status: "ARCHIVED" }),
    listing("removed", { status: "removed" }),
    listing("manual-reject", { manual_decision: "REJECTED" }),
    listing("other-filter-rejected", { lifecycle_status: "REJECTED" }),
  ]);
  db.seed("listing_filter_matches", ["archived", "removed", "manual-reject", "other-filter-rejected"].map((id) => membership(id)));
  currentDb = db;
  const payload = await getFilterResults(FILTER_ID, false, NOW);
  assert.equal(payload?.results.length, 0);
  assert.deepEqual(new Map(payload?.excludedResults.map((entry) => [entry.id, entry.code])), new Map([
    ["archived", "lifecycle_archived"], ["removed", "listing_inactive"], ["manual-reject", "manual_rejected"], ["other-filter-rejected", "lifecycle_rejected"],
  ]));
});

test("a failing database read surfaces the real error from the API instead of an empty Finder", async () => {
  const db = freshDb();
  db.seed("listings", [listing("ok")]).seed("listing_filter_matches", [membership("ok")]);
  db.failNext("listings", "select", "connection terminated unexpectedly", 1, "08006");
  currentDb = db;
  const response = await resultsRoute(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/results`), { params: Promise.resolve({ id: FILTER_ID }) });
  assert.equal(response.status, 500);
  const body = await response.json() as { message: string; detail: string | null; code: string };
  assert.equal(body.code, "FINDER_RESULTS_READ_FAILED");
  assert.equal(body.detail, "Nie udało się pobrać ofert dla filtra.");
});

test("concurrent scans reconciling the same listings while the Finder reads never duplicate, lose or misclassify a listing", async () => {
  const db = freshDb();
  installCanonicalReconciliationRpc(db);
  const ids = Array.from({ length: 30 }, (_, index) => `concurrent-${index}`);
  db.seed("listings", ids.map((id, index) => listing(id, { building_type: index % 3 === 0 ? null : "blok", price: index % 5 === 0 ? 500000 : 269000 })));
  db.seed("listing_filter_matches", []);
  currentDb = db;
  const { reconcileCanonicalListingDecision } = await import("./canonical-reconciliation.ts");
  const filter = { id: FILTER_ID, name: "Flip", sources: ["olx"], city: "Łódź", districts: [], priceMin: null, priceMax: null, areaMin: 31, areaMax: 75, rooms: [1, 2, 3, 4], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: ["blok", "apartamentowiec"], ownershipTypes: [], marketType: null, privateOnly: false, maxPricePerSqm: 6500, requiredKeywords: [], excludedKeywords: [] } as unknown as SearchFilter;
  const scan = async (scanIndex: number) => {
    for (const [index, id] of ids.entries()) {
      const row = db.rows("listings").find((item) => item.id === id)!;
      const decision = evaluateCanonicalListingDecision({ price: row.price as number, area: row.area as number, pricePerSqm: null, rooms: 2, floor: "2", city: "Łódź", district: null, title: row.title as string, description: null, locationText: null, buildingType: row.building_type as string | null }, filter);
      await reconcileCanonicalListingDecision({ supabase: db as never, listingId: id, filterId: FILTER_ID, decision, matchedAt: new Date(NOW + scanIndex * 1000 + index).toISOString() });
      if (index % 7 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const reads: Array<Awaited<ReturnType<typeof getFilterResults>>> = [];
  await Promise.all([scan(1), scan(2), (async () => { for (let i = 0; i < 5; i += 1) { reads.push(await getFilterResults(FILTER_ID, false, NOW)); await new Promise((resolve) => setImmediate(resolve)); } })()]);
  reads.push(await getFilterResults(FILTER_ID, false, NOW));
  for (const read of reads) {
    const placed = [...read!.results, ...read!.reviewResults, ...read!.buildingVerificationResults].map((result) => result.id).concat(read!.excludedResults.map((entry) => entry.id));
    assert.equal(placed.length, new Set(placed).size, "no listing appears twice in any intermediate read");
  }
  const final = reads.at(-1)!;
  assert.equal(db.rows("listing_filter_matches").length, ids.length, "one membership per listing, none lost or duplicated");
  const expectMatched = ids.filter((_, index) => index % 3 !== 0 && index % 5 !== 0);
  const expectVerification = ids.filter((_, index) => index % 3 === 0 && index % 5 !== 0);
  assert.deepEqual(new Set(final.results.map((result) => result.id)), new Set(expectMatched));
  assert.deepEqual(new Set(final.buildingVerificationResults.map((result) => result.id)), new Set(expectVerification));
});

test("a mislabelled tenement copy on another portal never hides the correct block: verification queue, then Dopasowane after the operator confirms", async () => {
  const db = freshDb();
  const identity = "portal_shared_unit_id:unit-269k";
  db.seed("listings", [
    listing("olx-block", { cross_source_identity: identity }),
    listing("otodom-mislabelled", { source: "otodom", original_url: "https://www.otodom.pl/pl/oferta/x", building_type: "kamienica", cross_source_identity: identity }),
  ]);
  db.seed("listing_filter_matches", [membership("olx-block"), membership("otodom-mislabelled")]);
  db.seed("finder_building_type_confirmations", []);
  currentDb = db;
  const before = await getFilterResults(FILTER_ID, false, NOW);
  assert.equal(before?.results.length, 0, "an unresolved tenement claim never reaches Dopasowane");
  assert.deepEqual(before?.buildingVerificationResults.map((result) => result.id), ["olx-block"]);
  assert.equal(before?.buildingVerificationResults[0].buildingQualification?.reason, "building_type_cross_portal_conflict");
  assert.deepEqual(before?.excludedResults.map((entry) => [entry.id, entry.code]), [["otodom-mislabelled", "filter_rejected"]]);

  db.seed("finder_building_type_confirmations", [{ listing_id: "olx-block", building_type: "blok", confirmed_by: "operator-test", confirmed_at: "2026-10-13T09:00:00Z" }]);
  const after = await getFilterResults(FILTER_ID, false, NOW);
  assert.deepEqual(after?.results.map((result) => result.id), ["olx-block"]);
  assert.equal(after?.buildingVerificationResults.length, 0);
});
