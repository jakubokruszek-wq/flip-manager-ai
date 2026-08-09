import assert from "node:assert/strict";
import test from "node:test";

import { filterResultsByText } from "./results.ts";

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

function result(overrides) {
  return {
    id: overrides.id, title: overrides.title, district: overrides.district, city: overrides.city,
    source: overrides.source, originalUrl: `https://example.com/${overrides.id}`,
    price: null, area: null, rooms: null, floor: null, totalFloors: null, buildingType: null,
    ownership: null, description: null, images: [], pricePerSqm: null, locationText: null,
    address: null, thumbnailUrl: null, listingStatus: "active", isActive: true,
    firstSeenAt: "2026-08-01T10:00:00.000Z", lastSeenAt: "2026-08-01T10:00:00.000Z",
    firstMatchedAt: "2026-08-01T10:00:00.000Z", lastMatchedAt: "2026-08-01T10:00:00.000Z",
    previousPrice: null, currentPrice: null, isNew: false, hasPriceDrop: false,
    priceDropAmount: null, matchReasons: [], unknownFields: [],
  };
}

function ids(items) {
  return items.map(({ id }) => id);
}
