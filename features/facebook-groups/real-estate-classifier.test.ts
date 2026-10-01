import assert from "node:assert/strict";
import test from "node:test";
import { isLodzRelatedGroupName, isOtherCityGroupName, isRealEstateGroupName } from "./real-estate-classifier.ts";

const POSITIVE_NAMES = [
  "Nieruchomości Łódź",
  "Mieszkania na sprzedaż",
  "Domy Łódź i okolice",
  "Lokale użytkowe Łódź",
  "Sprzedaż mieszkań Łódź",
  "Wynajem mieszkań Łódź",
  "Kupno/sprzedaż nieruchomości",
  "Działki budowlane Łódź",
  "Grunty rolne i inwestycyjne",
  "Łódź - mieszkania i domy",
  "Flipy nieruchomości Polska",
  "Flipperzy - grupa wsparcia",
  "Inwestorzy nieruchomości Łódź",
  "Deweloper - nowe inwestycje",
  "KAWALERKI ŁÓDŹ WYNAJEM",
  "Apartamenty premium",
];

const NEGATIVE_NAMES = [
  "Biznes Łódź",
  "Inwestycje giełdowe",
  "Łódź",
  "Łódzianie razem",
  "Gotowanie i przepisy",
  "Sprzedam telefon",
  "Motoryzacja Łódź",
  "Praca Łódź ogłoszenia",
];

test("every mission-listed real-estate phrase (with Polish diacritics) is recognized", () => {
  for (const name of POSITIVE_NAMES) {
    assert.equal(isRealEstateGroupName(name), true, `expected "${name}" to be classified as real estate`);
  }
});

test("weak/insufficient-alone terms never classify a group as real estate by themselves", () => {
  for (const name of NEGATIVE_NAMES) {
    assert.equal(isRealEstateGroupName(name), false, `expected "${name}" to NOT be classified as real estate`);
  }
});

test("case-insensitive and diacritic-insensitive: ASCII-folded and upper/lower variants match identically", () => {
  assert.equal(isRealEstateGroupName("nieruchomosci lodz"), true);
  assert.equal(isRealEstateGroupName("NIERUCHOMOŚCI ŁÓDŹ"), true);
  assert.equal(isRealEstateGroupName("NieRuchoMOŚci ŁÓDź"), true);
});

test("inflected Polish forms are recognized via prefix matching, not just the exact dictionary form", () => {
  assert.equal(isRealEstateGroupName("Mieszkaniowe wsparcie dla najemców"), true, "mieszkaniowe");
  assert.equal(isRealEstateGroupName("Nieruchomościowy klub inwestora"), true, "nieruchomościowy");
  assert.equal(isRealEstateGroupName("Deweloperzy i budowniczowie"), true, "deweloperzy");
});

test("null, undefined and empty/whitespace-only names are never classified as real estate", () => {
  assert.equal(isRealEstateGroupName(null), false);
  assert.equal(isRealEstateGroupName(undefined), false);
  assert.equal(isRealEstateGroupName(""), false);
  assert.equal(isRealEstateGroupName("   "), false);
});

test("a bare city name combined with a real property noun IS sufficient (the noun alone already qualifies)", () => {
  assert.equal(isRealEstateGroupName("Łódź nieruchomości"), true);
  assert.equal(isRealEstateGroupName("Łódź mieszkania"), true);
});

// "Inwestorzy" (investors, a role) is independently sufficient even with no
// other real-estate noun present -- unlike "inwestycje" (investments, a
// generic business term) in NEGATIVE_NAMES above, which stays insufficient
// on its own since it names no specific domain at all.
test("'inwestorzy' alone (no other real-estate noun) is independently sufficient, distinct from the weak 'inwestycje'", () => {
  assert.equal(isRealEstateGroupName("Inwestorzy Łódź"), true);
  assert.equal(isRealEstateGroupName("Grupa Inwestorów"), true);
  assert.equal(isRealEstateGroupName("Inwestycje giełdowe"), false, "the generic business term 'inwestycje' must remain insufficient alone");
});

test("isLodzRelatedGroupName recognizes the bare city, its districts, and the 'łódzki/łódzkie' adjective family", () => {
  assert.equal(isLodzRelatedGroupName("Nieruchomości Łódź"), true, "bare city name");
  assert.equal(isLodzRelatedGroupName("Nieruchomości Łódzkie"), true, "voivodeship-style adjective, mission's own example");
  assert.equal(isLodzRelatedGroupName("Mieszkania Łódzkie na sprzedaż"), true, "adjective inflected for gender/case");
  assert.equal(isLodzRelatedGroupName("Mieszkania Bałuty"), true, "a named Łódź district, via the shared LODZ_CONTEXT list");
  assert.equal(isLodzRelatedGroupName("NIERUCHOMOŚCI ŁÓDŹ"), true, "case-insensitive");
  assert.equal(isLodzRelatedGroupName(null), false);
  assert.equal(isLodzRelatedGroupName(""), false);
});

test("isLodzRelatedGroupName never matches an unrelated word that merely starts with the same letters", () => {
  assert.equal(isLodzRelatedGroupName("Lodziarnia Mania Łódź"), true, "the group DOES also name Łódź explicitly here, so this must still be true");
  assert.equal(isLodzRelatedGroupName("Najlepsze lodziarnie w Polsce"), false, "'lodziarnie' (ice cream parlours) alone, with no actual city name, must never match");
});

test("isOtherCityGroupName confidently recognizes a different, real Polish city and is false for Łódź itself", () => {
  assert.equal(isOtherCityGroupName("Nieruchomości Warszawa"), true);
  assert.equal(isOtherCityGroupName("Mieszkania Kraków - sprzedaż i wynajem"), true);
  assert.equal(isOtherCityGroupName("Nieruchomości Łódź"), false, "Łódź itself must never be treated as 'another city'");
  assert.equal(isOtherCityGroupName("Nieruchomości Łódzkie"), false, "the łódzkie adjective must never be misread as another city either");
  assert.equal(isOtherCityGroupName("Nieruchomości"), false, "no city named at all is ambiguous, not confidently 'another city'");
  assert.equal(isOtherCityGroupName(null), false);
});
