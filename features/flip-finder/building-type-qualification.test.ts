import assert from "node:assert/strict";
import test from "node:test";
import { qualifyBuildingType } from "./building-type-qualification.ts";
import { evaluateListingAgainstFilter } from "./filter-evaluation.ts";
import type { SearchFilter } from "./index.ts";

const ALLOWED = ["blok", "apartamentowiec"];
const q = (structuredValue: unknown, title: string | null, description: string | null, operatorConfirmedType: string | null = null) =>
  qualifyBuildingType({ structuredValue, title, description, operatorConfirmedType }, ALLOWED);

test("confirmed tenements, houses and other disallowed types are rejected from structured data or the listing's own text", () => {
  assert.equal(q("kamienica", "Mieszkanie", null).status, "rejected");
  assert.equal(q("tenement", "Mieszkanie", null).status, "rejected");
  assert.equal(q(null, "Mieszkanie w kamienicy po remoncie", null).status, "rejected");
  assert.equal(q("dom wolnostojacy", "Mieszkanie", null).status, "rejected");
  assert.equal(q("szeregowiec", null, null).status, "rejected");
  assert.equal(q("loft", null, null).status, "rejected");
  assert.equal(q("infill", null, null).reason, "building_type");
});

test("a description contradicting a structured block with an affirmative tenement statement is rejected, not guessed", () => {
  const result = q("blok", "Mieszkanie", "Lokal znajduje się w kamienicy z 1905 roku.");
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "building_type_conflict");
});

test("a neighbouring tenement is never evidence: 'obok kamienicy', 'wśród kamienic', 'przy starej kamienicy'", () => {
  assert.deepEqual([q("blok", "Mieszkanie w bloku", "Obok kamienica z 1900 r.").status, q("blok", "Mieszkanie w bloku obok kamienicy", null).status], ["confirmed", "confirmed"]);
  assert.equal(q("apartamentowiec", "Mieszkanie w apartamentowcu wśród zabytkowych kamienic", null).status, "confirmed");
  assert.equal(q(null, "Mieszkanie w bloku", "Lokal przy starej kamienicy, blisko parku").type, "blok");
  assert.equal(q(null, "Mieszkanie w bloku przy ul. Kamienica 4", null).status, "confirmed", "a street name is not a building type");
});

test("plural area-level tenement mentions ask the operator to verify a structured-only block instead of trusting it blindly", () => {
  const result = q("blok", "2 pokoje, Śródmieście", "Klimatyczna okolica pełna kamienic, blisko Piotrkowskiej.");
  assert.equal(result.status, "needs_verification");
  assert.equal(result.reason, "building_type_ambiguous_tenement_mention");
  assert.equal(q("blok", "Mieszkanie w bloku", "Okolica pełna kamienic").status, "confirmed", "an affirmative statement in the listing's own text settles it");
  assert.equal(q(null, "Mieszkanie w jednej z kamienic przy Piotrkowskiej", null).status, "rejected", "'w jednej z kamienic' locates the unit");
});

test("unknown building types are never guessed from street, year, floor or ceiling height", () => {
  for (const description of [
    "Piotrkowska 120, rok budowy 1910",
    "3 piętro, wysokość pomieszczeń 3,4 m",
    "Ul. Gdańska, przedwojenny budynek",
    "Nowoczesny budynek, nowa inwestycja",
  ]) {
    const result = q(null, "Mieszkanie 2 pokoje", description);
    assert.equal(result.status, "needs_verification", description);
    assert.equal(result.type, null, description);
  }
});

test("allowed types are recognised in every declension, including 'w apartamentowcu' and 'wieżowiec'", () => {
  assert.equal(q(null, "Mieszkanie w apartamentowcu z windą", null).type, "apartamentowiec");
  assert.equal(q("apartment", null, null).type, "apartamentowiec");
  assert.equal(q(null, "Mieszkanie w wieżowcu", null).type, "blok");
  assert.equal(q(null, "Blokada drzwi antywłamaniowych", null).status, "needs_verification", "'blokada' is not a block");
  assert.equal(q("blok", "Mieszkanie w apartamentowcu", null).status, "confirmed", "two allowed categories still prove an allowed building");
});

test("an operator confirmation wins over source data and text, in both directions", () => {
  assert.equal(q(null, "Mieszkanie", null, "blok").status, "confirmed");
  assert.equal(q(null, "Mieszkanie", null, "blok").reason, "building_type_confirmed_operator");
  assert.equal(q("blok", "Mieszkanie w kamienicy", null, "blok").status, "confirmed");
  assert.equal(q("blok", "Mieszkanie w bloku", null, "kamienica").status, "rejected");
});

test("the shared filter evaluation routes unknown building types to REVIEW (verification queue) and rejects tenements", () => {
  const filter = {
    id: "f", name: "Flip", sources: ["otodom"], city: "Łódź", districts: [], priceMin: null, priceMax: null, areaMin: 31, areaMax: 75,
    rooms: [1, 2, 3, 4], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: ["blok", "apartamentowiec"],
    ownershipTypes: [], marketType: null, privateOnly: false, maxPricePerSqm: 6500, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
    minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true, lastScannedAt: null, createdAt: "", updatedAt: "",
  } as unknown as SearchFilter;
  const base = { price: 269000, area: 47.19, pricePerSqm: null, rooms: 2, floor: "2", city: "Łódź", district: "Śródmieście", title: "2 pokoje", description: null, locationText: null, buildingType: null };
  const unknown = evaluateListingAgainstFilter(base, filter);
  assert.equal(unknown.bucket, "REVIEW");
  assert.deepEqual(unknown.unknownFields, ["buildingType"]);
  assert.equal(evaluateListingAgainstFilter({ ...base, buildingType: "kamienica" }, filter).bucket, "REJECTED");
  assert.equal(evaluateListingAgainstFilter({ ...base, buildingType: null, buildingTypeConfirmedByOperator: "blok" }, filter).bucket, "MATCHED");
  assert.equal(evaluateListingAgainstFilter({ ...base, buildingType: "blok" }, filter).bucket, "MATCHED");
});
