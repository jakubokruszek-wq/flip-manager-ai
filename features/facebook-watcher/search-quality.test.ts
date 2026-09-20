import assert from "node:assert/strict";
import test from "node:test";
import { resolveFacebookListingIntent } from "./facebook-intent.ts";
import {
  assessFacebookContentQuality,
  classifyFacebookAvailability,
  classifyFacebookDuplicate,
  classifyFacebookFreshness,
  classifyFacebookLocationState,
  classifyFacebookMixedProperty,
  classifyFacebookPropertyType,
  classifyFacebookSearchDecision,
  classifyFacebookSearchIntent,
  type FacebookDuplicateCheckCandidate,
  type FacebookDuplicateCheckTarget,
} from "./search-quality.ts";
import { assessFacebookPriceQuality } from "./price-quality.ts";

function intentFor(text: string) {
  return resolveFacebookListingIntent(text, null, null);
}
function searchIntentFor(text: string) {
  return classifyFacebookSearchIntent(text, intentFor(text));
}
function decisionFor(text: string, overrides: Partial<Parameters<typeof classifyFacebookSearchDecision>[0]> = {}) {
  const searchIntent = searchIntentFor(text);
  const propertyType = classifyFacebookPropertyType(text);
  return classifyFacebookSearchDecision({
    searchIntent, propertyType, mixedProperty: classifyFacebookMixedProperty(text),
    sourceValid: true, locationState: classifyFacebookLocationState({ city: "Łódź", district: null, neighborhood: null }),
    availability: classifyFacebookAvailability(text),
    ...overrides,
  });
}

// -----------------------------------------------------------------------------
// Original A–J fixtures (search intent / property type basics)
// -----------------------------------------------------------------------------
test("A: 'Sprzedam M3 Łódź Dąbrowa 48m2 399 tys priv' resolves to APARTMENT_FOR_SALE", () => {
  assert.equal(searchIntentFor("Sprzedam M3 Łódź Dąbrowa 48m2 399 tys priv"), "APARTMENT_FOR_SALE");
});
test("B: 'Wynajmę M3 Łódź, czynsz 2500 + 700' resolves to APARTMENT_FOR_RENT", () => {
  assert.equal(searchIntentFor("Wynajmę M3 Łódź, czynsz 2500 + 700"), "APARTMENT_FOR_RENT");
});
test("C: 'Kupię mieszkanie Bałuty do 350 tys' resolves to WANTED_TO_BUY", () => {
  assert.equal(searchIntentFor("Kupię mieszkanie Bałuty do 350 tys"), "WANTED_TO_BUY");
});
test("D: 'Sprzedam działkę Łódź' resolves to LAND_FOR_SALE", () => {
  assert.equal(searchIntentFor("Sprzedam działkę Łódź"), "LAND_FOR_SALE");
  assert.equal(classifyFacebookPropertyType("Sprzedam działkę Łódź"), "LAND");
});
test("E: 'Pokój dla studentki Widzew' resolves to ROOM_FOR_RENT", () => {
  assert.equal(searchIntentFor("Pokój dla studentki Widzew, wynajmę"), "ROOM_FOR_RENT");
  assert.equal(classifyFacebookPropertyType("Pokój dla studentki Widzew"), "ROOM");
});
test("a room-count mention ('3 pokoje') never becomes a ROOM property type", () => {
  assert.equal(classifyFacebookPropertyType("Sprzedam mieszkanie 3 pokoje, 58 m2"), "APARTMENT");
  assert.equal(classifyFacebookPropertyType("Mieszkanie 2-pokojowe na sprzedaż"), "APARTMENT");
});
test("F: 'Mieszkanie sprzedane, ogłoszenie nieaktualne' is marked SOLD, not deleted or reclassified as a live sale", () => {
  assert.equal(classifyFacebookAvailability("Mieszkanie sprzedane, ogłoszenie nieaktualne"), "SOLD");
});
test("reserved and inactive are distinguished from sold", () => {
  assert.equal(classifyFacebookAvailability("Mieszkanie zarezerwowane"), "RESERVED");
  assert.equal(classifyFacebookAvailability("Aktualizacja: nieaktualne"), "INACTIVE");
  assert.equal(classifyFacebookAvailability("Sprzedam mieszkanie 45 m2"), "ACTIVE");
});

test("automated source policy classifies every non-apartment or unavailable post as a hard reject", () => {
  for (const [text, propertyType] of [
    ["Sprzedam dom w Łodzi", "HOUSE"],
    ["Sprzedam działkę budowlaną", "LAND"],
    ["Sprzedam lokal użytkowy", "COMMERCIAL"],
    ["Sprzedam garaż", "GARAGE"],
    ["Sprzedam pokój", "ROOM"],
  ] as const) {
    assert.equal(classifyFacebookPropertyType(text), propertyType, text);
    assert.notEqual(classifyFacebookSearchDecision({
      searchIntent: "APARTMENT_FOR_SALE", propertyType, mixedProperty: false,
      sourceValid: true, locationState: "CONFIRMED", availability: "ACTIVE",
    }), "NORMAL_CANDIDATE", text);
  }
  for (const availability of ["SOLD", "RESERVED", "INACTIVE"] as const) {
    assert.notEqual(classifyFacebookSearchDecision({
      searchIntent: "APARTMENT_FOR_SALE", propertyType: "APARTMENT", mixedProperty: false,
      sourceValid: true, locationState: "CONFIRMED", availability,
    }), "NORMAL_CANDIDATE", availability);
  }
});
test("G: a messy informal private-sale post with apartment + price + area + location is not falsely rejected", () => {
  const text = "mieszkanko 45m2 sprzedam szybko okazja bałuty 320 tys dzwońcie";
  assert.equal(searchIntentFor(text), "APARTMENT_FOR_SALE");
  assert.equal(decisionFor(text, { locationState: classifyFacebookLocationState({ city: "Łódź", district: "Bałuty", neighborhood: null }) }), "NORMAL_CANDIDATE");
});
test("H: the same apartment posted in two groups is detected as a likely duplicate, not merged destructively", () => {
  const target: FacebookDuplicateCheckTarget = { normalizedUrl: "https://facebook.com/groups/a/posts/1", externalId: "1", price: 399_000, area: 48, neighborhood: null, district: "Bałuty", street: "Zgierska 10" };
  const candidateSameApartmentOtherGroup: FacebookDuplicateCheckCandidate = { normalizedUrl: "https://facebook.com/groups/b/posts/2", externalId: "2", price: 399_000, area: 48, district: "Bałuty", address: "Zgierska 10" };
  const isLikelySame = (t: FacebookDuplicateCheckTarget, c: FacebookDuplicateCheckCandidate) => Math.abs(c.price! - t.price!) / t.price! <= 0.03 && Math.abs(c.area! - t.area!) <= 2 && c.district === t.district;
  assert.equal(classifyFacebookDuplicate(target, candidateSameApartmentOtherGroup, isLikelySame), "LIKELY_DUPLICATE");
  const exactRepost = { ...candidateSameApartmentOtherGroup, normalizedUrl: target.normalizedUrl, externalId: target.externalId };
  assert.equal(classifyFacebookDuplicate(target, exactRepost, isLikelySame), "EXACT_DUPLICATE");
  const unrelated = { normalizedUrl: "https://facebook.com/groups/c/posts/3", externalId: "3", price: 250_000, area: 30, district: "Widzew", address: "Inna 1" };
  assert.equal(classifyFacebookDuplicate(target, unrelated, isLikelySame), "UNIQUE");
});
test("I: a sale post with a 666 zł admin fee is still an apartment-sale candidate", () => {
  assert.equal(searchIntentFor("Sprzedam mieszkanie 48 m², cena 399 000 zł. Czynsz administracyjny 666 zł."), "APARTMENT_FOR_SALE");
});
test("J: a genuinely ambiguous post resolves to UNKNOWN search intent and NEEDS_REVIEW", () => {
  const text = "Ciekawa sprawa w tej okolicy, zobaczcie sami";
  assert.equal(searchIntentFor(text), "UNKNOWN");
  assert.equal(decisionFor(text, { locationState: "MISSING" }), "NEEDS_REVIEW");
});

test("NEGATION: 'Sprzedam mieszkanie, nie do wynajęcia' is a sale, not a rental, despite containing the rent phrase", () => {
  const text = "Sprzedam mieszkanie 45 m2, nie do wynajęcia, tylko sprzedaż";
  assert.equal(intentFor(text).intent, "SELL_PROPERTY");
  assert.equal(searchIntentFor(text), "APARTMENT_FOR_SALE");
});
test("'mieszkanie w domu' (an apartment inside a house/building) is not misread as a house-for-sale", () => {
  assert.equal(classifyFacebookPropertyType("Sprzedam mieszkanie w domu wielorodzinnym, 45 m2"), "APARTMENT");
});
test("commercial premises are classified separately from apartments", () => {
  assert.equal(classifyFacebookPropertyType("Sprzedam lokal użytkowy 80 m2 w centrum"), "COMMERCIAL");
});
test("freshness buckets are derived only from an actual timestamp", () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  assert.equal(classifyFacebookFreshness(new Date(now - 2 * 86_400_000).toISOString(), now), "FRESH");
  assert.equal(classifyFacebookFreshness(new Date(now - 20 * 86_400_000).toISOString(), now), "AGING");
  assert.equal(classifyFacebookFreshness(new Date(now - 90 * 86_400_000).toISOString(), now), "STALE");
  assert.equal(classifyFacebookFreshness(null, now), "UNKNOWN");
});
test("location state distinguishes confirmed, likely, ambiguous, missing and out-of-scope", () => {
  assert.equal(classifyFacebookLocationState({ city: "Łódź", district: "Bałuty", neighborhood: null }), "CONFIRMED");
  assert.equal(classifyFacebookLocationState({ city: "Łódź", district: null, neighborhood: null }), "LIKELY");
  assert.equal(classifyFacebookLocationState({ city: "Łódź", district: null, neighborhood: null, conflict: true }), "AMBIGUOUS");
  assert.equal(classifyFacebookLocationState({ city: null, district: null, neighborhood: null }), "MISSING");
  assert.equal(classifyFacebookLocationState({ city: "Warszawa", district: "Mokotów", neighborhood: null, targetCity: "Łódź" }), "OUTSIDE_SCOPE");
});
test("content quality reflects data completeness, not investment attractiveness", () => {
  assert.equal(assessFacebookContentQuality({ searchIntent: "APARTMENT_FOR_SALE", propertyType: "APARTMENT", priceStatus: "VERIFIED", areaKnown: true, locationState: "CONFIRMED", freshness: "FRESH", availability: "ACTIVE" }), "HIGH");
  assert.equal(assessFacebookContentQuality({ searchIntent: "APARTMENT_FOR_SALE", propertyType: "APARTMENT", priceStatus: "SUSPECT", areaKnown: true, locationState: "CONFIRMED", freshness: "FRESH", availability: "ACTIVE" }), "NEEDS_REVIEW");
  assert.equal(assessFacebookContentQuality({ searchIntent: "APARTMENT_FOR_SALE", propertyType: "APARTMENT", priceStatus: "VERIFIED", areaKnown: true, locationState: "CONFIRMED", freshness: "FRESH", availability: "SOLD" }), "NEEDS_REVIEW");
});

// -----------------------------------------------------------------------------
// Final closure fixtures (this mission's own A–J, apartment-only gate)
// -----------------------------------------------------------------------------
test("CLOSURE A: 399 000 zł + czynsz 666 zł -> apartment candidate, asking 399000", () => {
  const text = "Sprzedam mieszkanie 48 m², cena 399 000 zł. Czynsz 666 zł.";
  assert.equal(searchIntentFor(text), "APARTMENT_FOR_SALE");
  const quality = assessFacebookPriceQuality({ price: 399_000, area: 48, postText: text });
  assert.equal(quality.status, "VERIFIED");
  assert.equal(decisionFor(text), "NORMAL_CANDIDATE");
});
test("CLOSURE B: '666 zł' only -> suspect/missing price, no false bargain score", () => {
  const quality = assessFacebookPriceQuality({ price: 666, area: 45 });
  assert.equal(quality.status, "SUSPECT");
});
test("CLOSURE C: 'Sprzedam dom' is excluded from normal apartment candidates", () => {
  assert.equal(decisionFor("Sprzedam dom 180 m2 w Łodzi, duży ogród"), "REJECT_NON_APARTMENT");
});
test("CLOSURE D: 'Pokój do wynajęcia' is excluded", () => {
  assert.equal(decisionFor("Pokój do wynajęcia, Widzew, dla studentki"), "REJECT_NON_APARTMENT");
});
test("CLOSURE E: 'Garaż na sprzedaż' is excluded", () => {
  assert.equal(classifyFacebookPropertyType("Garaż na sprzedaż, os. Retkinia"), "GARAGE");
  assert.equal(decisionFor("Garaż na sprzedaż, os. Retkinia"), "REJECT_NON_APARTMENT");
});
test("CLOSURE F: '3-pokojowe mieszkanie' is APARTMENT, not ROOM", () => {
  const text = "Sprzedam 3-pokojowe mieszkanie, 62 m2, Górna";
  assert.equal(classifyFacebookPropertyType(text), "APARTMENT");
  assert.equal(decisionFor(text), "NORMAL_CANDIDATE");
});
test("CLOSURE G: 'Mieszkanie w domu wielorodzinnym' is APARTMENT when context supports it", () => {
  const text = "Sprzedam mieszkanie w domu wielorodzinnym, 45 m2, Bałuty";
  assert.equal(classifyFacebookPropertyType(text), "APARTMENT");
  assert.equal(decisionFor(text), "NORMAL_CANDIDATE");
});
test("CLOSURE H: mixed residential/commercial is NEEDS_REVIEW unless apartment is clearly primary", () => {
  assert.equal(classifyFacebookMixedProperty("Sprzedam budynek mieszkalno-usługowy w centrum Łodzi"), true);
  assert.equal(decisionFor("Sprzedam budynek mieszkalno-usługowy w centrum Łodzi, 45 m2 mieszkanie"), "NEEDS_REVIEW");
  assert.equal(classifyFacebookMixedProperty("Sprzedam pakiet mieszkań, 5 lokali"), true);
});
test("CLOSURE I: unknown property type is NEEDS_REVIEW, not silently rejected", () => {
  const text = "Sprzedam, super okazja, piszcie w wiadomości";
  const decision = decisionFor(text);
  assert.notEqual(decision, "REJECT_NON_APARTMENT");
  assert.equal(decision, "NEEDS_REVIEW");
});
