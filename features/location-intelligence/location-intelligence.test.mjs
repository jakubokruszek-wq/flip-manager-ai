import assert from "node:assert/strict";
import test from "node:test";

import { compareResolvedLocations, resolveDeterministicLocation } from "./deterministic-location.ts";
import { clearLocationCache } from "./location-cache.ts";
import { resolveLocation } from "./resolve-location.ts";

const input = (street, district = "Bałuty") => ({
  address: street ? `${street} 23, Łódź` : null,
  street,
  district,
  city: "Łódź",
  locationText: street ? `${street} 23, Łódź` : "Łódź",
  title: null,
  description: null,
});

test("Rojna jest rozpoznawana jako Teofilów, Bałuty", () => {
  const result = resolveDeterministicLocation(input("Rojna"));
  assert.equal(result.street, "Rojna");
  assert.equal(result.neighborhood, "Teofilów");
  assert.equal(result.district, "Bałuty");
  assert.equal(result.confidence, 0.98);
});

test("inna ulica w Teofilowie: street false, neighborhood true", () => {
  const rojana = resolveDeterministicLocation(input("Rojna"));
  const other = { ...rojana, street: "Aleksandrowska" };
  assert.deepEqual(compareResolvedLocations(rojana, other), {
    streetMatch: false, neighborhoodMatch: true, districtMatch: true, cityMatch: true,
  });
});

test("Teofilów i Radogoszcz: neighborhood false, district true", () => {
  const teofilow = resolveDeterministicLocation(input("Rojna"));
  const radogoszcz = { ...teofilow, street: "Zgierska", neighborhood: "Radogoszcz" };
  const match = compareResolvedLocations(teofilow, radogoszcz);
  assert.equal(match.neighborhoodMatch, false);
  assert.equal(match.districtMatch, true);
});

test("nieznana ulica uruchamia AI fallback i korzysta z cache", async () => {
  clearLocationCache();
  let calls = 0;
  const aiResolver = async () => {
    calls += 1;
    return { street: "Testowa", neighborhood: "Teofilów", district: "Bałuty", city: "Łódź", confidence: 0.91, evidence: "Testowa" };
  };
  const first = await resolveLocation(input("Testowa"), { aiResolver });
  const second = await resolveLocation(input("Testowa"), { aiResolver });
  assert.equal(first.neighborhood, "Teofilów");
  assert.equal(second.neighborhood, "Teofilów");
  assert.equal(calls, 1);
});

test("niska pewność AI zeruje neighborhood", async () => {
  clearLocationCache();
  const result = await resolveLocation(input("Nieznana"), {
    aiResolver: async () => ({ street: "Nieznana", neighborhood: "Teofilów", district: "Bałuty", city: "Łódź", confidence: 0.7, evidence: "Nieznana" }),
  });
  assert.equal(result.neighborhood, null);
});

test("AI nie zmienia pewnego miasta ani danych źródłowych", async () => {
  clearLocationCache();
  const result = await resolveLocation(input("Testowa"), {
    aiResolver: async () => ({ street: "Zmyślona", neighborhood: "Centrum", district: "Śródmieście", city: "Warszawa", confidence: 0.99, evidence: "Testowa" }),
  });
  assert.equal(result.street, "Testowa");
  assert.equal(result.city, "Łódź");
  assert.equal(result.district, "Bałuty");
  assert.equal(result.neighborhood, null);
});

test("jawne osiedle w opisie ma pierwszeństwo", () => {
  const result = resolveDeterministicLocation({
    ...input(null),
    description: "Mieszkanie zlokalizowane na spokojnym, rodzinnym osiedlu Radogoszcz Zachód.",
  });
  assert.equal(result.neighborhood, "Radogoszcz Zachód");
  assert.equal(result.district, "Bałuty");
  assert.equal(result.city, "Łódź");
  assert.equal(result.evidence, "Radogoszcz Zachód");
});

test("Radogoszcz Zachód nie pasuje do Wschodu ani Teofilowa", () => {
  const zachod = { ...resolveDeterministicLocation(input("Rojna")), neighborhood: "Radogoszcz Zachód" };
  const wschod = { ...zachod, neighborhood: "Radogoszcz Wschód" };
  const teofilow = { ...zachod, neighborhood: "Teofilów" };
  assert.equal(compareResolvedLocations(zachod, wschod).neighborhoodMatch, false);
  assert.equal(compareResolvedLocations(zachod, teofilow).neighborhoodMatch, false);
});
