import assert from "node:assert/strict";
import test from "node:test";
import { evaluateListingAgainstFilter } from "./filter-evaluation.ts";
import type { SearchFilter } from "./index.ts";

const filter = {
  id: "filter", name: "Flip", sources: ["facebook", "olx"], city: "Łódź", districts: [],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
  privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: null, createdAt: "2026-08-23T00:00:00Z", updatedAt: "2026-08-23T00:00:00Z",
} satisfies SearchFilter;

const candidate = { price: 300_000, area: 45, pricePerSqm: 6_666, rooms: 2, floor: null, city: "Łódź", district: null, title: "Mieszkanie", locationText: "Łódź", buildingType: null };

test("Łódź filter rejects a known Warsaw listing", () => {
  const result = evaluateListingAgainstFilter({ ...candidate, city: "Warszawa", locationText: "Warszawa" }, filter);
  assert.equal(result.matches, false);
  assert.deepEqual(result.reasons, ["city"]);
});

test("city comparison is case and diacritic safe", () => {
  assert.equal(evaluateListingAgainstFilter({ ...candidate, city: "lodz" }, filter).matches, true);
});

test("unknown city remains explicit metadata instead of becoming a false mismatch", () => {
  const result = evaluateListingAgainstFilter({ ...candidate, city: null }, filter);
  assert.equal(result.matches, true);
  assert.deepEqual(result.unknownFields, ["city"]);
});
