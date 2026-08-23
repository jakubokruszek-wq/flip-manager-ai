import assert from "node:assert/strict";
import test from "node:test";

import { filterResultsByText, publicationLabel, sortResults } from "./results.ts";

const results = [
  result({ id: "olx-baluty", title: "Mieszkanie do remontu przy Wielkopolskiej", district: "Bałuty", city: "Łódź", source: "olx" }),
  result({ id: "otodom-centrum", title: "Kawalerka inwestycyjna", district: "Śródmieście", city: "Łódź", source: "otodom" }),
  result({ id: "morizon-retkinia", title: "Rozkładowe trzy pokoje", district: "Polesie", city: "Łódź", source: "morizon" }),
];

test("filters by title", () => {
  assert.deepEqual(ids(filterResultsByText(results, "Kawalerka inwestycyjna")), ["otodom-centrum"]);
});

test("filters by district with Polish characters", () => {
  assert.deepEqual(ids(filterResultsByText(results, "Bałuty")), ["olx-baluty"]);
});

test("filters by source", () => {
  assert.deepEqual(ids(filterResultsByText(results, "olx")), ["olx-baluty"]);
});

test("filters by a title fragment", () => {
  assert.deepEqual(ids(filterResultsByText(results, "remontu przy")), ["olx-baluty"]);
});

test("is case-insensitive and trims the query", () => {
  assert.deepEqual(ids(filterResultsByText(results, "  ŚRÓDMIEŚCIE  ")), ["otodom-centrum"]);
});

test("returns the original result set for an empty query", () => {
  assert.strictEqual(filterResultsByText(results, "   "), results);
});

test("filters by city and normalizes equivalent Unicode forms", () => {
  assert.deepEqual(ids(filterResultsByText(results, "Łódź".normalize("NFC"))), results.map(({ id }) => id));
});

test("publication label uses the source publication date", () => {
  assert.match(publicationLabel("2026-08-22T18:42:12.000Z"), /^Opublikowano:/);
  assert.equal(publicationLabel(null), "Data publikacji: nieznana");
});

test("newest sort uses publishedAt descending and keeps unknown publication dates last", () => {
  const old = result({ id: "old", title: "Old", district: null, city: "Łódź", source: "olx", publishedAt: "2026-08-20T10:00:00Z", lastSeenAt: "2026-08-23T10:00:00Z" });
  const fresh = result({ id: "fresh", title: "Fresh", district: null, city: "Łódź", source: "facebook", publishedAt: "2026-08-22T10:00:00Z", lastSeenAt: "2026-08-22T11:00:00Z" });
  const unknown = result({ id: "unknown", title: "Unknown", district: null, city: "Łódź", source: "olx", publishedAt: null, lastSeenAt: "2026-08-23T12:00:00Z" });
  assert.deepEqual(ids(sortResults([unknown, old, fresh], "newest")), ["fresh", "old", "unknown"]);
});

test("price per sqm sort is numeric, stable and puts non-positive or null values last", () => {
  const values = [
    result({ id: "null", title: "Null", district: null, city: "Łódź", source: "olx", pricePerSqm: null }),
    result({ id: "six", title: "Six", district: null, city: "Łódź", source: "olx", pricePerSqm: 6_000 }),
    result({ id: "zero", title: "Zero", district: null, city: "Łódź", source: "olx", pricePerSqm: 0 }),
    result({ id: "five-a", title: "Five A", district: null, city: "Łódź", source: "olx", pricePerSqm: 5_000 }),
    result({ id: "five-b", title: "Five B", district: null, city: "Łódź", source: "olx", pricePerSqm: 5_000 }),
  ];
  assert.deepEqual(ids(sortResults(values, "price_per_sqm_asc")), ["five-a", "five-b", "six", "null", "zero"]);
});

function result(overrides) {
  return {
    id: overrides.id, title: overrides.title, district: overrides.district, city: overrides.city,
    source: overrides.source, originalUrl: `https://example.com/${overrides.id}`,
    price: null, area: null, rooms: null, floor: null, totalFloors: null, buildingType: null,
    ownership: null, description: null, images: [], pricePerSqm: "pricePerSqm" in overrides ? overrides.pricePerSqm : null, locationText: null,
    address: null, thumbnailUrl: null, listingStatus: "active", isActive: true,
    publishedAt: overrides.publishedAt ?? null,
    firstSeenAt: "2026-08-01T10:00:00.000Z", lastSeenAt: overrides.lastSeenAt ?? "2026-08-01T10:00:00.000Z",
    firstMatchedAt: "2026-08-01T10:00:00.000Z", lastMatchedAt: "2026-08-01T10:00:00.000Z",
    previousPrice: null, currentPrice: null, isNew: false, hasPriceDrop: false,
    priceDropAmount: null, matchReasons: [], unknownFields: [],
  };
}

function ids(items) {
  return items.map(({ id }) => id);
}
