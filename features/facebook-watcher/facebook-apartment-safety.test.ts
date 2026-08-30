import assert from "node:assert/strict";
import test from "node:test";
import type { SearchFilter } from "@/features/flip-finder";
import { evaluateFacebookApartmentSafety } from "./facebook-apartment-safety.ts";

const filter = { id: "f", name: "Łódź bloki", sources: ["facebook"], city: "Łódź", districts: [], priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: ["blok", "apartamentowiec"], ownershipTypes: [], marketType: null, privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true, lastScannedAt: null, createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z" } satisfies SearchFilter;

test("accepts only positively verified allowed apartment building and Łódź", () => {
  const decision = evaluateFacebookApartmentSafety({ authoritativeText: "Na sprzedaż mieszkanie w wieżowcu, Łódź Widzew", property: { city: "Łódź" }, filter });
  assert.deepEqual({ passes: decision.passes, buildingType: decision.buildingType }, { passes: true, buildingType: "blok" });
});

test("rejects kamienica, house, plot, outside Łódź and unknown safety fields", () => {
  const cases = [
    ["Mieszkanie w kamienicy, Łódź", "FACEBOOK_BUILDING_KAMIENICA"],
    ["Na sprzedaż dom wolnostojący w Łodzi", "FACEBOOK_PROPERTY_HOUSE"],
    ["Na sprzedaż działka budowlana w Łodzi", "FACEBOOK_PROPERTY_PLOT"],
    ["Mieszkanie w bloku, Pabianice", "FACEBOOK_LOCATION_OUTSIDE_LODZ"],
    ["Na sprzedaż mieszkanie 45 m2", "FACEBOOK_BUILDING_TYPE_UNVERIFIED"],
  ] as const;
  for (const [text, reason] of cases) {
    const decision = evaluateFacebookApartmentSafety({ authoritativeText: text, property: { city: null }, filter });
    assert.equal(decision.passes, false, text);
    assert.ok(decision.reasons.includes(reason), `${text}: ${decision.reasons.join(",")}`);
  }
});
