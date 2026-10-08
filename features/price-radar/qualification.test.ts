import assert from "node:assert/strict";
import test from "node:test";
import { qualifyRadarCandidate, type QualificationCandidate } from "./qualification.ts";

function candidate(overrides: Partial<QualificationCandidate> = {}): QualificationCandidate {
  return {
    source: "domiporta", externalListingId: "ext-1", originalUrl: "https://example.test/1", normalizedUrl: "https://example.test/1",
    title: "Mieszkanie w bloku, Łódź Bałuty", description: "Po generalnym remoncie, nowe instalacje, gotowe do zamieszkania. Rynek wtórny.",
    price: 450_000, area: 50, pricePerSqm: 9_000, rooms: 2, city: "Łódź", district: "Bałuty",
    buildingType: null, marketType: null, contentHash: "hash-1",
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
    title: "Apartamentowiec, Śródmieście", description: "Rynek pierwotny, wykończone pod klucz, nowa inwestycja.",
    district: "Śródmieście",
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
  const result = qualifyRadarCandidate(candidate({ title: "Apartamentowiec", description: "Rynek pierwotny, stan deweloperski.", district: "Widzew" }));
  assert.deepEqual(result, { qualified: false, reason: "unfinished_or_needs_renovation" });
});

test("primary market: no explicit turnkey declaration never qualifies, even with no negative signal either", () => {
  const result = qualifyRadarCandidate(candidate({ title: "Apartamentowiec", description: "Rynek pierwotny, nowa inwestycja.", district: "Widzew" }));
  assert.deepEqual(result, { qualified: false, reason: "turnkey_not_confirmed" });
});

test("a structured buildingType/marketType field is honored directly, without needing a text declaration", () => {
  const result = qualifyRadarCandidate(candidate({
    title: "Mieszkanie, Łódź", description: "Po generalnym remoncie, nowe instalacje, gotowe do zamieszkania.",
    buildingType: "blok", marketType: "secondary",
  }));
  assert.equal(result.qualified, true);
});

test("a structured buildingType naming a disqualifying type (e.g. 'dom') is never overridden by a hopeful text guess", () => {
  const result = qualifyRadarCandidate(candidate({ buildingType: "dom" }));
  assert.equal(result.qualified, false);
});
