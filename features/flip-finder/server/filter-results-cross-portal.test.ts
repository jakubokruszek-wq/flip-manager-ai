import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";

/**
 * Production 13.10.2026: the same flats were shown as separate cards in
 * Dopasowane and Do oceny (238 000 zł / 37,07 m² on OLX, Otodom, Gratka and
 * Nieruchomości-online; 298 000 zł / 46,55 m² on OLX, Domy.pl, Oferty.net).
 * Driven through the real Finder read path; it never writes to the database.
 */
const FILTER_ID = "6ebf3a9c-5418-4ae6-a0bf-1989b6603367";
const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const FILTER = {
  id: FILTER_ID, name: "Flip", sources: ["olx", "otodom", "gratka", "nieruchomosci_online", "domy", "oferty_net"], city: "Łódź", districts: [],
  price_min: null, price_max: null, area_min: 31, area_max: 75, rooms: [1, 2, 3, 4], floor_min: null, floor_max: null,
  exclude_ground_floor: false, exclude_top_floor: false, building_types: ["blok", "apartamentowiec"], ownership_types: [], market_type: null,
  private_only: false, max_price_per_sqm: 6500, required_keywords: [], excluded_keywords: [], min_flip_score: null, min_estimated_profit: null,
  max_estimated_renovation_cost: null, scan_interval_minutes: 60, is_active: true, last_scanned_at: null,
  created_at: "2026-07-19T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};
const DOMAIN: Record<string, string> = { olx: "www.olx.pl", otodom: "www.otodom.pl", gratka: "gratka.pl", nieruchomosci_online: "lodz.nieruchomosci-online.pl", domy: "domy.pl", oferty_net: "www.oferty.net" };
const AGENCY_238 = "Na sprzedaż przestronne dwupokojowe mieszkanie położone na Teofilowie przy spokojnej ulicy. Mieszkanie znajduje się na 4 piętrze w bloku z windą, składa się z dużego pokoju dziennego z wyjściem na balkon, sypialni, kuchni z oknem oraz łazienki z wanną. Lokal wymaga odświeżenia, idealny pod inwestycję lub na wynajem. W pobliżu przystanki tramwajowe, szkoła, przedszkole oraz liczne sklepy. Niski czynsz administracyjny, spółdzielcze własnościowe prawo do lokalu z księgą wieczystą.";
const AGENCY_298 = "Oferujemy do sprzedaży mieszkanie dwupokojowe o powierzchni 46,55 m2 na osiedlu Teofilów. Mieszkanie usytuowane jest na 2 piętrze czteropiętrowego bloku z cegły. Rozkładowe pokoje, widna kuchnia, łazienka z oknem, piwnica w cenie. Budynek po termomodernizacji, wymienione windy i instalacje. Doskonała komunikacja z centrum miasta, w okolicy park, szkoły i markety. Pełna własność, uregulowany stan prawny, możliwy szybki termin wydania.";

function listing(id: string, source: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id, external_listing_id: id, content_hash: id, title: id, price: 238000, area: 37.07, rooms: 2, floor: null, building_type: "blok",
    ownership: null, description: null, price_per_sqm: null, address: null, city: "Łódź", district: null, images: [`https://${DOMAIN[source]}/img/${id}.jpg`],
    original_url: `https://${DOMAIN[source]}/oferta/${id}`, source, status: "active", first_seen_at: "2026-10-01T08:00:00Z", last_seen_at: "2026-10-12T20:00:00Z",
    lifecycle_status: "ACTIVE", review_reason: null, missing_fields: [], manual_decision: null, manual_decision_reason: null, archived_at: null,
    estimated_sale_price: null, estimated_profit: null, estimated_roi: null, flip_score: null, gallery_status: "NOT_REQUESTED", gallery_job_id: null,
    gallery_requested_at: null, gallery_completed_at: null, gallery_error: null, gallery_total: 0, gallery_persisted_count: 0, ...overrides,
  };
}
const matched = (id: string) => ({ id: `match-${id}`, listing_id: id, search_filter_id: FILTER_ID, first_matched_at: "2026-10-02T00:00:00Z", last_matched_at: "2026-10-12T20:00:00Z", is_current_match: true, match_origin: "scan", match_reasons: [] });
const review = (id: string, field: string) => ({ ...matched(id), is_current_match: false, match_reasons: ["review", `unknown_${field}`] });

function productionDb(): FakeFacebookSupabase {
  const listings = [
    listing("olx-238", "olx", { floor: "4", district: "Bałuty", title: "Najciekawsze Mieszkanie NA Teofilowie", description: AGENCY_238 }),
    listing("otodom-238", "otodom", { floor: "4", address: "ul. Rojna", district: "Teofilów", title: "2 pokoje, 37,07 m², Teofilów", description: AGENCY_238, building_type: null, lifecycle_status: "REVIEW" }),
    listing("gratka-238", "gratka", { district: "Teofilów", title: "Mieszkanie 2-pokojowe Łódź Bałuty Teofilów", description: `Oferta biura. ${AGENCY_238.slice(0, 420)}`, building_type: null, lifecycle_status: "REVIEW" }),
    listing("nol-238", "nieruchomosci_online", { floor: "4", district: "Teofilów", title: "Łódź Teofilów, 2 pokoje, 37,07 m2", description: AGENCY_238, ownership: null, lifecycle_status: "REVIEW" }),
    listing("olx-298", "olx", { price: 298000, area: 46.55, floor: "2", district: "Bałuty", title: "Mieszkanie Teofilów 46,55 m²", description: AGENCY_298 }),
    listing("domy-298", "domy", { price: 298000, area: 46.55, district: "Teofilów", title: "Dwupokojowe mieszkanie, Łódź Teofilów", description: `${AGENCY_298} Zapraszamy.`, building_type: null, lifecycle_status: "REVIEW" }),
    listing("oferty-298", "oferty_net", { price: 298000, area: 46.55, floor: "2", title: "Łódź, Bałuty, Teofilów - mieszkanie 2 pok.", description: AGENCY_298.slice(0, 380), rooms: null, lifecycle_status: "REVIEW" }),
    // A different flat with the same price and area in another district: never merged.
    listing("other-238", "otodom", { floor: "1", address: "ul. Retkińska 40", district: "Retkinia", title: "Mieszkanie Retkinia 2 pokoje", description: "Zupełnie inne mieszkanie na Retkini, parter wysoki, do generalnego remontu, kuchnia w aneksie, bez balkonu, w pobliżu Manufaktury dojazd autobusem, czynsz niski, wolne od zaraz, księga wieczysta założona." }),
  ];
  const memberships = [
    matched("olx-238"), review("otodom-238", "buildingType"), review("gratka-238", "buildingType"), matched("nol-238"),
    matched("olx-298"), review("domy-298", "buildingType"), review("oferty-298", "rooms"), matched("other-238"),
  ];
  return new FakeFacebookSupabase().seed("search_filters", [FILTER]).seed("listings", listings).seed("listing_filter_matches", memberships)
    .seed("listing_snapshots", listings.map((row) => ({ listing_id: row.id, price: row.price, captured_at: "2026-10-12T20:00:00Z", raw_data: { sourcePublishedAt: "2026-10-01T10:00:00Z" } })))
    .seed("source_scans", []).seed("resale_comps", []).seed("finder_listing_identity_groups", []).seed("finder_listing_identity_decisions", []).seed("finder_building_type_confirmations", []);
}

let currentDb = productionDb();
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => currentDb } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => currentDb } });
mock.module("@/features/auth/operator", { namedExports: { requireOperator: async () => ({ id: "operator-test", email: "o@example.test" }), operatorAuthorizationResponse: () => Response.json({}, { status: 401 }) } });
const { getFilterResults, resetFinderReadCachesForTests } = await import("./filter-results.ts");

test("Production duplicates: each flat is one card in Dopasowane with every portal link, and no copy remains in Do oceny", async () => {
  resetFinderReadCachesForTests();
  currentDb = productionDb();
  const before = structuredClone({ listings: currentDb.rows("listings"), memberships: currentDb.rows("listing_filter_matches"), snapshots: currentDb.rows("listing_snapshots") });
  const payload = await getFilterResults(FILTER_ID, false, NOW, "operator-test");
  assert.ok(payload);
  const cards = new Map(payload.results.map((card) => [card.price, card]));
  const card238 = payload.results.find((card) => card.linkedListings?.some((item) => item.id === "olx-238"));
  const card298 = payload.results.find((card) => card.linkedListings?.some((item) => item.id === "olx-298"));
  assert.deepEqual(card238?.linkedListings?.map((item) => item.source).sort(), ["gratka", "nieruchomosci_online", "olx", "otodom"]);
  assert.deepEqual(card298?.linkedListings?.map((item) => item.source).sort(), ["domy", "oferty_net", "olx"], "the Oferty.net copy without a structured room count is linked through its text, exact area and description");
  assert.ok(card238?.linkedListings?.every((item) => item.originalUrl?.startsWith("https://")), "all source links are kept");
  const visibleIds = [...payload.results, ...payload.reviewResults, ...payload.buildingVerificationResults].map((card) => card.id);
  assert.equal(payload.reviewResults.length + payload.buildingVerificationResults.length, 0, "no REVIEW card for a copy of a MATCHED flat");
  assert.equal(new Set(visibleIds).size, visibleIds.length);
  assert.ok(payload.results.some((card) => card.id === "other-238" && (card.linkedListings?.length ?? 1) === 1), "a different flat with the same price and area stays its own card");
  assert.equal(cards.size, 2, "two price points: 238 000 (two different flats) and 298 000");
  assert.equal(payload.results.length, 3);
  assert.equal(payload.counts.active, 3);
  assert.equal(payload.counts.review + payload.counts.buildingVerification, 0);
  assert.deepEqual({ listings: currentDb.rows("listings"), memberships: currentDb.rows("listing_filter_matches"), snapshots: currentDb.rows("listing_snapshots") }, before, "the read never changes listings, decisions or price history");
});

test("an operator's 'do not link' decision splits a confirmed copy back into its own card without touching data", async () => {
  resetFinderReadCachesForTests();
  currentDb = productionDb().seed("finder_listing_identity_decisions", [{ owner_id: "operator-test", search_filter_id: FILTER_ID, listing_a: "domy-298", listing_b: "olx-298", decision: "not_link" }]);
  const payload = await getFilterResults(FILTER_ID, false, NOW, "operator-test");
  const card298 = payload?.results.find((card) => card.linkedListings?.some((item) => item.id === "olx-298"));
  assert.equal(card298?.linkedListings?.some((item) => item.id === "domy-298"), false);
  const all = [...(payload?.results ?? []), ...(payload?.reviewResults ?? []), ...(payload?.buildingVerificationResults ?? [])];
  assert.ok(all.some((card) => card.linkedListings?.some((item) => item.id === "domy-298")), "the split copy is still shown, never lost");
});


test("clearing the results archives every linked portal copy, so a grouped card does not come back split", async () => {
  resetFinderReadCachesForTests();
  currentDb = productionDb();
  const { clearFilterResults } = await import("./clear-results.ts");
  const cleared = await clearFilterResults(FILTER_ID, { source: "olx" }, "operator-test");
  assert.equal(cleared.archivedCount, 7, "both OLX-represented cards with all of their linked copies");
  const after = await getFilterResults(FILTER_ID, false, NOW, "operator-test");
  assert.deepEqual([...(after?.results ?? []), ...(after?.reviewResults ?? []), ...(after?.buildingVerificationResults ?? [])].map((card) => card.id), ["other-238"]);
  assert.equal(currentDb.rows("listings").length, 8, "no listing is deleted");
});
