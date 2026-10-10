import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRadarQualificationRejections, qualifyRadarCandidate, type QualificationCandidate } from "./qualification.ts";

function candidate(overrides: Partial<QualificationCandidate> = {}): QualificationCandidate {
  return {
    source: "domiporta", externalListingId: "ext-1", originalUrl: "https://example.test/1", normalizedUrl: "https://example.test/1",
    title: "Mieszkanie w bloku, Łódź Bałuty", description: "Świeżo po generalnym remoncie w 2025, nowe instalacje, gotowe do zamieszkania. Rynek wtórny.",
    price: 450_000, area: 50, pricePerSqm: 9_000, rooms: 2, city: "Łódź", district: "Bałuty",
    buildingType: null, marketType: null, rawPayload: { detailVerified: true }, contentHash: "hash-1",
    ...overrides,
  };
}

test("qualifies a confirmed secondary-market apartment in a block after a full, fresh renovation", () => {
  const result = qualifyRadarCandidate(candidate());
  assert.equal(result.qualified, true);
  if (result.qualified) {
    assert.equal(result.buildingType, "blok");
    assert.equal(result.marketType, "secondary");
    assert.equal(result.renovationStatus, "fresh_renovation");
    assert.equal(result.district, "Bałuty");
  }
});

test("qualifies a confirmed primary-market apartamentowiec finished turnkey", () => {
  const result = qualifyRadarCandidate(candidate({
    title: "Mieszkanie w apartamentowcu, Śródmieście", description: "Rynek pierwotny, wykończone pod klucz, nowa inwestycja.",
    district: "Śródmieście", buildingType: "apartamentowiec",
  }));
  assert.equal(result.qualified, true);
  if (result.qualified) {
    assert.equal(result.buildingType, "apartamentowiec");
    assert.equal(result.marketType, "primary");
    assert.equal(result.renovationStatus, "turnkey_finish");
  }
});

test("rejects missing price or area, never fabricating a price/m2", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({ price: null })), { qualified: false, reason: "price_missing" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ area: null })), { qualified: false, reason: "area_missing" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ price: 0 })), { qualified: false, reason: "price_missing" });
});

test("Oferty.net and Domiporta do not qualify from a result card until the specific offer detail fields are confirmed", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({ rawPayload: { detailVerified: false } })), { qualified: false, reason: "detail_not_confirmed" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ source: "oferty_net", rawPayload: {} })), { qualified: false, reason: "detail_not_confirmed" });
  assert.equal(qualifyRadarCandidate(candidate({ source: "morizon", rawPayload: {} })).qualified, true, "the detail gate is scoped to the two adapters that fetch details");
});

test("Radar excludes confirmed tenements even after renovation or with an elevator", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({ title: "Mieszkanie po remoncie w kamienicy z windą" })), { qualified: false, reason: "tenement_excluded" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ buildingType: "kamienica", title: "Mieszkanie po remoncie" })), { qualified: false, reason: "tenement_excluded" });
});

test("Radar treats own-listing building conflicts as excluded and ignores a neighboring tenement", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({ buildingType: "blok", title: "Mieszkanie po remoncie", description: "Lokal znajduje się w kamienicy po rewitalizacji. Rynek wtórny, świeżo po generalnym remoncie w 2025, gotowe do zamieszkania." })), { qualified: false, reason: "tenement_excluded" });
  const nearby = qualifyRadarCandidate(candidate({ buildingType: "blok", title: "Mieszkanie w bloku, kamienica obok", description: "Rynek wtórny. Świeżo po generalnym remoncie w 2025, gotowe do zamieszkania." }));
  assert.equal(nearby.qualified, true);
  const negated = qualifyRadarCandidate(candidate({ buildingType: "blok", title: "Mieszkanie w bloku", description: "To nie jest kamienica. Rynek wtórny, świeżo po generalnym remoncie w 2025, gotowe do zamieszkania." }));
  assert.equal(negated.qualified, true);
});

test("rejects an unconfirmed district -- missing data is never treated as confirmation", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({ district: null })), { qualified: false, reason: "district_not_confirmed" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ district: "Nieznana" })), { qualified: false, reason: "district_not_confirmed" });
});

// Confirmed live against this app's own stored listings (2026-10-11): most
// real district values are not a bare canonical name at all. An exact,
// whole-string match alone rejected the large majority of real candidates
// with genuinely confirmable Łódź locations as "district_not_confirmed".
test("a portal's compound 'MainDistrict, street/sub-area' value confirms the leading district (domy.pl/allegrolokalnie.pl's own real shape)", () => {
  const street = (district: string) => qualifyRadarCandidate(candidate({ district: `${district}, ul. Jaracza 57` }));
  assert.equal(street("Śródmieście").qualified, true);
  const subArea = qualifyRadarCandidate(candidate({ district: "Bałuty, Teofilów" }));
  assert.equal(subArea.qualified, true);
  if (subArea.qualified) assert.equal(subArea.district, "Bałuty", "the leading, unit-naming segment wins -- never the trailing sub-area");
});

test("a trailing-hyphenated compound ('Widzew-Wschód') still confirms its leading district", () => {
  const result = qualifyRadarCandidate(candidate({ district: "Widzew-Wschód" }));
  assert.equal(result.qualified, true);
  if (result.qualified) assert.equal(result.district, "Widzew");
});

test("a bare sub-area name with no district at all confirms its district via the cross-validated neighbourhood table (gratka.pl's own real shape)", () => {
  const cases: Array<[string, string]> = [
    ["Teofilów", "Bałuty"], ["Julianów-Marysin-Rogi", "Bałuty"], ["Radogoszcz", "Bałuty"], ["Łagiewniki", "Bałuty"],
    ["Dąbrowa", "Górna"], ["Chojny", "Górna"], ["Chojny-Dąbrowa", "Górna"], ["Ruda", "Górna"], ["Rokicie", "Górna"],
    ["Stare Polesie", "Polesie"], ["Retkinia", "Polesie"], ["Karolew-Retkinia Wschód", "Polesie"], ["Koziny", "Polesie"], ["Złotno", "Polesie"], ["Lublinek-Pienista", "Polesie"],
    ["Olechów-Janów", "Widzew"], ["Zarzew", "Widzew"], ["Stary Widzew", "Widzew"],
    ["Os. Katedralna", "Śródmieście"],
  ];
  for (const [value, expectedDistrict] of cases) {
    const result = qualifyRadarCandidate(candidate({ district: value }));
    assert.equal(result.qualified, true, `"${value}" must confirm a district`);
    if (result.qualified) assert.equal(result.district, expectedDistrict, `"${value}" must resolve to ${expectedDistrict}`);
  }
});

// domy.pl's own real shape: the leading segment is the sub-area itself, not
// the main district, with a street as the second segment ("Teofilów,
// Rojna" -- a real Bałuty street, not a second place called "Rojna"). The
// neighbourhood table must be checked against the leading segment, not only
// a bare whole-string value, or these never resolve at all.
test("a bare sub-area followed by its own street ('Teofilów, Rojna') still resolves via the neighbourhood table on the leading segment", () => {
  const result = qualifyRadarCandidate(candidate({ district: "Teofilów, Rojna" }));
  assert.equal(result.qualified, true);
  if (result.qualified) assert.equal(result.district, "Bałuty");
});

test("a city name alone, or a sub-area with no internal cross-validated district pairing, stays unconfirmed rather than guessed", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({ district: "Łódź" })), { qualified: false, reason: "district_not_confirmed" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ district: "Stoki" })), { qualified: false, reason: "district_not_confirmed" }, "never observed paired with a canonical district in this app's own data -- must not be guessed from outside geography knowledge");
  assert.deepEqual(qualifyRadarCandidate(candidate({ district: "Górniak" })), { qualified: false, reason: "district_not_confirmed" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ district: "Górniak, ul. Grabowa" })), { qualified: false, reason: "district_not_confirmed" }, "an unvalidated leading sub-area with its own street must stay unconfirmed too, never fall back to a different segment");
});

test("rejects a city other than Łódź", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({ city: "Warszawa" })), { qualified: false, reason: "city_not_lodz" });
});

test("excludes kamienica, dom, segment, działka, lokal użytkowy, pokój/najem, udział, and bulk investment ads", () => {
  assert.equal(qualifyRadarCandidate(candidate({ title: "Mieszkanie w kamienicy, Łódź", description: "" })).qualified, false);
  assert.equal(qualifyRadarCandidate(candidate({ title: "Dom wolnostojący, Łódź", description: "" })).qualified, false);
  assert.equal(qualifyRadarCandidate(candidate({ title: "Segment w zabudowie szeregowej", description: "" })).qualified, false);
  assert.equal(qualifyRadarCandidate(candidate({ title: "Działka budowlana, Łódź", description: "" })).qualified, false);
  assert.equal(qualifyRadarCandidate(candidate({ title: "Lokal użytkowy na sprzedaż", description: "" })).qualified, false);
  assert.equal(qualifyRadarCandidate(candidate({ title: "Pokój do wynajęcia", description: "" })).qualified, false);
  assert.equal(qualifyRadarCandidate(candidate({ title: "Sprzedam udział we współwłasności mieszkania" })).qualified, false);
  assert.equal(qualifyRadarCandidate(candidate({ title: "Nowa inwestycja", description: "Ceny mieszkań od 400 000 zł, różne metraże do wyboru, harmonogram inwestycji dostępny u dewelopera." })).qualified, false);
});

test("a sale listing described as ideal for future rental is not misclassified as a rental offer", () => {
  const result = qualifyRadarCandidate(candidate({
    title: "Mieszkanie w bloku, idealne pod wynajem, Łódź Bałuty",
    description: "Sprzedaż lokalu. Świeżo po generalnym remoncie w 2025, gotowe do zamieszkania. Rynek wtórny.",
  }));
  assert.equal(result.qualified, true, "the wording describes possible investment use, not an offer to rent the property");
});

test("Oferty.net: a completed general renovation left unoccupied and explicitly ready to move in is confirmed without an invented renovation year", () => {
  const result = qualifyRadarCandidate(candidate({
    source: "oferty_net",
    externalListingId: "1543068412",
    originalUrl: "https://www.oferty.net/mieszkanie-na-sprzedaz-bauty-teofilw-45m2-2-pokoje-419000-pln-fb,1543068412",
    normalizedUrl: "https://www.oferty.net/mieszkanie-na-sprzedaz-bauty-teofilw-45m2-2-pokoje-419000-pln-fb,1543068412",
    title: "Mieszkanie na sprzedaż - Łanowa Teofilów, Bałuty, Łódź",
    description: "Lokal przeszedł generalny remont i po jego zakończeniu nie był jeszcze zamieszkały. Jest gotowy do wprowadzenia. Układ sprawdzi się także pod wynajem.",
    price: 419_000, area: 45, pricePerSqm: null, rooms: 2,
    city: "Łódź", district: "Bałuty", buildingType: "blok", marketType: "secondary", propertyType: "apartment",
    rawPayload: { detailVerified: true },
  }));
  assert.deepEqual(result, { qualified: true, buildingType: "blok", marketType: "secondary", renovationStatus: "fresh_renovation", district: "Bałuty", pricePerSqm: 419_000 / 45 });
});

test("Oferty.net records with unresolved same-unit conflicts are rejected before entering qualification A/B", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({
    source: "oferty_net", externalListingId: "1543068412", price: 549_000, area: 57, rooms: 3,
    title: "Mieszkanie na sprzedaż — Bałuty-Doły, Łódź",
    description: "Mieszkanie o powierzchni 45 m², położone na parterze na Teofilowie. Generalny remont, gotowe do wprowadzenia.",
    rawPayload: { detailVerified: true, detailContradictions: ["area", "floor", "location"], detailEvidence: { floor: 6, locationText: "Bałuty-Doły" } },
  })), { qualified: false, reason: "detail_conflict" });
});

test("a full renovation without an explicit recent year or unused-since-completion evidence stays unqualified", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({
    description: "Mieszkanie po generalnym remoncie, gotowe do wprowadzenia. Rynek wtórny.",
  })), { qualified: false, reason: "renovation_not_confirmed_fresh_full" });
});

test("category B accepts a fully finished, ready secondary apartment in an explicitly high standard without inventing a renovation date", () => {
  const result = qualifyRadarCandidate(candidate({
    description: "Mieszkanie w pełni wykończone, gotowe do zamieszkania, wysoki standard. Rynek wtórny.",
  }));
  assert.deepEqual(result, { qualified: true, buildingType: "blok", marketType: "secondary", renovationStatus: "turnkey_finish", district: "Bałuty", pricePerSqm: 9_000 });
});

test("a directly negated repair requirement does not reject category A or B, but a separate contradictory repair requirement still rejects", () => {
  const fresh = qualifyRadarCandidate(candidate({
    description: "Świeżo po generalnym remoncie w 2025, gotowe do zamieszkania, nie wymaga remontu. Rynek wtórny.",
  }));
  assert.equal(fresh.qualified && fresh.renovationStatus, "fresh_renovation");

  const ready = qualifyRadarCandidate(candidate({
    description: "W pełni wykończone, gotowe do zamieszkania, wysoki standard. Mieszkanie nie wymaga remontu. Rynek wtórny.",
  }));
  assert.equal(ready.qualified && ready.renovationStatus, "turnkey_finish");

  assert.deepEqual(qualifyRadarCandidate(candidate({
    description: "Mieszkanie nie wymaga remontu, ale wymaga remontu przed zamieszkaniem. W pełni wykończone, gotowe do zamieszkania, wysoki standard. Rynek wtórny.",
  })), { qualified: false, reason: "unfinished_or_needs_renovation" });
});

test("category B requires complete finish, readiness, and high standard as separate positive evidence", () => {
  assert.equal(qualifyRadarCandidate(candidate({ description: "Mieszkanie premium, w pełni wykończone i gotowe do zamieszkania. Rynek wtórny." })).qualified, false, "premium alone is not standard evidence");
  assert.equal(qualifyRadarCandidate(candidate({ description: "W pełni wykończone, wysoki standard. Rynek wtórny." })).qualified, false, "finish and standard do not prove readiness");
  assert.equal(qualifyRadarCandidate(candidate({ description: "Gotowe do zamieszkania, wysoki standard. Rynek wtórny." })).qualified, false, "readiness and standard do not prove complete finish");
});

test("category B rejects negated, contradictory, extra-cost, and unrelated building/other-unit quality claims", () => {
  assert.equal(qualifyRadarCandidate(candidate({ description: "W pełni wykończone, gotowe do zamieszkania. Standard nie jest wysoki. Rynek wtórny." })).qualified, false);
  assert.equal(qualifyRadarCandidate(candidate({ description: "W pełni wykończone, gotowe do zamieszkania, wysoki standard, ale wymaga dodatkowego wykończenia. Rynek wtórny." })).qualified, false);
  assert.equal(qualifyRadarCandidate(candidate({ description: "Mieszkanie gotowe do zamieszkania. Budynek jest w wysokim standardzie. Rynek wtórny." })).qualified, false, "building standard alone cannot qualify the unit");
  assert.equal(qualifyRadarCandidate(candidate({ description: "W pełni wykończone, gotowe do zamieszkania. Inne mieszkanie oferuje wysoki standard. Rynek wtórny." })).qualified, false, "another unit cannot supply finish evidence");
});

test("old run rule version 1 keeps its original strict secondary renovation requirement", () => {
  const bCandidate = candidate({ description: "Mieszkanie w pełni wykończone, gotowe do zamieszkania, wysoki standard. Rynek wtórny." });
  assert.deepEqual(qualifyRadarCandidate(bCandidate, 1), { qualified: false, reason: "renovation_not_confirmed_fresh_full" });
});

test("a fresh completed renovation takes category A precedence over category B", () => {
  const result = qualifyRadarCandidate(candidate({
    description: "Świeżo po generalnym remoncie w 2025, w pełni wykończone, gotowe do zamieszkania, wysoki standard. Rynek wtórny.",
  }));
  assert.equal(result.qualified, true);
  if (result.qualified) assert.equal(result.renovationStatus, "fresh_renovation");
});

test("an actual offer to rent remains excluded even when its title also mentions investment use", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({
    title: "Mieszkanie idealne pod wynajem",
    description: "Aktualnie do wynajęcia. Świeżo po generalnym remoncie w 2025, rynek wtórny, gotowe do zamieszkania.",
  })), { qualified: false, reason: "rental" });
});

test("rejects an unconfirmed building type (neither structured nor a text declaration of blok/apartamentowiec)", () => {
  const result = qualifyRadarCandidate(candidate({ title: "Mieszkanie na sprzedaż, Łódź", description: "Ładne, 3 pokoje. Po remoncie, gotowe do zamieszkania. Rynek wtórny." }));
  assert.deepEqual(result, { qualified: false, reason: "building_type_not_confirmed" });
});

test("rejects an unconfirmed market type", () => {
  const result = qualifyRadarCandidate(candidate({ description: "Po generalnym remoncie, nowe instalacje, gotowe do zamieszkania." }));
  assert.deepEqual(result, { qualified: false, reason: "market_type_not_confirmed" });
});

test("secondary market: 'stan deweloperski' and 'do remontu' are disqualifying, never a review-worthy pass", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({ description: "Stan deweloperski, rynek wtórny." })), { qualified: false, reason: "unfinished_or_needs_renovation" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ description: "Mieszkanie do remontu, rynek wtórny." })), { qualified: false, reason: "unfinished_or_needs_renovation" });
});

test("secondary market: only weak cosmetic evidence (odświeżone/ładne) never qualifies as a fresh full renovation", () => {
  const result = qualifyRadarCandidate(candidate({ description: "Odświeżone, zadbane mieszkanie. Rynek wtórny." }));
  assert.deepEqual(result, { qualified: false, reason: "renovation_not_confirmed_fresh_full" });
});

test("primary market: a confirmed 'stan deweloperski' listing is excluded even though it is genuinely new-build", () => {
  const result = qualifyRadarCandidate(candidate({ title: "Mieszkanie w apartamentowcu", description: "Rynek pierwotny, stan deweloperski.", district: "Widzew", buildingType: "apartamentowiec" }));
  assert.deepEqual(result, { qualified: false, reason: "unfinished_or_needs_renovation" });
});

test("primary market: no explicit turnkey declaration never qualifies, even with no negative signal either", () => {
  const result = qualifyRadarCandidate(candidate({ title: "Mieszkanie w apartamentowcu", description: "Rynek pierwotny, nowa inwestycja.", district: "Widzew", buildingType: "apartamentowiec" }));
  assert.deepEqual(result, { qualified: false, reason: "turnkey_not_confirmed" });
});

test("primary turnkey finish explicitly offered for an additional charge is not included in the sale category", () => {
  const result = qualifyRadarCandidate(candidate({
    title: "Mieszkanie w apartamentowcu",
    description: "Rynek pierwotny, wykończone pod klucz za dopłatą.",
    district: "Widzew", buildingType: "apartamentowiec",
  }));
  assert.deepEqual(result, { qualified: false, reason: "turnkey_not_confirmed" });
});

test("a structured buildingType/marketType field is honored when the listing text does not contradict it", () => {
  const result = qualifyRadarCandidate(candidate({
    title: "Mieszkanie, Łódź", description: "Świeżo po generalnym remoncie w 2025, gotowe do zamieszkania.",
    buildingType: "blok", marketType: "secondary",
  }));
  assert.equal(result.qualified, true);
});

test("does not qualify a listing without positive apartment evidence or with a negated apartment claim", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({ title: "Lokal w bloku", description: "Świeżo po generalnym remoncie w 2025, rynek wtórny, gotowy do zamieszkania." })), { qualified: false, reason: "apartment_not_confirmed" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ title: "To nie jest mieszkanie", description: "Świeżo po generalnym remoncie w 2025, rynek wtórny, blok." })), { qualified: false, reason: "apartment_not_confirmed" });
});

test("does not trust contradictory structured market/building values or negated renovation evidence", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({ marketType: "primary", description: "Rynek wtórny, świeżo po generalnym remoncie w 2025, gotowe do zamieszkania." })), { qualified: false, reason: "market_type_not_confirmed" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ buildingType: "apartamentowiec", description: "Mieszkanie w bloku, rynek wtórny, świeżo po generalnym remoncie w 2025, gotowe do zamieszkania." })), { qualified: false, reason: "building_type_not_confirmed" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ description: "Nie po generalnym remoncie, mieszkanie w bloku, rynek wtórny, gotowe do zamieszkania." })), { qualified: false, reason: "renovation_exclusion" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ description: "Po remoncie, gotowe do zamieszkania. Rynek wtórny." })), { qualified: false, reason: "renovation_not_confirmed_fresh_full" });
});

test("Radar price/m² always comes from the positive total price divided by area, not a stale portal ratio", () => {
  const result = qualifyRadarCandidate(candidate({ price: 500_000, area: 50, pricePerSqm: 1 }));
  assert.equal(result.qualified, true);
  if (result.qualified) assert.equal(result.pricePerSqm, 10_000);
});

test("rejects a starting-price ad or an amount explicitly marked as per square metre", () => {
  assert.deepEqual(qualifyRadarCandidate(candidate({ title: "Mieszkania od 400 000 zł w bloku" })), { qualified: false, reason: "price_is_starting_price" });
  assert.deepEqual(qualifyRadarCandidate(candidate({ rawPayload: { detailVerified: true, priceUnit: "per_sqm" } })), { qualified: false, reason: "price_is_not_total_offer_price" });
});

test("a structured buildingType naming a disqualifying type (e.g. 'dom') is never overridden by a hopeful text guess", () => {
  const result = qualifyRadarCandidate(candidate({ buildingType: "dom" }));
  assert.equal(result.qualified, false);
});

test("qualification rejection diagnostics accept only known, positive integer counts and bounded source keys", () => {
  assert.deepEqual(normalizeRadarQualificationRejections({
    olx: { district_not_confirmed: 51, rental: 2, invented_reason: 4, price_missing: -1 },
    "bad source": { rental: 8 },
    morizon: "not-an-object",
  }), { olx: { district_not_confirmed: 51, rental: 2 } });
});
