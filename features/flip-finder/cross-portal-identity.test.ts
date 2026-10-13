import assert from "node:assert/strict";
import test from "node:test";
import { assessCrossPortalPair, floorFromText, parseFloorValue, type CrossPortalListing } from "./cross-portal-identity.ts";
import { groupPropertyResults } from "./property-identity.ts";
import type { ListingSource } from "./index.ts";

/**
 * Production 13.10.2026: the same flats appeared as separate cards in
 * Dopasowane and Do oceny. These fixtures are SYNTHETIC: they model how
 * portals publish one agency offer (different titles, location granularity,
 * truncated descriptions, missing fields, no shared identifier). The real
 * Production rows are replayed by
 * server/filter-results-production-replay.test.ts.
 */

const AGENCY_238 = "Na sprzedaż przestronne dwupokojowe mieszkanie położone na Teofilowie przy spokojnej ulicy. Mieszkanie znajduje się na 4 piętrze w bloku z windą, składa się z dużego pokoju dziennego z wyjściem na balkon, sypialni, kuchni z oknem oraz łazienki z wanną. Lokal wymaga odświeżenia, idealny pod inwestycję lub na wynajem. W pobliżu przystanki tramwajowe, szkoła, przedszkole oraz liczne sklepy. Niski czynsz administracyjny, spółdzielcze własnościowe prawo do lokalu z księgą wieczystą. Zapraszam na prezentację.";
const AGENCY_298 = "Oferujemy do sprzedaży mieszkanie dwupokojowe o powierzchni 46,55 m2 na osiedlu Teofilów. Mieszkanie usytuowane jest na 2 piętrze czteropiętrowego bloku z cegły. Rozkładowe pokoje, widna kuchnia, łazienka z oknem, piwnica w cenie. Budynek po termomodernizacji, wymienione windy i instalacje. Doskonała komunikacja z centrum miasta, w okolicy park, szkoły i markety. Pełna własność, uregulowany stan prawny, możliwy szybki termin wydania.";

type Row = CrossPortalListing & { source: ListingSource; originalUrl: string; title: string; decisionBucket: "MATCHED" | "REVIEW"; crossSourceIdentity: null; unknownFields: string[] };

function row(id: string, source: ListingSource, overrides: Partial<Row>): Row {
  return { id, source, price: null, area: null, rooms: null, floor: null, address: null, district: null, city: "Łódź", title: "", description: null, images: [], originalUrl: `https://example.test/${source}/${id}`, decisionBucket: "MATCHED", crossSourceIdentity: null, unknownFields: [], ...overrides };
}

const case238 = [
  row("a-olx-238", "olx", { price: 238000, area: 37.07, rooms: 2, floor: "4", district: "Bałuty", title: "Najciekawsze Mieszkanie NA Teofilowie", description: `${AGENCY_238}\nOgłoszenie prywatne? Nie, biuro nieruchomości.` }),
  row("b-otodom-238", "otodom", { price: 238000, area: 37.07, rooms: 2, floor: "4", address: "ul. Rojna", district: "Teofilów", title: "2 pokoje, 37,07 m², Teofilów, do odświeżenia", description: AGENCY_238, decisionBucket: "REVIEW", unknownFields: ["buildingType"] }),
  row("c-gratka-238", "gratka", { price: 238000, area: 37.07, rooms: 2, floor: null, district: "Bałuty Teofilów", title: "Mieszkanie 2-pokojowe Łódź Bałuty Teofilów", description: `Oferta biura. ${AGENCY_238.slice(0, 420)}`, decisionBucket: "REVIEW", unknownFields: ["buildingType"] }),
  row("d-nol-238", "nieruchomosci_online", { price: 238000, area: 37.07, rooms: 2, floor: "4", district: "Teofilów", title: "Łódź Teofilów, 2 pokoje, 37,07 m2", description: `${AGENCY_238} Numer ogłoszenia w serwisie: NOL-55821.` }),
];

const case298 = [
  row("a-olx-298", "olx", { price: 298000, area: 46.55, rooms: 2, floor: "2", district: "Bałuty", title: "Mieszkanie Teofilów 46,55 m²", description: AGENCY_298 }),
  row("b-domy-298", "domy", { price: 298000, area: 46.55, rooms: 2, floor: null, district: "Teofilów", title: "Dwupokojowe mieszkanie, Łódź Teofilów", description: `${AGENCY_298} Zapraszamy do kontaktu z naszym biurem.`, decisionBucket: "REVIEW", unknownFields: ["ownership"] }),
  row("c-oferty-298", "oferty_net", { price: 298000, area: 46.55, rooms: 2, floor: "2", district: null, title: "Łódź, Bałuty, Teofilów - mieszkanie 2 pok.", description: AGENCY_298.slice(0, 380), decisionBucket: "REVIEW", unknownFields: ["buildingType"] }),
];

test("Production case 238 000 zł / 37,07 m²: the OLX, Otodom, Gratka and Nieruchomości-online copies form one card with all four links", () => {
  const groups = groupPropertyResults(case238);
  assert.equal(groups.length, 1);
  const [card] = groups;
  assert.equal(card.decisionBucket, "MATCHED", "the MATCHED OLX copy wins; the REVIEW copies never form separate cards");
  assert.ok(["a-olx-238", "d-nol-238"].includes(card.id), "a MATCHED copy represents the card (price and area that satisfy the filter)");
  assert.deepEqual(card.linkedListings.map((item) => item.source).sort(), ["gratka", "nieruchomosci_online", "olx", "otodom"]);
  assert.ok(card.linkedListings.every((item) => item.originalUrl), "every source link is kept");
});

test("Production case 298 000 zł / 46,55 m²: the OLX, Domy.pl and Oferty.net copies form one MATCHED card", () => {
  const groups = groupPropertyResults(case298);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].decisionBucket, "MATCHED");
  assert.deepEqual(groups[0].linkedListings.map((item) => item.source).sort(), ["domy", "oferty_net", "olx"]);
});

test("identical price and area alone never link two listings: at most a manual-verification candidate", () => {
  const left = row("x1", "olx", { price: 238000, area: 37.07, rooms: 2, title: "Mieszkanie Bałuty" });
  const right = row("x2", "otodom", { price: 238000, area: 37.07, rooms: 2, title: "Dwa pokoje Retkinia na sprzedaż" });
  const assessment = assessCrossPortalPair(left, right);
  assert.equal(assessment.kind, "candidate");
  const groups = groupPropertyResults([left, right]);
  assert.equal(groups.length, 2, "two cards");
  assert.equal(groups[0].identityCandidates.length, 1, "the pair is offered for manual verification");
  assert.ok(groups[0].identityCandidates[0].evidence?.includes("identyczny metraż"));
  const priceAreaOnly = assessCrossPortalPair(row("y1", "olx", { price: 238000, area: 37.07 }), row("y2", "gratka", { price: 238000, area: 37.07 }));
  assert.notEqual(priceAreaOnly.kind, "confirmed");
});

test("different flats with the same layout in one building are never merged: floor, apartment number or street contradict", () => {
  const sameTemplate = (id: string, source: ListingSource, floor: string, address: string | null = "ul. Rojna 12") => row(id, source, { price: 238000, area: 37.07, rooms: 2, floor, address, district: "Teofilów", title: "Mieszkanie 2 pokoje Teofilów", description: AGENCY_238.replace("4 piętrze", `${floor} piętrze`) });
  assert.equal(assessCrossPortalPair(sameTemplate("f1", "olx", "1"), sameTemplate("f4", "otodom", "4")).kind, "separate", "same agency template, different floor");
  assert.deepEqual(assessCrossPortalPair(sameTemplate("s1", "olx", "4", "ul. Rojna 12"), sameTemplate("s2", "otodom", "4", "ul. Kaczeńcowa 8")).conflicts, ["street"]);
  assert.ok(assessCrossPortalPair(sameTemplate("b1", "olx", "4", "ul. Rojna 12"), sameTemplate("b2", "otodom", "4", "ul. Rojna 14")).conflicts.includes("building_number"));
  assert.ok(assessCrossPortalPair(sameTemplate("m1", "olx", "4", "ul. Rojna 12/5"), sameTemplate("m2", "otodom", "4", "ul. Rojna 12/9")).conflicts.includes("apartment_number"));
  assert.equal(groupPropertyResults([sameTemplate("f1", "olx", "1"), sameTemplate("f4", "otodom", "4")]).length, 2);
});

test("contradicting core facts keep listings apart even with the same description", () => {
  const base = { price: 238000, area: 37.07, rooms: 2, floor: "4", district: "Teofilów", title: "Mieszkanie Teofilów", description: AGENCY_238 };
  assert.ok(assessCrossPortalPair(row("r1", "olx", base), row("r2", "otodom", { ...base, rooms: 3 })).conflicts.includes("rooms"));
  assert.ok(assessCrossPortalPair(row("a1", "olx", base), row("a2", "otodom", { ...base, area: 39.5 })).conflicts.includes("area"));
  assert.ok(assessCrossPortalPair(row("d1", "olx", base), row("d2", "otodom", { ...base, district: "Widzew", description: AGENCY_238.replace("Teofilowie", "Widzewie") })).conflicts.includes("district"));
  assert.ok(assessCrossPortalPair(row("p1", "olx", base), row("p2", "otodom", { ...base, price: 340000 })).conflicts.includes("price_gap"));
  assert.ok(assessCrossPortalPair(row("c1", "olx", base), row("c2", "otodom", { ...base, city: "Zgierz" })).conflicts.includes("city"));
});

test("two listings on the same portal are never linked automatically, and a four-storey block is not a fourth floor", () => {
  const base = { price: 238000, area: 37.07, rooms: 2, floor: "4", district: "Teofilów", title: "Mieszkanie Teofilów", description: AGENCY_238 };
  assert.notEqual(assessCrossPortalPair(row("o1", "olx", base), row("o2", "olx", base)).kind, "confirmed");
  const blockWords = assessCrossPortalPair(
    row("t1", "olx", { ...base, floor: null, description: "Mieszkanie w 4-piętrowym bloku, parter, ogródek." }),
    row("t2", "otodom", { ...base, floor: "0", description: null }),
  );
  assert.equal(blockWords.conflicts.includes("floor"), false, "'4-piętrowy blok' describes the building, not the flat's floor");
});

test("a manual 'do not link' decision and an explicit identity conflict always win over cross-portal evidence", () => {
  const [left, right] = case298;
  const blocked = groupPropertyResults([left, right], { blockedPairs: new Set([[left.id, right.id].sort().join("|")]) });
  assert.equal(blocked.length, 2);
});

test("a duplicate copy joins a group only when it contradicts no member (no chaining of different flats)", () => {
  const [olx, otodom] = case238;
  const thirdFloor = row("z-other-flat", "gratka", { price: 238000, area: 37.07, rooms: 2, floor: "3", district: "Teofilów", title: "Mieszkanie 2-pokojowe Teofilów", description: AGENCY_238.replace("4 piętrze", "3 piętrze") });
  const groups = groupPropertyResults([olx, otodom, thirdFloor]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((group) => group.linkedListings.length === 2)?.linkedListings.map((item) => item.id).sort(), ["a-olx-238", "b-otodom-238"]);
});

test("a missing structured room count is read from the listing text; without decisive content it never confirms", () => {
  const base = { price: 298000, area: 46.55, floor: "2", district: "Teofilów", title: "Mieszkanie Teofilów", description: AGENCY_298 };
  const withText = assessCrossPortalPair(row("k1", "olx", { ...base, rooms: 2 }), row("k2", "oferty_net", { ...base, rooms: null, title: "Łódź Teofilów - mieszkanie 2 pok." }));
  assert.equal(withText.kind, "confirmed");
  assert.ok(withText.evidence.includes("rooms"));
  const contradicting = assessCrossPortalPair(row("k3", "olx", { ...base, rooms: 2 }), row("k4", "oferty_net", { ...base, rooms: null, title: "Trzypokojowe mieszkanie Teofilów", description: null }));
  assert.ok(contradicting.conflicts.includes("rooms"), "an explicit '3 pokoje' in the text contradicts 2 rooms");
  const unknownNoContent = assessCrossPortalPair(row("k5", "olx", { ...base, rooms: 2, description: null }), row("k6", "domy", { ...base, rooms: null, title: "Mieszkanie na sprzedaż", description: null }));
  assert.notEqual(unknownNoContent.kind, "confirmed", "unknown rooms + same price/area/floor without identical content is only a candidate");
});

test("floor values in every portal format: floor_N, FLOOR_N, English enums, Roman numerals and Polish ordinals", () => {
  const cases: Array<[string, number | null]> = [
    ["floor_3", 3], ["floor_4", 4], ["FLOOR_4", 4], ["FOURTH", 4], ["fourth", 4], ["GROUND", 0], ["ground_floor", 0], ["parter", 0],
    ["IV", 4], ["IV piętro", 4], ["III p.", 3], ["4", 4], ["4/10", 4], ["piętro 2", 2],
    ["floor_higher_10", null], ["poddasze", null], ["suterena", null], ["i", null], ["", null],
  ];
  for (const [value, expected] of cases) assert.equal(parseFloorValue(value), expected, value);
  const texts: Array<[string, number | null]> = [
    ["Mieszkanie na IV piętrze w bloku", 4], ["IV piętro bez windy", 4], ["piętro: IV", 4], ["Piętro II/IV", 2],
    ["na czwartym piętrze", 4], ["drugie piętro", 2], ["3 piętro", 3], ["mieszkanie na parterze", 0],
    ["Duży pokój i piętro wyżej", null], ["4-piętrowy blok", null], ["ostatnie piętro", null],
  ];
  for (const [text, expected] of texts) assert.equal(floorFromText(text), expected, text);
});

test("floor formats from different portals are compared as one value: floor_4 = FOURTH = IV = 4, floor_3 ≠ IV", () => {
  const base = { price: 238000, area: 37.07, rooms: 2, city: "Łódź", description: AGENCY_238 };
  const olx = { ...base, id: "a", source: "olx", floor: "4" };
  for (const floor of ["floor_4", "FOURTH", "IV", "IV piętro"]) {
    const assessment = assessCrossPortalPair(olx, { ...base, id: "b", source: "otodom", floor });
    assert.equal(assessment.kind, "confirmed", floor);
    assert.ok(assessment.evidence.includes("floor"), floor);
  }
  const otherFloor = assessCrossPortalPair(olx, { ...base, id: "c", source: "otodom", floor: "floor_3" });
  assert.equal(otherFloor.kind, "separate");
  assert.deepEqual(otherFloor.conflicts, ["floor"]);
});

test("identical fractional area and price on two portals is always offered for manual verification, even with an unknown room count", () => {
  const assessment = assessCrossPortalPair(
    { id: "a", source: "olx", price: 298000, area: 46.55, rooms: 2 },
    { id: "b", source: "oferty_net", price: 298000, area: 46.55, rooms: null },
  );
  assert.equal(assessment.kind, "candidate");
  assert.deepEqual(assessment.evidence, ["exact_area", "price_equal"]);
  assert.equal(assessCrossPortalPair({ id: "a", source: "olx", price: 298000, area: 46, rooms: 2 }, { id: "b", source: "domy", price: 298000, area: 46, rooms: null }).kind, "separate", "a round area is too common to suggest a duplicate on its own");
});
