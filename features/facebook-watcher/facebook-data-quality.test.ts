import assert from "node:assert/strict";
import test from "node:test";
import { evaluateListingAgainstFilter } from "../flip-finder/filter-evaluation.ts";
import type { SearchFilter } from "../flip-finder/types/index.ts";
import { facebookNoMatchWarnings, mergeFacebookPropertyByConfidence } from "./facebook-data-quality.ts";
import type { FacebookProperty } from "./types.ts";

function property(overrides: Partial<FacebookProperty> = {}): FacebookProperty {
  return {
    title: "Mieszkanie Łódź", city: "Łódź", district: "Bałuty", neighborhood: null, street: null,
    price: 161_000, area: 40, rooms: 2, floor: null, totalFloors: null, marketType: "secondary",
    sellerType: "private", condition: "renovation", description: "40 m², 2 pokoje", originalUrl: null,
    images: [], confidence: 0.9, flags: [], ...overrides,
  };
}

function existing(values: Partial<FacebookProperty>, confidence = 0.9) {
  return { values, confidence, fieldConfidence: { city: confidence, price: confidence, area: confidence, rooms: confidence } };
}

test("existing city is retained when incoming city is null", () => {
  const result = mergeFacebookPropertyByConfidence(existing({ city: "Łódź" }), property({ city: null, confidence: 0 }));
  assert.equal(result.property.city, "Łódź");
});

test("low-confidence OCR price cannot replace a strong price or create a price drop", () => {
  const result = mergeFacebookPropertyByConfidence(existing({ price: 161_000 }), property({ price: 61_000, confidence: 0, fieldConfidence: { price: 0 } }));
  assert.equal(result.property.price, 161_000);
  assert.equal(result.priceChanged, false);
});

test("high-confidence incoming value fills an empty field", () => {
  const result = mergeFacebookPropertyByConfidence(existing({ area: null }, 0), property({ area: 44.5, fieldConfidence: { area: 0.94 } }));
  assert.equal(result.property.area, 44.5);
});

test("later weak scan cannot degrade multiple strong fields", () => {
  const result = mergeFacebookPropertyByConfidence(existing({ city: "Łódź", price: 161_000, area: 40, rooms: 2 }), property({ city: null, price: 61_000, area: null, rooms: null, confidence: 0 }));
  assert.deepEqual({ city: result.property.city, price: result.property.price, area: result.property.area, rooms: result.property.rooms }, { city: "Łódź", price: 161_000, area: 40, rooms: 2 });
});

test("complete Facebook extraction can pass the unchanged Flip matcher", () => {
  const item = property({ price: 240_000, area: 40, rooms: 2 });
  const filter: SearchFilter = {
    id: "flip", name: "Flip", sources: ["facebook"], city: "Łódź", districts: [], priceMin: null,
    priceMax: null, areaMin: null, areaMax: null, rooms: [1, 2, 3], floorMin: null, floorMax: null,
    excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
    privateOnly: false, maxPricePerSqm: 6_500, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
    minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
    lastScannedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
  const decision = evaluateListingAgainstFilter({ price: item.price, area: item.area, pricePerSqm: item.price! / item.area!, rooms: item.rooms, floor: null, city: item.city, district: item.district, title: item.title, locationText: "Bałuty, Łódź", buildingType: null, sellerType: item.sellerType, marketType: item.marketType, ownership: null }, filter);
  assert.equal(decision.matches, true);
  assert.deepEqual(decision.reasons, []);
});

test("NO MATCH reason codes are exposed without changing matcher output", () => {
  assert.deepEqual(facebookNoMatchWarnings(false, ["area_missing", "rooms_missing"]), [
    "FACEBOOK_NO_MATCH:area_missing,rooms_missing",
  ]);
  assert.deepEqual(facebookNoMatchWarnings(true, []), []);
});
