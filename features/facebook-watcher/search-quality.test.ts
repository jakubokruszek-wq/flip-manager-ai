import assert from "node:assert/strict";
import test from "node:test";
import { resolveFacebookListingIntent } from "./facebook-intent.ts";
import {
  assessFacebookContentQuality,
  classifyFacebookAvailability,
  classifyFacebookDuplicate,
  classifyFacebookFreshness,
  classifyFacebookLocationState,
  classifyFacebookPropertyType,
  classifyFacebookSearchIntent,
  facebookSearchAcceptance,
  type FacebookDuplicateCheckCandidate,
  type FacebookDuplicateCheckTarget,
} from "./search-quality.ts";

function intentFor(text: string) {
  return resolveFacebookListingIntent(text, null, null);
}
function searchIntentFor(text: string) {
  return classifyFacebookSearchIntent(text, intentFor(text));
}

// --- A ---
test("A: 'Sprzedam M3 Łódź Dąbrowa 48m2 399 tys priv' resolves to APARTMENT_FOR_SALE", () => {
  assert.equal(searchIntentFor("Sprzedam M3 Łódź Dąbrowa 48m2 399 tys priv"), "APARTMENT_FOR_SALE");
});

// --- B ---
test("B: 'Wynajmę M3 Łódź, czynsz 2500 + 700' resolves to APARTMENT_FOR_RENT", () => {
  assert.equal(searchIntentFor("Wynajmę M3 Łódź, czynsz 2500 + 700"), "APARTMENT_FOR_RENT");
});

// --- C ---
test("C: 'Kupię mieszkanie Bałuty do 350 tys' resolves to WANTED_TO_BUY", () => {
  assert.equal(searchIntentFor("Kupię mieszkanie Bałuty do 350 tys"), "WANTED_TO_BUY");
});

// --- D ---
test("D: 'Sprzedam działkę Łódź' resolves to LAND_FOR_SALE", () => {
  assert.equal(searchIntentFor("Sprzedam działkę Łódź"), "LAND_FOR_SALE");
  assert.equal(classifyFacebookPropertyType("Sprzedam działkę Łódź"), "LAND");
});

// --- E ---
test("E: 'Pokój dla studentki Widzew' resolves to ROOM_FOR_RENT", () => {
  assert.equal(searchIntentFor("Pokój dla studentki Widzew, wynajmę"), "ROOM_FOR_RENT");
  assert.equal(classifyFacebookPropertyType("Pokój dla studentki Widzew"), "ROOM");
});
test("a room-count mention ('3 pokoje') never becomes a ROOM property type", () => {
  assert.equal(classifyFacebookPropertyType("Sprzedam mieszkanie 3 pokoje, 58 m2"), "APARTMENT");
  assert.equal(classifyFacebookPropertyType("Mieszkanie 2-pokojowe na sprzedaż"), "APARTMENT");
});

// --- F ---
test("F: 'Mieszkanie sprzedane, ogłoszenie nieaktualne' is marked SOLD, not deleted or reclassified as a live sale", () => {
  const text = "Mieszkanie sprzedane, ogłoszenie nieaktualne";
  assert.equal(classifyFacebookAvailability(text), "SOLD");
});
test("reserved and inactive are distinguished from sold", () => {
  assert.equal(classifyFacebookAvailability("Mieszkanie zarezerwowane"), "RESERVED");
  assert.equal(classifyFacebookAvailability("Aktualizacja: nieaktualne"), "INACTIVE");
  assert.equal(classifyFacebookAvailability("Sprzedam mieszkanie 45 m2"), "ACTIVE");
});

// --- G: messy private-sale post must not be falsely rejected ---
test("G: a messy informal private-sale post with apartment + price + area + location is not falsely rejected", () => {
  const text = "mieszkanko 45m2 sprzedam szybko okazja bałuty 320 tys dzwońcie";
  const decision = intentFor(text);
  const searchIntent = classifyFacebookSearchIntent(text, decision);
  assert.equal(searchIntent, "APARTMENT_FOR_SALE");
  const acceptance = facebookSearchAcceptance({ searchIntent, sourceValid: true, locationState: classifyFacebookLocationState({ city: "Łódź", district: "Bałuty", neighborhood: null }), availability: "ACTIVE" });
  assert.equal(acceptance, "CANDIDATE");
});

// --- H: cross-group duplicate ---
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

// --- I: admin fee never becomes asking price, sale is still a candidate ---
test("I: a sale post with a 666 zł admin fee is still an apartment-sale candidate", () => {
  const text = "Sprzedam mieszkanie 48 m², cena 399 000 zł. Czynsz administracyjny 666 zł.";
  assert.equal(searchIntentFor(text), "APARTMENT_FOR_SALE");
});

// --- J: ambiguous post -> NEEDS_REVIEW, never a fabricated classification ---
test("J: a genuinely ambiguous post resolves to UNKNOWN search intent and NEEDS_REVIEW acceptance", () => {
  const text = "Ciekawa sprawa w tej okolicy, zobaczcie sami";
  const searchIntent = searchIntentFor(text);
  assert.equal(searchIntent, "UNKNOWN");
  assert.equal(facebookSearchAcceptance({ searchIntent, sourceValid: true, locationState: "MISSING", availability: "ACTIVE" }), "NEEDS_REVIEW");
});

// --- Negation regression (mission section 15) ---
test("NEGATION: 'Sprzedam mieszkanie, nie do wynajęcia' is a sale, not a rental, despite containing the rent phrase", () => {
  const text = "Sprzedam mieszkanie 45 m2, nie do wynajęcia, tylko sprzedaż";
  assert.equal(intentFor(text).intent, "SELL_PROPERTY");
  assert.equal(searchIntentFor(text), "APARTMENT_FOR_SALE");
});

// --- House / commercial must not become an apartment-sale candidate ---
test("a house-for-sale post is classified HOUSE_FOR_SALE, not APARTMENT_FOR_SALE", () => {
  assert.equal(searchIntentFor("Sprzedam dom 180 m2 w Łodzi, duży ogród"), "HOUSE_FOR_SALE");
  assert.equal(classifyFacebookPropertyType("Sprzedam dom 180 m2"), "HOUSE");
});
test("'mieszkanie w domu' (an apartment inside a house/building) is not misread as a house-for-sale", () => {
  assert.equal(classifyFacebookPropertyType("Sprzedam mieszkanie w domu wielorodzinnym, 45 m2"), "APARTMENT");
});
test("commercial premises are classified separately from apartments", () => {
  assert.equal(classifyFacebookPropertyType("Sprzedam lokal użytkowy 80 m2 w centrum"), "COMMERCIAL");
});

// --- Freshness ---
test("freshness buckets are derived only from an actual timestamp", () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  assert.equal(classifyFacebookFreshness(new Date(now - 2 * 86_400_000).toISOString(), now), "FRESH");
  assert.equal(classifyFacebookFreshness(new Date(now - 20 * 86_400_000).toISOString(), now), "AGING");
  assert.equal(classifyFacebookFreshness(new Date(now - 90 * 86_400_000).toISOString(), now), "STALE");
  assert.equal(classifyFacebookFreshness(null, now), "UNKNOWN");
});

// --- Location state ---
test("location state distinguishes confirmed, likely, ambiguous, missing and out-of-scope", () => {
  assert.equal(classifyFacebookLocationState({ city: "Łódź", district: "Bałuty", neighborhood: null }), "CONFIRMED");
  assert.equal(classifyFacebookLocationState({ city: "Łódź", district: null, neighborhood: null }), "LIKELY");
  assert.equal(classifyFacebookLocationState({ city: "Łódź", district: null, neighborhood: null, conflict: true }), "AMBIGUOUS");
  assert.equal(classifyFacebookLocationState({ city: null, district: null, neighborhood: null }), "MISSING");
  assert.equal(classifyFacebookLocationState({ city: "Warszawa", district: "Mokotów", neighborhood: null, targetCity: "Łódź" }), "OUTSIDE_SCOPE");
});

// --- Content quality is data quality, not Flip Score ---
test("content quality reflects data completeness, not investment attractiveness", () => {
  const high = assessFacebookContentQuality({ searchIntent: "APARTMENT_FOR_SALE", propertyType: "APARTMENT", priceStatus: "VERIFIED", areaKnown: true, locationState: "CONFIRMED", freshness: "FRESH", availability: "ACTIVE" });
  assert.equal(high, "HIGH");
  const needsReview = assessFacebookContentQuality({ searchIntent: "APARTMENT_FOR_SALE", propertyType: "APARTMENT", priceStatus: "SUSPECT", areaKnown: true, locationState: "CONFIRMED", freshness: "FRESH", availability: "ACTIVE" });
  assert.equal(needsReview, "NEEDS_REVIEW");
  const soldNeedsReview = assessFacebookContentQuality({ searchIntent: "APARTMENT_FOR_SALE", propertyType: "APARTMENT", priceStatus: "VERIFIED", areaKnown: true, locationState: "CONFIRMED", freshness: "FRESH", availability: "SOLD" });
  assert.equal(soldNeedsReview, "NEEDS_REVIEW");
});

// --- Search acceptance gate never silently discards ---
test("search acceptance never returns a silent discard state — every ambiguous case is reviewable", () => {
  const outOfScope = facebookSearchAcceptance({ searchIntent: "HOUSE_FOR_SALE", sourceValid: true, locationState: "CONFIRMED", availability: "ACTIVE" });
  assert.equal(outOfScope, "OUT_OF_SCOPE");
  const inactive = facebookSearchAcceptance({ searchIntent: "APARTMENT_FOR_SALE", sourceValid: true, locationState: "CONFIRMED", availability: "SOLD" });
  assert.equal(inactive, "NEEDS_REVIEW");
});
