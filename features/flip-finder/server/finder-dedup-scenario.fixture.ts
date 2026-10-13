/**
 * Shared Finder scenario for the Production duplicates of 13.10.2026
 * (238 000 zł / 37,07 m² and 298 000 zł / 46,55 m²). The rows follow the
 * Supabase schema the Finder reads. Texts are stand-ins: the faithful
 * Production rows are exported READ-ONLY by scripts/finder-dedup-diagnostics.mts.
 */
export const FILTER_ID = "6ebf3a9c-5418-4ae6-a0bf-1989b6603367";
export const NOW = Date.parse("2026-10-13T12:00:00.000Z");
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

export function productionScenarioRows(overrides: Record<string, Record<string, unknown>> = {}): Record<string, Record<string, unknown>[]> {
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
  ].map((row) => ({ ...row, ...overrides[row.id as string] }));
  const memberships = [
    matched("olx-238"), review("otodom-238", "buildingType"), review("gratka-238", "buildingType"), matched("nol-238"),
    matched("olx-298"), review("domy-298", "buildingType"), review("oferty-298", "rooms"), matched("other-238"),
  ];
  return {
    search_filters: [FILTER],
    listings,
    listing_filter_matches: memberships,
    listing_snapshots: listings.map((row) => ({ id: `snapshot-${row.id as string}`, listing_id: row.id, price: row.price, captured_at: "2026-10-12T20:00:00Z", raw_data: { sourcePublishedAt: "2026-10-01T10:00:00Z" } })),
    source_scans: [], resale_comps: [], finder_listing_identity_groups: [], finder_listing_identity_decisions: [], finder_building_type_confirmations: [],
  };
}

// Facts read from Production on 13.10 (lengths only; the texts below are stand-ins of the same length).
export const DOMY_298_SHORT = "Mieszkanie 2 pokoje, Teofilów, 46,55 m2, do odświeżenia.";
export const OFERTY_298_SHORT = "Mieszkanie dwupokojowe 46,55 m2 na Teofilowie, 2 piętro, blok z cegły. Pełna własność......";

export function productionFactsRows(): Record<string, Record<string, unknown>[]> {
  return productionScenarioRows({
    "otodom-238": { description: "", address: null },
    "domy-298": { description: DOMY_298_SHORT },
    "oferty-298": { description: OFERTY_298_SHORT },
  });
}

