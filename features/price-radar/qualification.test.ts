import assert from "node:assert/strict";
import test from "node:test";
import { qualifyRadarCandidate, type QualificationCandidate } from "./qualification.ts";

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
