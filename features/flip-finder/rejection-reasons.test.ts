import assert from "node:assert/strict";
import test from "node:test";
import { describeAllReasons, describeMissingField, describeRejectionReason } from "./rejection-reasons.ts";
import type { SearchFilter } from "@/features/flip-finder";

const filter: SearchFilter = {
  id: "6ebf3a9c-5418-4ae6-a0bf-1989b6603367",
  name: "Flip",
  sources: ["facebook"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: 32,
  areaMax: 75,
  rooms: [1, 2, 3, 4],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: false,
  buildingTypes: ["blok", "apartamentowiec"],
  ownershipTypes: ["pełna własność", "spółdzielcze"],
  marketType: null,
  privateOnly: false,
  maxPricePerSqm: 8_200,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60,
  isActive: true,
  lastScannedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function context(overrides: Partial<Parameters<typeof describeRejectionReason>[1]> = {}) {
  return {
    price: null,
    area: null,
    pricePerSqm: null,
    rooms: null,
    floor: null,
    buildingType: null,
    ownership: null,
    city: null,
    district: null,
    ...overrides,
  };
}

// The mission's own exact required strings.
test("409000 zł / 39 m² over the 8200 cap reads exactly: Cena za m²: 10 487 zł > limit 8200 zł", () => {
  const pricePerSqm = 409_000 / 39;
  // Intl.NumberFormat("pl-PL") separates thousands with U+00A0 (no-break
  // space), not a plain space -- matches the rendered result visually.
  assert.equal(describeRejectionReason("max_price_per_sqm", context({ pricePerSqm }), filter), "Cena za m²: 10 487 zł > limit 8200 zł");
});

test("missing building type reads exactly: Brak potwierdzonego typu budynku", () => {
  assert.equal(describeMissingField("buildingType"), "Brak potwierdzonego typu budynku");
});

test("missing ownership reads exactly: Brak potwierdzonej formy własności", () => {
  assert.equal(describeMissingField("ownership"), "Brak potwierdzonej formy własności");
});

test("outside the filter's city reads exactly: Poza miastem Łódź", () => {
  assert.equal(describeRejectionReason("city", context(), filter), "Poza miastem Łódź");
});

test("no reason ever renders as a bare internal code or a generic 'odrzucona'", () => {
  const reasons = ["max_price_per_sqm", "city", "building_type", "ownership", "rooms", "price_min", "area_max"];
  for (const reason of reasons) {
    const text = describeRejectionReason(reason, context({ pricePerSqm: 6_000, price: 300_000, area: 40, rooms: 2, city: "Zgierz", buildingType: "dom", ownership: "udział" }), filter);
    assert.notEqual(text, reason, `reason "${reason}" must not render as its own bare code`);
    assert.doesNotMatch(text.toLocaleLowerCase("pl-PL"), /^odrzucona$/, "must never be the bare generic word");
  }
});

test("describeAllReasons combines real reject reasons and missing-field gaps, dropping the internal 'review'/'unknown_' bookkeeping markers", () => {
  const texts = describeAllReasons(
    ["review", "unknown_buildingType", "unknown_ownership"],
    ["buildingType", "ownership"],
    context({ price: 265_000, area: 38.6, pricePerSqm: 265_000 / 38.6 }),
    filter,
  );
  assert.deepEqual(texts, ["Brak potwierdzonego typu budynku", "Brak potwierdzonej formy własności"]);
});

test("describeAllReasons for a genuine price rejection shows the specific number, not a placeholder", () => {
  const texts = describeAllReasons(["max_price_per_sqm"], [], context({ pricePerSqm: 409_000 / 39 }), filter);
  assert.deepEqual(texts, ["Cena za m²: 10 487 zł > limit 8200 zł"]);
});
