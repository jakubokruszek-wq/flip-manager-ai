import assert from "node:assert/strict";
import test from "node:test";
import type { SearchFilter } from "@/features/flip-finder";
import { evaluateFacebookApartmentSafety } from "./facebook-apartment-safety.ts";
import { resolveFacebookBuildingEvidence } from "./facebook-building-evidence.ts";

const filter = { id: "f", name: "Lodz bloki", sources: ["facebook"], city: "Lodz", districts: [], priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: ["blok", "apartamentowiec"], ownershipTypes: [], marketType: null, privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true, lastScannedAt: null, createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z" } satisfies SearchFilter;

test("accepts only positively verified allowed apartment building and Lodz", () => {
  const decision = evaluateFacebookApartmentSafety({ authoritativeText: "Na sprzedaz mieszkanie w wiezowcu, Lodz Widzew", property: { city: "Lodz" }, filter });
  assert.deepEqual({ passes: decision.passes, buildingType: decision.buildingType }, { passes: true, buildingType: "blok" });
});

test("rejects kamienica, house, plot, outside Lodz and unknown safety fields", () => {
  const cases = [
    ["Mieszkanie w kamienicy, Lodz", "FACEBOOK_BUILDING_KAMIENICA"],
    ["Na sprzedaz dom wolnostojacy w Lodzi", "FACEBOOK_PROPERTY_HOUSE"],
    ["Na sprzedaz dzialka budowlana w Lodzi", "FACEBOOK_PROPERTY_PLOT"],
    ["Mieszkanie w bloku, Pabianice", "FACEBOOK_LOCATION_OUTSIDE_LODZ"],
    ["Na sprzedaz mieszkanie 45 m2", "FACEBOOK_BUILDING_TYPE_UNVERIFIED"],
  ] as const;
  for (const [text, reason] of cases) {
    const decision = evaluateFacebookApartmentSafety({ authoritativeText: text, property: { city: null }, filter });
    assert.equal(decision.passes, false, text);
    assert.ok(decision.reasons.includes(reason), `${text}: ${decision.reasons.join(",")}`);
  }
});

test("confirms the exact Ogniskowa 8 address as a block without accepting unknown buildings", () => {
  const text = "2 pokoje | Ogniskowa 8, Lodz - Chojny | mieszkanie";
  const evidence = resolveFacebookBuildingEvidence(text, { city: "Lodz", street: "Ogniskowa 8" });
  assert.equal(evidence.addressMatched, true);
  assert.equal(evidence.status, "BLOCK_CONFIRMED");
  assert.equal(evidence.buildingType, "blok");
  assert.equal(evidence.buildingEvidenceConfidence, 0.97);
  const decision = evaluateFacebookApartmentSafety({ authoritativeText: text, property: { city: "Lodz" }, filter, buildingEvidence: evidence });
  assert.equal(decision.passes, true);
  assert.equal(decision.buildingType, "blok");
});

test("does not infer a block from an address that has no verified evidence", () => {
  const evidence = resolveFacebookBuildingEvidence("Mieszkanie, Radwanska 4, Lodz", { city: "Lodz", street: "Radwanska 4" });
  assert.equal(evidence.status, "UNVERIFIED");
  assert.equal(evidence.buildingType, null);
});
