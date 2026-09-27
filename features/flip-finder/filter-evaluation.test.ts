import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCanonicalListingDecision, evaluateListingAgainstFilter } from "./filter-evaluation.ts";
import type { SearchFilter } from "./index.ts";

const filter = {
  id: "filter", name: "Flip", sources: ["facebook", "olx"], city: "Łódź", districts: [],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
  privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: null, createdAt: "2026-08-23T00:00:00Z", updatedAt: "2026-08-23T00:00:00Z",
} satisfies SearchFilter;

const candidate = { price: 300_000, area: 45, pricePerSqm: 6_666, rooms: 2, floor: null, city: "Łódź", district: null, title: "Mieszkanie", description: null, locationText: "Łódź", buildingType: null };

test("Łódź filter rejects a known Warsaw listing", () => {
  const result = evaluateListingAgainstFilter({ ...candidate, city: "Warszawa", locationText: "Warszawa" }, filter);
  assert.equal(result.matches, false);
  assert.deepEqual(result.reasons, ["city_mismatch"]);
});

test("city comparison is case and diacritic safe", () => {
  assert.equal(evaluateListingAgainstFilter({ ...candidate, city: "lodz" }, filter).matches, true);
});

test("unknown city remains explicit metadata instead of becoming a false mismatch", () => {
  const result = evaluateListingAgainstFilter({ ...candidate, city: null }, filter);
  assert.equal(result.matches, false);
  assert.equal(result.bucket, "REVIEW");
  assert.deepEqual(result.unknownFields, ["city"]);
});

// Real production case: a Łódź filter surfaced "MIESZKANIE W ALEKSANDROWIE
// ŁÓDZKIM NA SPRZEDAŻ" — Aleksandrów Łódzki is its own town, not Łódź — because
// its structured city field was empty and the fallback simply marked "city"
// unknown (REVIEW, still visible) without ever reading the title.
test("a Łódź filter excludes Aleksandrów Łódzki inferred from the title when the structured city is empty", () => {
  const result = evaluateListingAgainstFilter(
    { ...candidate, city: null, title: "MIESZKANIE W ALEKSANDROWIE ŁÓDZKIM NA SPRZEDAŻ", locationText: null },
    filter,
  );
  assert.equal(result.matches, false);
  assert.equal(result.bucket, "REJECTED");
  assert.deepEqual(result.reasons, ["city_mismatch"]);
});

test("a Łódź filter excludes Aleksandrów Łódzki inferred from the description when the structured city is empty", () => {
  const result = evaluateListingAgainstFilter(
    { ...candidate, city: null, title: "Mieszkanie na sprzedaż", description: "Lokalizacja: Aleksandrów Łódzki", locationText: null },
    filter,
  );
  assert.equal(result.bucket, "REJECTED");
  assert.deepEqual(result.reasons, ["city_mismatch"]);
});

// Real production case: a Łódź filter showed listings from Rzeszów and
// Piotrków Trybunalski with "Lokalizacja nieznana" / unknown_city, because
// the only free-text city check that existed (OUTSIDE_LODZ_TOWN) only ever
// listed towns immediately around Łódź, never the rest of the country.
test("a Łódź filter excludes Rzeszów inferred from the title when the structured city is empty", () => {
  const result = evaluateListingAgainstFilter(
    { ...candidate, city: null, title: "Mieszkanie na sprzedaż, Rzeszów, ul. Grunwaldzka", locationText: null },
    filter,
  );
  assert.equal(result.bucket, "REJECTED");
  assert.deepEqual(result.reasons, ["city_mismatch"]);
});

// "Piotrków Trybunalski" must be excluded, but bare "piotrkow\w*" would also
// match "Piotrkowska" -- Łódź's own best-known street -- so this specifically
// proves the compound match works and never fires on the Łódź street alone.
test("a Łódź filter excludes Piotrków Trybunalski inferred from the description, and never confuses it with ul. Piotrkowska in Łódź", () => {
  const rejected = evaluateListingAgainstFilter(
    { ...candidate, city: null, title: "Kawalerka", description: "Lokalizacja: Piotrków Trybunalski, centrum", locationText: null },
    filter,
  );
  assert.equal(rejected.bucket, "REJECTED");
  assert.deepEqual(rejected.reasons, ["city_mismatch"]);

  const lodzStreet = evaluateListingAgainstFilter(
    { ...candidate, city: null, title: "Mieszkanie, ul. Piotrkowska, Łódź", locationText: null },
    filter,
  );
  assert.equal(lodzStreet.bucket, "REVIEW", "ul. Piotrkowska is a real Łódź street and must never be confused with the city Piotrków Trybunalski");
  assert.deepEqual(lodzStreet.unknownFields, ["city"]);
});

test("a Łódź filter excludes any other named major Polish city, not just the mission's own worked examples", () => {
  for (const city of ["Kraków", "Wrocław", "Gdańsk", "Rzeszów"]) {
    const result = evaluateListingAgainstFilter(
      { ...candidate, city: null, title: `Mieszkanie na sprzedaż, ${city}`, locationText: null },
      filter,
    );
    assert.equal(result.bucket, "REJECTED", `${city} must be excluded`);
    assert.deepEqual(result.reasons, ["city_mismatch"]);
  }
});

// Diacritic/variant normalization: "Łódź", "Lodz", and a hyphenated
// district-style suffix must all still positively match the Łódź filter --
// this proves normalizeLocation folds "ł"->"l" and strips diacritics before
// any comparison, both for the structured field and the free-text fallback.
test("Łódź, Lodz, and a hyphenated Łódź-... district-style structured city value all normalize to a positive match", () => {
  for (const city of ["Łódź", "Lodz", "ŁÓDŹ", "łódź", "Łódź-Bałuty", "Łódź-Widzew"]) {
    assert.equal(evaluateListingAgainstFilter({ ...candidate, city }, filter).matches, true, `"${city}" must match the Łódź filter`);
  }
  // A structured city value must never match merely because it CONTAINS
  // "Łódź" somewhere -- only as its own leading component.
  assert.equal(evaluateListingAgainstFilter({ ...candidate, city: "Nowa Łódź-wieś" }, filter).matches, false, "a place that only happens to contain \"Łódź\" mid-name must never be treated as Łódź itself");
});

// The exclusion pattern must never fire on an ordinary Łódź street name that
// merely contains "Aleksandrowska" — this must stay REVIEW (unknown), not a
// false exclusion, and a positively-confirmed Łódź mention must never be
// second-guessed by an unrelated street name elsewhere in the same text.
test("a Łódź filter does not exclude a listing on ul. Aleksandrowska in Łódź", () => {
  const result = evaluateListingAgainstFilter(
    { ...candidate, city: null, title: "Mieszkanie, ul. Aleksandrowska, Łódź", locationText: null },
    filter,
  );
  assert.equal(result.bucket, "REVIEW");
  assert.deepEqual(result.unknownFields, ["city"]);
});

test("a non-Łódź filter's unknown-city handling is unchanged by the Łódź-specific inference", () => {
  const result = evaluateListingAgainstFilter(
    { ...candidate, city: null, title: "MIESZKANIE W ALEKSANDROWIE ŁÓDZKIM NA SPRZEDAŻ", locationText: null },
    { ...filter, city: "Warszawa" },
  );
  assert.equal(result.bucket, "REVIEW");
  assert.deepEqual(result.unknownFields, ["city"]);
});

test("known price per square metre above the limit is a hard rejection", () => {
  const result = evaluateListingAgainstFilter(
    { ...candidate, price: 600_000, area: 40, pricePerSqm: 15_000 },
    { ...filter, maxPricePerSqm: 12_000 },
  );
  assert.equal(result.bucket, "REJECTED");
  assert.deepEqual(result.reasons, ["max_price_per_sqm"]);
});

test("canonical decision keeps incomplete eligible listings in REVIEW", () => {
  const result = evaluateCanonicalListingDecision({ ...candidate, price: 305_000, area: 44.93, pricePerSqm: 6_788.3374, rooms: 2, district: "Widzew" }, { ...filter, areaMin: 32, areaMax: 58, maxPricePerSqm: 7_000, rooms: [1, 2, 3, 4], excludeTopFloor: true });
  assert.equal(result.bucket, "REVIEW");
  assert.deepEqual(result.missingFields, ["topFloor"]);
  assert.deepEqual(result.hardRejectReasons, []);
});

test("canonical decision rejects a known hard constraint even when other fields are missing", () => {
  const result = evaluateCanonicalListingDecision({ ...candidate, price: 405_000, area: 45, pricePerSqm: 9_000, rooms: 2 }, { ...filter, maxPricePerSqm: 7_000, excludeTopFloor: true });
  assert.equal(result.bucket, "REJECTED");
  assert.deepEqual(result.hardRejectReasons, ["max_price_per_sqm"]);
  assert.notEqual(result.bucket, "REVIEW");
});

test("minimum total sale price rejects below 160000 and accepts the exact boundary", () => {
  for (const price of [15_000, 150_000, 159_999]) {
    const result = evaluateListingAgainstFilter({ ...candidate, price }, filter);
    assert.equal(result.bucket, "REJECTED", `${price} must be rejected`);
    assert.ok(result.reasons.includes("min_total_sale_price"));
  }
  for (const price of [160_000, 160_001]) {
    const result = evaluateListingAgainstFilter({ ...candidate, price }, filter);
    assert.equal(result.bucket, "MATCHED", `${price} must pass the minimum`);
    assert.ok(!result.reasons.includes("min_total_sale_price"));
  }
});

test("rent intent is never treated as a sale price", () => {
  const result = evaluateListingAgainstFilter({ ...candidate, price: 15_000, listingIntent: "RENT_OFFER" }, filter);
  assert.equal(result.bucket, "REJECTED");
  assert.deepEqual(result.reasons, ["non_sale_intent"]);
  assert.ok(!result.reasons.includes("min_total_sale_price"));
});
